/**
 * Buys and sales of the ad section.
 *
 * A buy is tied to a tracking link the moment it is created — an invite link
 * of a fresh campaign for a channel project, a UTM deep link for a bot-only
 * one — so its subscribers, buyers and revenue come from the same `events` as
 * the rest of the dashboard. Nothing about results is stored on the buy.
 *
 * Everything the dashboard shows is computed in the browser from the flat rows
 * listDeals() returns (one row per buy, one row per channel of a sale), with
 * the same formulas the mockup used — so a KPI, a table footer and a matrix
 * cell can never disagree. The server only decides what counts as money owed
 * when a settlement is recorded (see adSettlements.ts), using amountOf* below.
 */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  adBuys,
  adSalePlaces,
  adSales,
  adSettlementItems,
  adStatusHistory,
  campaigns,
  events,
  links,
  projects,
  utmLinks,
} from "../db/schema.js";
import {
  AD_CPM_STATES,
  AD_PUBLISHED_STATUSES,
  AD_SLOT_TIME,
  DEFAULT_MANDATORY_SLOTS,
  isAdFormat,
  isAdPriceMode,
  isAdSlot,
  isAdStatus,
  type AdCpmState,
  type AdDealKind,
  type AdSlot,
  type AdStatus,
} from "../db/adTypes.js";
import { EVENT_TYPES, FUNNEL_ENTRY_TYPES } from "../db/eventTypes.js";
import { hasBot, hasChannel } from "../db/projectTypes.js";
import { AdInputError, contactLabel, getContact } from "./adContacts.js";
import {
  createCampaign,
  createLinkForCampaign,
  deleteCampaignCascade,
  getCampaignById,
  normalizeInviteRef,
  reassignLinkCampaign,
  resolveLinkByTelegramRef,
  softDeleteCampaign,
  upsertCampaignTag,
  UNASSIGNED_ADVERTISER,
} from "./campaigns.js";
import { buildDeepLink, createUtmLink, getUtmLinkBySlug } from "./utm.js";

type Buy = typeof adBuys.$inferSelect;
type Sale = typeof adSales.$inferSelect;
type Place = typeof adSalePlaces.$inferSelect;
type Project = typeof projects.$inferSelect;

/** Mints a channel invite link — injected so this module does not import the bot. */
export type InviteMinter = (
  channelId: string,
  campaignId: number,
  name: string
) => Promise<{ inviteLink: string }>;

// --- input parsing ---------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(v: unknown): string {
  const s = String(v ?? "");
  if (!DATE_RE.test(s)) throw new AdInputError("Дата — в виде ГГГГ-ММ-ДД");
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new AdInputError(`Нет такой даты: ${s}`);
  }
  return s;
}

function parseSlot(v: unknown): AdSlot {
  if (!isAdSlot(v)) throw new AdInputError(`Неизвестное место: ${String(v)}`);
  return v;
}

function parseStatus(v: unknown): AdStatus {
  if (!isAdStatus(v)) throw new AdInputError(`Неизвестный статус: ${String(v)}`);
  return v;
}

function parseFormat(v: unknown) {
  if (!isAdFormat(v)) throw new AdInputError(`Неизвестный формат: ${String(v)}`);
  return v;
}

function parsePriceMode(v: unknown) {
  if (!isAdPriceMode(v)) throw new AdInputError(`Цена — fix или cpm, а не ${String(v)}`);
  return v;
}

function parseMoney(v: unknown, label: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new AdInputError(`${label}: нужно неотрицательное число`);
  if (n > 100_000_000) throw new AdInputError(`${label}: слишком большая сумма`);
  return Math.round(n * 100) / 100;
}

function parseViews(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new AdInputError("Просмотры — целое неотрицательное число");
  return n;
}

function parseCpmState(v: unknown): AdCpmState | null {
  if (v === undefined || v === null || v === "") return null;
  if (!(AD_CPM_STATES as readonly unknown[]).includes(v)) throw new AdInputError(`Неизвестное состояние CPM: ${String(v)}`);
  return v as AdCpmState;
}

function parseText(v: unknown, max: number, label: string): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw new AdInputError(`${label}: не длиннее ${max} символов`);
  return s;
}

function parseUrl(v: unknown, label: string): string | null {
  const s = parseText(v, 500, label);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
  } catch {
    throw new AdInputError(`${label}: нужна ссылка вида https://…`);
  }
  return s;
}

function parseId(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AdInputError(`Не указан ${label}`);
  return n;
}

/** `{ field: undefined }` means "leave it"; this reads only the fields that were sent. */
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// --- money -----------------------------------------------------------------

/** What a buy costs, or null while a CPM price still waits for its views. */
export function amountOfBuy(b: Pick<Buy, "priceMode" | "price" | "cpmRate" | "views" | "cpmState">): number | null {
  if (b.priceMode === "fix") return b.price ?? null;
  if ((b.cpmState === "fixed" || b.cpmState === "failed") && b.views != null && b.cpmRate != null) {
    return Math.round((b.cpmRate * b.views) / 1000);
  }
  return null;
}

/** One channel's part of a sale. */
export function amountOfPlace(s: Pick<Sale, "priceMode" | "cpmRate">, p: Pick<Place, "share" | "views" | "cpmState">): number | null {
  if (s.priceMode === "fix") return p.share ?? null;
  if ((p.cpmState === "fixed" || p.cpmState === "failed") && p.views != null && s.cpmRate != null) {
    return Math.round((s.cpmRate * p.views) / 1000);
  }
  return null;
}

/** A whole sale package: known only once every channel's part is. */
export function amountOfSale(s: Sale, places: Place[]): number | null {
  const parts = places.map((p) => amountOfPlace(s, p));
  return parts.some((v) => v == null) ? null : (parts as number[]).reduce((a, b) => a + b, 0);
}

/** Even split, remainder on the first channel — the same rule as the form's «Поровну». */
export function evenSplit(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => base + (i === 0 ? Math.round((total - base * count) * 100) / 100 : 0));
}

// --- projects --------------------------------------------------------------

export function mandatorySlotsOf(p: Pick<Project, "mandatorySlots">): AdSlot[] {
  if (!p.mandatorySlots) return [...DEFAULT_MANDATORY_SLOTS];
  try {
    const arr = JSON.parse(p.mandatorySlots);
    if (Array.isArray(arr)) return arr.filter(isAdSlot);
  } catch {
    // fall through to the default — a broken value must not take the grid down
  }
  return [...DEFAULT_MANDATORY_SLOTS];
}

export async function listAdProjects() {
  const rows = await db.select().from(projects).orderBy(projects.id);
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    channel: hasChannel(p),
    bot: hasBot(p),
    botUsername: p.botUsername,
    mandatorySlots: hasChannel(p) ? mandatorySlotsOf(p) : [],
  }));
}

export async function setMandatorySlots(projectId: number, raw: unknown) {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new AdInputError("Проект не найден", 404);
  if (!hasChannel(project)) throw new AdInputError("У проекта нет канала — продавать в нём нечего");
  if (!Array.isArray(raw)) throw new AdInputError("Нужен список мест");
  const slots = [...new Set(raw.map(parseSlot))];
  await db.update(projects).set({ mandatorySlots: JSON.stringify(slots) }).where(eq(projects.id, projectId));
  return slots;
}

async function getProject(id: number) {
  const p = await db.query.projects.findFirst({ where: eq(projects.id, id) });
  if (!p) throw new AdInputError("Проект не найден", 404);
  return p;
}

async function requireContact(id: number) {
  const c = await getContact(id);
  if (!c) throw new AdInputError("Контакт не найден", 404);
  return c;
}

// --- tracking links --------------------------------------------------------

const SLOT_SHORT: Record<AdSlot, string> = {
  morning: "утро",
  day: "день",
  evening: "вечер",
  night: "ночь",
  stories: "сторис",
  n9: "9:00",
  n17: "17:00",
};

/** Telegram caps an invite link's name at 32 characters. */
function inviteName(label: string, date: string, slot: AdSlot): string {
  const tail = ` · ${date.slice(8, 10)}.${date.slice(5, 7)} ${SLOT_SHORT[slot]}`;
  const room = 32 - tail.length;
  return (label.length > room ? `${label.slice(0, Math.max(1, room - 1))}…` : label) + tail;
}

/** `https://t.me/<bot>?start=<slug>` → its parts; anything else → null. */
function parseStartLink(raw: string): { bot: string; slug: string } | null {
  const m = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,32})\?start=([A-Za-z0-9_-]{1,64})$/i.exec(raw.trim());
  return m ? { bot: m[1], slug: m[2] } : null;
}

interface LinkOutcome {
  campaignId?: number | null;
  utmLinkId?: number | null;
  warning?: string;
}

/**
 * Gives a buy its tracking link: the one the owner pasted, or a new one.
 * Returns the ids to store on the buy; a failure to mint a link is a warning,
 * not an error — the buy is still worth keeping, and a link can be attached
 * to it later.
 */
async function provideLink(
  buy: Pick<Buy, "id" | "projectId" | "campaignId" | "utmLinkId" | "date" | "slot" | "creative">,
  label: string,
  amount: number | null,
  contactId: number,
  readyRef: string | null,
  mintInvite: InviteMinter | null
): Promise<LinkOutcome> {
  const project = await getProject(buy.projectId);
  const start = readyRef ? parseStartLink(readyRef) : null;

  // A bot deep link: track the buy by its UTM slug.
  if (start || (!readyRef && !hasChannel(project) && hasBot(project))) {
    if (!hasBot(project)) throw new AdInputError("У проекта нет бота — ссылка вида ?start= ему не подходит");
    if (start && project.botUsername && start.bot.toLowerCase() !== project.botUsername.replace(/^@/, "").toLowerCase()) {
      throw new AdInputError(`Ссылка ведёт в @${start.bot}, а бот проекта — @${project.botUsername.replace(/^@/, "")}`);
    }
    if (start) {
      const existing = await getUtmLinkBySlug(start.slug);
      if (existing) {
        if (existing.projectId !== project.id) throw new AdInputError("Эта UTM-ссылка принадлежит другому проекту", 409);
        const [other] = await db
          .select({ id: adBuys.id })
          .from(adBuys)
          .where(and(eq(adBuys.utmLinkId, existing.id), ne(adBuys.id, buy.id)));
        if (other) throw new AdInputError(`Эта ссылка уже у закупа З-${other.id}`, 409, { buyId: other.id });
        return { utmLinkId: existing.id };
      }
    }
    const created = await createUtmLink({
      projectId: project.id,
      slug: start?.slug,
      utmSource: "telegram",
      utmMedium: "ads",
      utmCampaign: label,
      utmContent: buy.creative ?? undefined,
      label: `${label} · ${buy.date} ${SLOT_SHORT[buy.slot as AdSlot]}`,
      spend: amount ?? undefined,
      botUsername: project.botUsername?.replace(/^@/, "") ?? undefined,
    });
    return { utmLinkId: created.id };
  }

  if (!hasChannel(project)) throw new AdInputError("У проекта нет ни канала, ни бота — ссылку не к чему привязать");

  // A channel invite link, through a campaign of its own. A pasted link is
  // checked before that campaign exists, so a refusal leaves nothing behind.
  let pasted: { ref: string; takeLinkId?: number } | null = null;
  if (readyRef) {
    const normalized = normalizeInviteRef(readyRef);
    if (!normalized.ok) throw new AdInputError(normalized.error);
    const match = await resolveLinkByTelegramRef(normalized.ref);
    if (match.status === "found") {
      if (buy.campaignId && match.link.campaignId === buy.campaignId) return { campaignId: buy.campaignId };
      const owner = await getCampaignById(match.link.campaignId);
      // A hand-made link that someone already joined by lands in the automatic
      // bucket — taking it from there is exactly what pasting it means.
      if (owner?.advertiser !== UNASSIGNED_ADVERTISER) {
        throw new AdInputError(
          `Ссылка уже привязана к кампании #${match.link.campaignId}${owner ? ` («${owner.advertiser}»)` : ""}`,
          409,
          { campaignId: match.link.campaignId }
        );
      }
      pasted = { ref: normalized.ref, takeLinkId: match.link.id };
    } else pasted = { ref: normalized.ref };
  }

  let campaignId = buy.campaignId;
  const fresh = !campaignId;
  if (!campaignId) {
    const campaign = await createCampaign({
      projectId: project.id,
      advertiser: label,
      price: amount ?? 0,
      contactId,
      tags: buy.creative ? { creative: buy.creative } : undefined,
    });
    campaignId = campaign.id;
  }

  if (pasted) {
    try {
      if (pasted.takeLinkId) await reassignLinkCampaign(pasted.takeLinkId, campaignId);
      else await createLinkForCampaign(campaignId, pasted.ref, "invite");
    } catch (error) {
      // The unique index on links.telegram_ref is the last guard against a race
      // with the join handler registering the same link.
      if (fresh) await deleteCampaignCascade(campaignId);
      throw error;
    }
    return { campaignId };
  }

  if (!mintInvite) return { campaignId, warning: "Бот канала не настроен — ссылку не создать, вставьте готовую" };
  try {
    await mintInvite(project.telegramChatId!, campaignId, inviteName(label, buy.date, buy.slot as AdSlot));
    return { campaignId };
  } catch (error: any) {
    console.error(`[ads] Failed to mint an invite link for buy ${buy.id}:`, error);
    return {
      campaignId,
      warning: `Не удалось создать ссылку в канале: ${error?.description ?? error?.message ?? error}. Вставьте готовую или попробуйте ещё раз`,
    };
  }
}

/** Mirrors the buy onto its campaign / UTM link, so other tabs show the same price and name. */
async function syncTracking(buy: Buy, label: string) {
  const amount = amountOfBuy(buy) ?? 0;
  if (buy.campaignId) {
    await db
      .update(campaigns)
      .set({ price: amount, advertiser: label, contactId: buy.contactId })
      .where(eq(campaigns.id, buy.campaignId));
    if (buy.creative) await upsertCampaignTag(buy.campaignId, "creative", buy.creative);
  }
  if (buy.utmLinkId) {
    await db.update(utmLinks).set({ spend: amount }).where(eq(utmLinks.id, buy.utmLinkId));
  }
}

// --- buys ------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function recordStatus(tx: Tx, kind: AdDealKind, dealId: number, status: AdStatus) {
  tx.insert(adStatusHistory).values({ kind, dealId, status }).run();
}

const isPublished = (s: string) => (AD_PUBLISHED_STATUSES as string[]).includes(s);

function buyFields(input: Record<string, unknown>, base?: Buy) {
  const pick = <T>(k: string, parse: (v: unknown) => T, fallback: T): T => (has(input, k) ? parse(input[k]) : fallback);
  const priceMode = pick("priceMode", parsePriceMode, (base?.priceMode as "fix" | "cpm") ?? "fix");
  const f = {
    date: pick("date", parseDate, base?.date as string),
    slot: pick("slot", parseSlot, base?.slot as AdSlot),
    format: pick("format", parseFormat, (base?.format as "1/24" | "1/48") ?? "1/24"),
    status: pick("status", parseStatus, (base?.status as AdStatus) ?? "plan"),
    priceMode,
    price: pick("price", (v) => parseMoney(v, "Цена"), base?.price ?? null),
    cpmRate: pick("cpmRate", (v) => parseMoney(v, "Ставка CPM"), base?.cpmRate ?? null),
    views: pick("views", parseViews, base?.views ?? null),
    cpmState: pick("cpmState", parseCpmState, (base?.cpmState as AdCpmState | null) ?? null),
    creative: pick("creative", (v) => parseText(v, 120, "Креатив"), base?.creative ?? null),
    postUrl: pick("postUrl", (v) => parseUrl(v, "Пост"), base?.postUrl ?? null),
    notes: pick("notes", (v) => parseText(v, 2000, "Заметка"), base?.notes ?? null),
  };
  if (!f.date) throw new AdInputError("Укажите дату");
  if (!f.slot) throw new AdInputError("Укажите место");
  if (f.priceMode === "fix") {
    if (f.price == null) throw new AdInputError("Укажите цену");
    f.cpmRate = null;
    f.cpmState = null;
  } else {
    if (f.cpmRate == null || f.cpmRate <= 0) throw new AdInputError("Укажите ставку за 1000 просмотров");
    f.price = null;
    f.cpmState = f.cpmState ?? "wait";
    if (f.cpmState !== "wait" && f.views == null) throw new AdInputError("Чтобы зафиксировать CPM, нужны просмотры");
  }
  return f;
}

export async function createBuy(input: Record<string, unknown>, mintInvite: InviteMinter | null) {
  const projectId = parseId(input.projectId, "проект");
  const contactId = parseId(input.contactId, "у кого купили");
  const project = await getProject(projectId);
  const contact = await requireContact(contactId);
  const f = buyFields(input);
  const readyRef = parseText(input.readyLink, 300, "Ссылка");
  if (!hasChannel(project) && !hasBot(project)) throw new AdInputError("У проекта нет ни канала, ни бота");

  const buy = db.transaction((tx) => {
    const row = tx
      .insert(adBuys)
      .values({
        projectId,
        contactId,
        ...f,
        cpmFixedAt: f.cpmState === "fixed" ? new Date() : null,
        publishedAt: isPublished(f.status) ? new Date() : null,
      })
      .returning()
      .get();
    recordStatus(tx, "buy", row.id, row.status as AdStatus);
    return row;
  });

  const label = contactLabel(contact);
  let link: LinkOutcome;
  try {
    link = await provideLink(buy, label, amountOfBuy(buy), contactId, readyRef, mintInvite);
  } catch (error) {
    // A bad pasted link must not leave a buy behind that the owner did not see saved.
    db.transaction((tx) => {
      tx.delete(adStatusHistory).where(and(eq(adStatusHistory.kind, "buy"), eq(adStatusHistory.dealId, buy.id))).run();
      tx.delete(adBuys).where(eq(adBuys.id, buy.id)).run();
    });
    throw error;
  }
  const saved = await db
    .update(adBuys)
    .set({ campaignId: link.campaignId ?? null, utmLinkId: link.utmLinkId ?? null })
    .where(eq(adBuys.id, buy.id))
    .returning()
    .get();
  await syncTracking(saved, label);
  return { buy: saved, warning: link.warning ?? null };
}

export async function updateBuy(id: number, input: Record<string, unknown>) {
  const current = await db.query.adBuys.findFirst({ where: eq(adBuys.id, id) });
  if (!current) throw new AdInputError("Закуп не найден", 404);
  if (has(input, "projectId") && Number(input.projectId) !== current.projectId) {
    throw new AdInputError("Проект закупа не меняется — ссылка уже создана в его канале. Удалите закуп и создайте новый");
  }
  const contactId = has(input, "contactId") ? parseId(input.contactId, "у кого купили") : current.contactId;
  const contact = await requireContact(contactId);
  const f = buyFields(input, current);

  const saved = db.transaction((tx) => {
    const row = tx
      .update(adBuys)
      .set({
        ...f,
        contactId,
        cpmFixedAt: f.cpmState === "fixed" ? (current.cpmState === "fixed" ? current.cpmFixedAt : new Date()) : null,
        publishedAt: current.publishedAt ?? (isPublished(f.status) ? new Date() : null),
        updatedAt: new Date(),
      })
      .where(eq(adBuys.id, id))
      .returning()
      .get();
    if (row.status !== current.status) recordStatus(tx, "buy", id, row.status as AdStatus);
    return row;
  });
  await syncTracking(saved, contactLabel(contact));
  return { buy: saved };
}

/** Attaches a pasted link to an existing buy, or tries minting one again. */
export async function attachBuyLink(id: number, readyLinkRaw: unknown, mintInvite: InviteMinter | null) {
  const current = await db.query.adBuys.findFirst({ where: eq(adBuys.id, id) });
  if (!current) throw new AdInputError("Закуп не найден", 404);
  const contact = await requireContact(current.contactId);
  const readyRef = parseText(readyLinkRaw, 300, "Ссылка");
  const link = await provideLink(current, contactLabel(contact), amountOfBuy(current), current.contactId, readyRef, mintInvite);
  const saved = await db
    .update(adBuys)
    .set({
      campaignId: link.campaignId !== undefined ? link.campaignId : current.campaignId,
      utmLinkId: link.utmLinkId !== undefined ? link.utmLinkId : current.utmLinkId,
      updatedAt: new Date(),
    })
    .where(eq(adBuys.id, id))
    .returning()
    .get();
  await syncTracking(saved, contactLabel(contact));
  return { buy: saved, warning: link.warning ?? null };
}

/**
 * Deletes a buy. Its campaign goes to the trash rather than away — the link and
 * every join it brought stay restorable, like any other deleted campaign.
 */
export async function deleteBuy(id: number, adminId: string) {
  const current = await db.query.adBuys.findFirst({ where: eq(adBuys.id, id) });
  if (!current) throw new AdInputError("Закуп не найден", 404);
  db.transaction((tx) => {
    tx.delete(adStatusHistory).where(and(eq(adStatusHistory.kind, "buy"), eq(adStatusHistory.dealId, id))).run();
    tx.delete(adSettlementItems).where(and(eq(adSettlementItems.kind, "buy"), eq(adSettlementItems.dealId, id))).run();
    tx.delete(adBuys).where(eq(adBuys.id, id)).run();
  });
  if (current.campaignId) await softDeleteCampaign(current.campaignId, adminId);
  return { ok: true };
}

// --- sales -----------------------------------------------------------------

interface PlaceInput {
  projectId: number;
  share: number | null;
  views: number | null;
  cpmState: AdCpmState | null;
  postUrl: string | null;
  sent: Record<string, unknown>;
}

function parsePlaces(raw: unknown): PlaceInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AdInputError("Выберите хотя бы один канал");
  if (raw.length > 50) throw new AdInputError("Слишком много каналов в одной продаже");
  const seen = new Set<number>();
  return raw.map((r) => {
    const o = (r && typeof r === "object" ? r : { projectId: r }) as Record<string, unknown>;
    const projectId = parseId(o.projectId, "канал");
    if (seen.has(projectId)) throw new AdInputError("Канал указан дважды");
    seen.add(projectId);
    return {
      projectId,
      share: parseMoney(o.share, "Доля канала"),
      views: parseViews(o.views),
      cpmState: parseCpmState(o.cpmState),
      postUrl: parseUrl(o.postUrl, "Пост"),
      sent: o,
    };
  });
}

/** One active sale per channel, day and slot — the cell is either free or sold. */
async function assertPlacesFree(projectIds: number[], date: string, slot: AdSlot, exceptSaleId?: number) {
  const busy = await db
    .select({ saleId: adSales.id, projectId: adSalePlaces.projectId, name: projects.name })
    .from(adSalePlaces)
    .innerJoin(adSales, eq(adSales.id, adSalePlaces.saleId))
    .innerJoin(projects, eq(projects.id, adSalePlaces.projectId))
    .where(
      and(
        inArray(adSalePlaces.projectId, projectIds),
        eq(adSales.date, date),
        eq(adSales.slot, slot),
        ne(adSales.status, "cancel"),
        exceptSaleId ? ne(adSales.id, exceptSaleId) : undefined
      )
    );
  if (busy.length) {
    const b = busy[0];
    throw new AdInputError(`В «${b.name}» это место уже продано (П-${b.saleId})`, 409, {
      saleId: b.saleId,
      projectId: b.projectId,
    });
  }
}

async function assertChannels(projectIds: number[]) {
  const rows = await db.select().from(projects).where(inArray(projects.id, projectIds));
  for (const id of projectIds) {
    const p = rows.find((r) => r.id === id);
    if (!p) throw new AdInputError(`Проект ${id} не найден`, 404);
    if (!hasChannel(p)) throw new AdInputError(`У «${p.name}» нет канала — продавать места в нём нельзя`);
  }
}

function saleFields(input: Record<string, unknown>, base?: Sale) {
  const pick = <T>(k: string, parse: (v: unknown) => T, fallback: T): T => (has(input, k) ? parse(input[k]) : fallback);
  const f = {
    date: pick("date", parseDate, base?.date as string),
    slot: pick("slot", parseSlot, base?.slot as AdSlot),
    format: pick("format", parseFormat, (base?.format as "1/24" | "1/48") ?? "1/24"),
    status: pick("status", parseStatus, (base?.status as AdStatus) ?? "plan"),
    priceMode: pick("priceMode", parsePriceMode, (base?.priceMode as "fix" | "cpm") ?? "fix"),
    cpmRate: pick("cpmRate", (v) => parseMoney(v, "Ставка CPM"), base?.cpmRate ?? null),
    notes: pick("notes", (v) => parseText(v, 2000, "Заметка"), base?.notes ?? null),
  };
  if (!f.date) throw new AdInputError("Укажите дату");
  if (!f.slot) throw new AdInputError("Укажите место");
  if (f.priceMode === "cpm") {
    if (f.cpmRate == null || f.cpmRate <= 0) throw new AdInputError("Укажите ставку за 1000 просмотров");
  } else f.cpmRate = null;
  return f;
}

/**
 * The channels of a sale with their shares settled: a fixed package price is
 * split as sent (and must add up), or evenly when no shares were sent.
 */
function resolveShares(
  places: PlaceInput[],
  priceMode: "fix" | "cpm",
  totalRaw: unknown,
  existing: Place[]
): Array<Omit<typeof adSalePlaces.$inferInsert, "saleId">> {
  let shares: Array<number | null> = places.map(() => null);
  if (priceMode === "fix") {
    const total = parseMoney(totalRaw, "Сумма продажи");
    const sentAll = places.every((p) => p.share != null);
    if (sentAll) {
      shares = places.map((p) => p.share);
      const sum = Math.round(shares.reduce((a, b) => a! + b!, 0)! * 100) / 100;
      if (total != null && sum !== total) {
        throw new AdInputError(`Доли каналов (${sum} ₽) не сходятся с суммой продажи (${total} ₽)`);
      }
    } else {
      if (total == null) throw new AdInputError("Укажите сумму продажи");
      shares = evenSplit(total, places.length);
    }
  }
  return places.map((p, i) => {
    const old = existing.find((e) => e.projectId === p.projectId);
    const keep = <K extends "views" | "cpmState" | "postUrl">(k: K, v: Place[K] | null) =>
      has(p.sent, k) ? v : old ? old[k] : null;
    const cpmState = priceMode === "cpm" ? (keep("cpmState", p.cpmState) ?? "wait") : null;
    const views = keep("views", p.views);
    if (cpmState && cpmState !== "wait" && views == null) throw new AdInputError("Чтобы зафиксировать CPM, нужны просмотры");
    return {
      projectId: p.projectId,
      share: shares[i],
      views,
      cpmState,
      cpmFixedAt: cpmState === "fixed" ? (old?.cpmState === "fixed" ? old.cpmFixedAt : new Date()) : null,
      postUrl: keep("postUrl", p.postUrl),
      publishedAt: old?.publishedAt ?? null,
    };
  });
}

export async function createSale(input: Record<string, unknown>) {
  const contactId = parseId(input.contactId, "покупатель");
  await requireContact(contactId);
  const f = saleFields(input);
  const places = parsePlaces(input.places);
  const ids = places.map((p) => p.projectId);
  await assertChannels(ids);
  if (f.status !== "cancel") await assertPlacesFree(ids, f.date, f.slot);
  const rows = resolveShares(places, f.priceMode, input.total, []);
  const published = isPublished(f.status) ? new Date() : null;

  const sale = db.transaction((tx) => {
    const s = tx.insert(adSales).values({ contactId, ...f }).returning().get();
    tx.insert(adSalePlaces)
      .values(rows.map((r) => ({ ...r, saleId: s.id, publishedAt: published })))
      .run();
    recordStatus(tx, "sale", s.id, s.status as AdStatus);
    return s;
  });
  return { sale };
}

export async function updateSale(id: number, input: Record<string, unknown>) {
  const current = await db.query.adSales.findFirst({ where: eq(adSales.id, id) });
  if (!current) throw new AdInputError("Продажа не найдена", 404);
  const existing = await db.select().from(adSalePlaces).where(eq(adSalePlaces.saleId, id));
  const contactId = has(input, "contactId") ? parseId(input.contactId, "покупатель") : current.contactId;
  await requireContact(contactId);
  const f = saleFields(input, current);

  // Channels: as sent, or the current ones; a changed total or price mode
  // re-splits the current channels evenly unless shares were sent too.
  const places: PlaceInput[] = has(input, "places")
    ? parsePlaces(input.places)
    : existing.map((e) => ({ projectId: e.projectId, share: f.priceMode === "fix" && !has(input, "total") ? e.share : null, views: null, cpmState: null, postUrl: null, sent: {} }));
  const ids = places.map((p) => p.projectId);
  await assertChannels(ids);
  if (f.status !== "cancel") await assertPlacesFree(ids, f.date, f.slot, id);
  const rows = resolveShares(places, f.priceMode, input.total, existing);
  const nowPublished = isPublished(f.status) && !isPublished(current.status);

  const sale = db.transaction((tx) => {
    const s = tx
      .update(adSales)
      .set({ ...f, contactId, updatedAt: new Date() })
      .where(eq(adSales.id, id))
      .returning()
      .get();
    const keepIds = new Set(ids);
    for (const e of existing) if (!keepIds.has(e.projectId)) tx.delete(adSalePlaces).where(eq(adSalePlaces.id, e.id)).run();
    for (const r of rows) {
      const old = existing.find((e) => e.projectId === r.projectId);
      const values = { ...r, publishedAt: r.publishedAt ?? (nowPublished ? new Date() : null) };
      if (old) tx.update(adSalePlaces).set(values).where(eq(adSalePlaces.id, old.id)).run();
      else tx.insert(adSalePlaces).values({ ...values, saleId: id }).run();
    }
    if (s.status !== current.status) recordStatus(tx, "sale", id, s.status as AdStatus);
    return s;
  });
  return { sale };
}

export async function deleteSale(id: number) {
  const current = await db.query.adSales.findFirst({ where: eq(adSales.id, id) });
  if (!current) throw new AdInputError("Продажа не найдена", 404);
  db.transaction((tx) => {
    tx.delete(adStatusHistory).where(and(eq(adStatusHistory.kind, "sale"), eq(adStatusHistory.dealId, id))).run();
    tx.delete(adSettlementItems).where(and(eq(adSettlementItems.kind, "sale"), eq(adSettlementItems.dealId, id))).run();
    tx.delete(adSalePlaces).where(eq(adSalePlaces.saleId, id)).run();
    tx.delete(adSales).where(eq(adSales.id, id)).run();
  });
  return { ok: true };
}

// --- listing ---------------------------------------------------------------

export interface BuyResult {
  subs: number;
  buyers: number;
  revenue: number;
  /** Share of those subscribers who have not left since. Null with no subscribers. */
  retention: number | null;
}

const CHUNK = 500;
async function inChunks<T, R>(items: T[], fn: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(...(await fn(items.slice(i, i + CHUNK))));
  return out;
}

/**
 * Results of published buys, from the events their links brought — the same
 * counting as the Campaigns tab: subscribers are distinct users with an entry
 * event, buyers distinct users with a payment, revenue payments plus renewals.
 */
async function resultsFor(buys: Buy[]): Promise<Map<number, BuyResult>> {
  const out = new Map<number, BuyResult>();
  const tracked = buys.filter((b) => (b.campaignId || b.utmLinkId) && isPublished(b.status));
  if (!tracked.length) return out;

  const campaignIds = [...new Set(tracked.map((b) => b.campaignId).filter((x): x is number => !!x))];
  const utmIds = [...new Set(tracked.map((b) => b.utmLinkId).filter((x): x is number => !!x))];
  const linkRows = campaignIds.length
    ? await inChunks(campaignIds, (c) => db.select({ id: links.id, campaignId: links.campaignId }).from(links).where(inArray(links.campaignId, c)))
    : [];
  const campaignOfLink = new Map(linkRows.map((l) => [l.id, l.campaignId]));
  const linkIds = linkRows.map((l) => l.id);

  const evs = [
    ...(linkIds.length ? await inChunks(linkIds, (c) => db.select().from(events).where(inArray(events.linkId, c))) : []),
    ...(utmIds.length ? await inChunks(utmIds, (c) => db.select().from(events).where(and(inArray(events.utmLinkId, c), isNull(events.linkId)))) : []),
  ];

  const byCampaign = new Map<number, typeof evs>();
  const byUtm = new Map<number, typeof evs>();
  for (const e of evs) {
    const cid = e.linkId ? campaignOfLink.get(e.linkId) : undefined;
    if (cid) (byCampaign.get(cid) ?? byCampaign.set(cid, []).get(cid)!).push(e);
    else if (e.utmLinkId) (byUtm.get(e.utmLinkId) ?? byUtm.set(e.utmLinkId, []).get(e.utmLinkId)!).push(e);
  }

  // When each subscriber first came, per buy — then who left after that.
  const firstEntry = new Map<number, Map<string, number>>();
  const allUsers = new Set<string>();
  for (const b of tracked) {
    const list = [...(b.campaignId ? byCampaign.get(b.campaignId) ?? [] : []), ...(b.utmLinkId ? byUtm.get(b.utmLinkId) ?? [] : [])];
    const entries = new Map<string, number>();
    for (const e of list) {
      if (!(FUNNEL_ENTRY_TYPES as readonly string[]).includes(e.eventType)) continue;
      const t = new Date(e.ts).getTime();
      const prev = entries.get(e.tgUserId);
      if (prev === undefined || t < prev) entries.set(e.tgUserId, t);
      allUsers.add(e.tgUserId);
    }
    firstEntry.set(b.id, entries);
    const buyers = new Set(list.filter((e) => e.eventType === EVENT_TYPES.PAYMENT).map((e) => e.tgUserId));
    const revenue = list
      .filter((e) => e.eventType === EVENT_TYPES.PAYMENT || e.eventType === EVENT_TYPES.RENEWAL)
      .reduce((s, e) => s + (e.amount || 0), 0);
    out.set(b.id, { subs: entries.size, buyers: buyers.size, revenue, retention: null });
  }

  const exits = allUsers.size
    ? await inChunks([...allUsers], (c) =>
        db
          .select({ tgUserId: events.tgUserId, projectId: events.projectId, ts: events.ts })
          .from(events)
          .where(and(inArray(events.tgUserId, c), inArray(events.eventType, [EVENT_TYPES.LEAVE, EVENT_TYPES.CHURN])))
      )
    : [];
  for (const b of tracked) {
    const entries = firstEntry.get(b.id)!;
    if (!entries.size) continue;
    let stayed = 0;
    for (const [user, t] of entries) {
      const left = exits.some((x) => x.tgUserId === user && x.projectId === b.projectId && new Date(x.ts).getTime() >= t);
      if (!left) stayed++;
    }
    out.get(b.id)!.retention = stayed / entries.size;
  }
  return out;
}

async function historyFor(kind: AdDealKind, ids: number[]) {
  const map = new Map<number, Array<{ st: string; at: Date }>>();
  if (!ids.length) return map;
  const rows = await inChunks(ids, (c) =>
    db
      .select()
      .from(adStatusHistory)
      .where(and(eq(adStatusHistory.kind, kind), inArray(adStatusHistory.dealId, c)))
      .orderBy(adStatusHistory.at, adStatusHistory.id)
  );
  for (const r of rows) (map.get(r.dealId) ?? map.set(r.dealId, []).get(r.dealId)!).push({ st: r.status, at: r.at });
  return map;
}

/** Where a buy's tracking link points — the invite link, or the bot deep link. */
async function tracksFor(buys: Buy[]) {
  const map = new Map<number, string>();
  const campaignIds = [...new Set(buys.map((b) => b.campaignId).filter((x): x is number => !!x))];
  const utmIds = [...new Set(buys.map((b) => b.utmLinkId).filter((x): x is number => !!x))];
  const ls = campaignIds.length ? await inChunks(campaignIds, (c) => db.select().from(links).where(inArray(links.campaignId, c))) : [];
  const us = utmIds.length ? await inChunks(utmIds, (c) => db.select().from(utmLinks).where(inArray(utmLinks.id, c))) : [];
  for (const b of buys) {
    const l = b.campaignId ? ls.filter((x) => x.campaignId === b.campaignId).sort((x, y) => x.id - y.id)[0] : undefined;
    const u = b.utmLinkId ? us.find((x) => x.id === b.utmLinkId) : undefined;
    const t = l?.telegramRef ?? (u ? buildDeepLink(u) : null);
    if (t) map.set(b.id, t);
  }
  return map;
}

export interface DealFilter {
  from?: string;
  to?: string;
  contactId?: number;
}

/**
 * Flat rows for the dashboard: one per buy, one per channel of a sale (the
 * channels of one sale share `pkg`). Field names follow the mockup the
 * dashboard code was written against.
 */
export async function listDeals(filter: DealFilter) {
  const from = filter.from ? parseDate(filter.from) : undefined;
  const to = filter.to ? parseDate(filter.to) : undefined;
  const range = <T extends typeof adBuys.date | typeof adSales.date>(col: T) =>
    and(from ? sql`${col} >= ${from}` : undefined, to ? sql`${col} <= ${to}` : undefined);

  const buys = await db
    .select()
    .from(adBuys)
    .where(and(range(adBuys.date), filter.contactId ? eq(adBuys.contactId, filter.contactId) : undefined))
    .orderBy(adBuys.date, adBuys.id);
  const sales = await db
    .select()
    .from(adSales)
    .where(and(range(adSales.date), filter.contactId ? eq(adSales.contactId, filter.contactId) : undefined))
    .orderBy(adSales.date, adSales.id);
  const places = sales.length
    ? await inChunks(sales.map((s) => s.id), (c) => db.select().from(adSalePlaces).where(inArray(adSalePlaces.saleId, c)).orderBy(adSalePlaces.id))
    : [];

  const [results, tracks, buyHist, saleHist] = await Promise.all([
    resultsFor(buys),
    tracksFor(buys),
    historyFor("buy", buys.map((b) => b.id)),
    historyFor("sale", sales.map((s) => s.id)),
  ]);

  const buyRows = buys.map((b) => ({
    side: "buy" as const,
    id: `З-${b.id}`,
    dealId: b.id,
    project: b.projectId,
    date: b.date,
    slot: b.slot,
    format: b.format,
    status: b.status,
    pm: b.priceMode,
    price: b.price,
    rate: b.cpmRate,
    views: b.views,
    cpmState: b.cpmState,
    fixedAt: b.cpmFixedAt,
    amount: amountOfBuy(b),
    admin: b.contactId,
    creative: b.creative ?? "",
    track: tracks.get(b.id) ?? "",
    campaignId: b.campaignId,
    utmLinkId: b.utmLinkId,
    post: b.postUrl ?? "",
    notes: b.notes ?? "",
    publishedAt: b.publishedAt,
    history: buyHist.get(b.id) ?? [],
    result: results.get(b.id) ?? null,
  }));

  const saleRows = sales.flatMap((s) => {
    const ps = places.filter((p) => p.saleId === s.id);
    return ps.map((p, i) => ({
      side: "sell" as const,
      id: ps.length > 1 ? `П-${s.id}·${i + 1}` : `П-${s.id}`,
      pkg: `П-${s.id}`,
      dealId: s.id,
      placeId: p.id,
      project: p.projectId,
      date: s.date,
      slot: s.slot,
      format: s.format,
      status: s.status,
      pm: s.priceMode,
      price: p.share,
      rate: s.cpmRate,
      views: p.views,
      cpmState: p.cpmState,
      fixedAt: p.cpmFixedAt,
      amount: amountOfPlace(s, p),
      buyer: s.contactId,
      post: p.postUrl ?? "",
      notes: s.notes ?? "",
      publishedAt: p.publishedAt,
      history: saleHist.get(s.id) ?? [],
    }));
  });

  return { buys: buyRows, sales: saleRows };
}

/** For "has this slot already passed" on the client — sent so both sides agree. */
export const SLOT_TIMES = AD_SLOT_TIME;
