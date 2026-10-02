import { db } from "../db/index.js";
import {
  campaigns,
  campaignTags,
  links,
  projects,
  events,
  dailyStats,
  utmLinks,
  adBuys,
  adSalePlaces,
  adSales,
  adSettlementItems,
  adStatusHistory,
} from "../db/schema.js";
import { eq, and, or, inArray, desc, sql, isNull, isNotNull } from "drizzle-orm";
import { aggregate } from "../jobs/dailyAggregate.js";
import { getRetentionStats, getCohortLtv } from "./metrics.js";
import { EVENT_TYPES, FUNNEL_ENTRY_TYPES } from "../db/eventTypes.js";
import { logAdminAction } from "./auditLog.js";
import { deriveProjectType, hasBot, hasChannel } from "../db/projectTypes.js";
import { findProjectIdByBotUsername } from "./events.js";
import { buildDeepLink } from "./utm.js";
import { matchContactByAdvertiser } from "./adContacts.js";

export interface CreateCampaignInput {
  projectId: number;
  advertiser: string;
  price: number;
  tags?: Array<{ tagKey: string; tagValue: string }> | Record<string, string>;
  // Who the placement was bought from. Left out, it is matched from the
  // advertiser text against existing contacts (never creating one).
  contactId?: number | null;
}

export async function getAllProjects() {
  return await db.select().from(projects);
}

/** Empty strings from forms mean "not set", and a leading @ is decoration. */
function normalizeBotUsername(value?: string | null): string | null {
  const clean = (value ?? "").trim().replace(/^@/, "");
  return clean || null;
}

function normalizeChatId(value?: string | null): string | null {
  const clean = (value ?? "").trim();
  return clean || null;
}

/**
 * Creates a project from whatever halves it has — a channel, a bot, or both.
 *
 * There is no `type` parameter any more: the type is a consequence of the
 * composition (see deriveProjectType), and letting callers pick it is how a
 * channel with a bot used to end up labelled as a bare channel.
 */
export async function createProject(input: {
  name: string;
  telegramChatId?: string | null;
  botUsername?: string | null;
}) {
  const telegramChatId = normalizeChatId(input.telegramChatId);
  const botUsername = normalizeBotUsername(input.botUsername);

  const [project] = await db
    .insert(projects)
    .values({
      name: input.name,
      type: deriveProjectType({ telegramChatId, botUsername }),
      telegramChatId,
      botUsername,
    })
    .returning();

  return project;
}

/**
 * Changes a project's halves and re-derives its type in the same write, so the
 * two can never disagree. Passing `null` removes a half; leaving a field
 * undefined keeps it as it is.
 */
export async function updateProjectConfig(
  projectId: number,
  config: {
    telegramChatId?: string | null;
    botUsername?: string | null;
    name?: string;
    // ad section modes: true/false set them, null returns to the default
    adsBuy?: boolean | null;
    adsSell?: boolean | null;
  }
) {
  const current = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!current) return undefined;

  const telegramChatId =
    config.telegramChatId !== undefined ? normalizeChatId(config.telegramChatId) : current.telegramChatId;
  const botUsername =
    config.botUsername !== undefined ? normalizeBotUsername(config.botUsername) : current.botUsername;

  const [updatedProject] = await db
    .update(projects)
    .set({
      telegramChatId,
      botUsername,
      type: deriveProjectType({ telegramChatId, botUsername }),
      ...(config.name !== undefined && config.name.trim() !== "" && { name: config.name.trim() }),
      ...(config.adsBuy !== undefined && { adsBuy: config.adsBuy }),
      ...(config.adsSell !== undefined && { adsSell: config.adsSell }),
    })
    .where(eq(projects.id, projectId))
    .returning();

  return updatedProject;
}

/**
 * Folds a bot-only project into a channel project: the channel gains the bot,
 * and everything the bot project had recorded moves across with it.
 *
 * This is the runtime twin of migration 0012 and does exactly what it does, in
 * one transaction. It replaces "linking" a channel to a privatka: a link left
 * the funnel split across two rows, and a merge is what makes a purchase land
 * in the same project as the join that led to it.
 *
 * Not reversible in the sense of restoring the old split — once the rows are
 * one, nothing records which event came from which half. Detaching the bot
 * afterwards (updateProjectConfig with botUsername: null) keeps the history.
 */
export async function attachBotProject(channelProjectId: number, botProjectId: number) {
  if (channelProjectId === botProjectId) {
    throw new Error("A project cannot be merged into itself");
  }

  const channel = await db.query.projects.findFirst({ where: eq(projects.id, channelProjectId) });
  if (!channel) throw new Error(`Project ${channelProjectId} not found`);
  if (!hasChannel(channel)) {
    throw new Error(`Project "${channel.name}" has no channel to attach a bot to`);
  }
  if (hasBot(channel)) {
    throw new Error(`Project "${channel.name}" already has a bot (@${channel.botUsername})`);
  }

  const bot = await db.query.projects.findFirst({ where: eq(projects.id, botProjectId) });
  if (!bot) throw new Error(`Project ${botProjectId} not found`);
  if (!hasBot(bot)) throw new Error(`Project "${bot.name}" has no bot`);
  if (hasChannel(bot)) {
    throw new Error(`Project "${bot.name}" already has its own channel — it is not a bot-only project`);
  }

  db.transaction((tx) => {
    // An event with an exact twin already in the channel project would collide
    // on the unique key; it is the same event recorded twice, and the channel's
    // copy stays.
    tx.run(sql`
      DELETE FROM events WHERE id IN (
        SELECT e.id FROM events e
        WHERE e.project_id = ${botProjectId}
          AND EXISTS (
            SELECT 1 FROM events k
            WHERE k.project_id = ${channelProjectId}
              AND k.tg_user_id = e.tg_user_id
              AND k.event_type = e.event_type
              AND k.ts = e.ts
          )
      )
    `);
    tx.update(events).set({ projectId: channelProjectId }).where(eq(events.projectId, botProjectId)).run();
    tx.update(campaigns).set({ projectId: channelProjectId }).where(eq(campaigns.projectId, botProjectId)).run();
    tx.update(utmLinks).set({ projectId: channelProjectId }).where(eq(utmLinks.projectId, botProjectId)).run();
    // Ad buys made for the bot are now buys for the merged project. A bot-only
    // project has no channel, so it never had sale places to move.
    tx.update(adBuys).set({ projectId: channelProjectId }).where(eq(adBuys.projectId, botProjectId)).run();

    // The bot row goes before the channel takes its username: bot_username is
    // what incoming events are matched on, and for a moment two rows holding it
    // would make that match ambiguous.
    tx.delete(projects).where(eq(projects.id, botProjectId)).run();
    tx.update(projects)
      .set({
        botUsername: bot.botUsername,
        type: deriveProjectType({ telegramChatId: channel.telegramChatId, botUsername: bot.botUsername }),
      })
      .where(eq(projects.id, channelProjectId))
      .run();
  });

  return await db.query.projects.findFirst({ where: eq(projects.id, channelProjectId) });
}

export async function deleteProjectCascade(projectId: number) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });
  if (!project) return null;

  // One synchronous transaction — see deleteCampaignCascade for why. The same
  // race hit here: deleting a project while an event arrived could fail on the
  // foreign key half way, with events and links already gone.
  return db.transaction((tx) => {
    // Ad deals of the project go first: they point at its campaigns and UTM
    // links as well as at the project. A sale package loses only this channel;
    // a sale left with no channel at all goes too.
    const buyIds = tx.select({ id: adBuys.id }).from(adBuys).where(eq(adBuys.projectId, projectId)).all().map((b) => b.id);
    if (buyIds.length > 0) {
      tx.delete(adStatusHistory).where(and(eq(adStatusHistory.kind, "buy"), inArray(adStatusHistory.dealId, buyIds))).run();
      tx.delete(adSettlementItems).where(and(eq(adSettlementItems.kind, "buy"), inArray(adSettlementItems.dealId, buyIds))).run();
      tx.delete(adBuys).where(inArray(adBuys.id, buyIds)).run();
    }
    tx.delete(adSalePlaces).where(eq(adSalePlaces.projectId, projectId)).run();
    const emptySaleIds = tx
      .select({ id: adSales.id })
      .from(adSales)
      .where(sql`NOT EXISTS (SELECT 1 FROM ad_sale_places p WHERE p.sale_id = ${adSales.id})`)
      .all()
      .map((s) => s.id);
    if (emptySaleIds.length > 0) {
      tx.delete(adStatusHistory).where(and(eq(adStatusHistory.kind, "sale"), inArray(adStatusHistory.dealId, emptySaleIds))).run();
      tx.delete(adSettlementItems).where(and(eq(adSettlementItems.kind, "sale"), inArray(adSettlementItems.dealId, emptySaleIds))).run();
      tx.delete(adSales).where(inArray(adSales.id, emptySaleIds)).run();
    }

    const campaignIds = tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(eq(campaigns.projectId, projectId))
      .all()
      .map((c) => c.id);

    let deletedEventsCount = 0;
    let deletedLinksCount = 0;
    let deletedTagsCount = 0;
    let deletedStatsCount = 0;

    if (campaignIds.length > 0) {
      const linkIds = tx
        .select({ id: links.id })
        .from(links)
        .where(inArray(links.campaignId, campaignIds))
        .all()
        .map((l) => l.id);

      if (linkIds.length > 0) {
        deletedEventsCount += tx.delete(events).where(inArray(events.linkId, linkIds)).run().changes;
      }
      deletedLinksCount = tx.delete(links).where(inArray(links.campaignId, campaignIds)).run().changes;
      deletedTagsCount = tx.delete(campaignTags).where(inArray(campaignTags.campaignId, campaignIds)).run().changes;
      deletedStatsCount = tx.delete(dailyStats).where(inArray(dailyStats.campaignId, campaignIds)).run().changes;
      tx.delete(campaigns).where(inArray(campaigns.id, campaignIds)).run();
    }

    // Events that belong to the project without going through a campaign link
    // — organic and UTM ones — and anything still pointing at its UTM links.
    // Left behind, they would block the project row on the foreign key.
    const utmIds = tx
      .select({ id: utmLinks.id })
      .from(utmLinks)
      .where(eq(utmLinks.projectId, projectId))
      .all()
      .map((u) => u.id);
    if (utmIds.length > 0) {
      deletedEventsCount += tx.delete(events).where(inArray(events.utmLinkId, utmIds)).run().changes;
    }
    deletedEventsCount += tx.delete(events).where(eq(events.projectId, projectId)).run().changes;
    tx.delete(utmLinks).where(eq(utmLinks.projectId, projectId)).run();

    const [deletedProject] = tx.delete(projects).where(eq(projects.id, projectId)).returning().all();

    return {
      deletedProject,
      deletedCampaignsCount: campaignIds.length,
      deletedTagsCount,
      deletedLinksCount,
      deletedEventsCount,
      deletedStatsCount,
    };
  });
}

export async function createCampaign(input: CreateCampaignInput) {
  const [insertedCampaign] = await db
    .insert(campaigns)
    .values({
      projectId: input.projectId,
      advertiser: input.advertiser,
      price: input.price,
      contactId:
        input.contactId !== undefined ? input.contactId : await matchContactByAdvertiser(input.advertiser),
    })
    .returning();

  let createdTags: Array<{ id: number; campaignId: number; tagKey: string; tagValue: string }> = [];

  if (input.tags) {
    let tagEntries: Array<{ tagKey: string; tagValue: string }> = [];

    if (Array.isArray(input.tags)) {
      tagEntries = input.tags;
    } else {
      tagEntries = Object.entries(input.tags).map(([tagKey, tagValue]) => ({
        tagKey,
        tagValue,
      }));
    }

    if (tagEntries.length > 0) {
      createdTags = await db
        .insert(campaignTags)
        .values(
          tagEntries.map((t) => ({
            campaignId: insertedCampaign.id,
            tagKey: t.tagKey,
            tagValue: t.tagValue,
          }))
        )
        .returning();
    }
  }

  return {
    ...insertedCampaign,
    tags: createdTags,
  };
}

export async function createLinkForCampaign(
  campaignId: number,
  telegramRef: string,
  linkType: string,
  label?: string
) {
  const [insertedLink] = await db
    .insert(links)
    .values({
      campaignId,
      telegramRef,
      linkType,
      label: label ?? null,
    })
    .returning();

  return insertedLink;
}

// Normalizes a hand-made Telegram invite link into the exact string Telegram
// itself reports back in `chat_member.invite_link.invite_link`.
//
// Why an exact-string match matters: attribution looks a join up by
// `links.telegram_ref` (see getLinkByRef / the chat_member handler in
// src/bots/channelBot.ts), and that lookup is a plain equality comparison
// against whatever Telegram sends. So only the parts that Telegram itself
// always normalizes may be touched here — the scheme (always https) and the
// host (always lowercase `t.me`). The invite hash is case-SENSITIVE and is
// left byte-for-byte as typed; lower/upper-casing it would produce a row that
// can never be matched by a real join. For the same reason the legacy
// `/joinchat/<hash>` form is kept as-is rather than rewritten to `/+<hash>`:
// Telegram keeps reporting old links in their original shape.
//
// A public username link (https://t.me/somechannel) is rejected outright: it
// is the channel's public address, not an invite link, and Telegram never puts
// it into `chat_member.invite_link`, so binding a campaign to it would silently
// never attribute a single join.
export function normalizeInviteRef(
  raw: string
): { ok: true; ref: string } | { ok: false; error: string } {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "Ссылка пустая — пришлите инвайт-ссылку канала." };
  }

  let rest = trimmed;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(rest);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      return {
        ok: false,
        error: `Неподдерживаемый формат ссылки (${schemeMatch[1]}://). Ожидается https://t.me/+ХЕШ или https://t.me/joinchat/ХЕШ.`,
      };
    }
    rest = rest.slice(schemeMatch[0].length);
  }

  const slash = rest.indexOf("/");
  if (slash === -1) {
    return {
      ok: false,
      error: "Это не похоже на инвайт-ссылку. Ожидается https://t.me/+ХЕШ или https://t.me/joinchat/ХЕШ.",
    };
  }

  const host = rest.slice(0, slash).toLowerCase();
  if (host !== "t.me") {
    return {
      ok: false,
      error: `Домен «${rest.slice(0, slash)}» не поддерживается — Telegram присылает инвайт-ссылки только на t.me.`,
    };
  }

  const path = rest.slice(slash + 1).replace(/\/+$/, "");

  const plusMatch = /^\+([A-Za-z0-9_-]+)$/.exec(path);
  if (plusMatch) {
    return { ok: true, ref: `https://t.me/+${plusMatch[1]}` };
  }

  const joinchatMatch = /^joinchat\/([A-Za-z0-9_-]+)$/i.exec(path);
  if (joinchatMatch) {
    return { ok: true, ref: `https://t.me/joinchat/${joinchatMatch[1]}` };
  }

  if (/^[A-Za-z0-9_]{4,32}$/.test(path)) {
    return {
      ok: false,
      error:
        `«${path}» — это публичный юзернейм канала, а не инвайт-ссылка. ` +
        `Telegram никогда не присылает его в chat_member, поэтому переходы по нему не привяжутся. ` +
        `Создайте инвайт-ссылку в настройках канала (вид https://t.me/+ХЕШ) и пришлите её.`,
    };
  }

  return {
    ok: false,
    error: "Не удалось разобрать ссылку. Ожидается https://t.me/+ХЕШ или https://t.me/joinchat/ХЕШ.",
  };
}

// Link types a manually-made invite may be bound as — mirrors what
// createInviteForCampaign writes for bot-created invites.
export const MANUAL_LINK_TYPES = ["invite", "invite_closed"] as const;
export type ManualLinkType = (typeof MANUAL_LINK_TYPES)[number];

export interface ReadyLinkInput {
  telegramRef: string;
  linkType: ManualLinkType;
  label?: string;
}

export async function createCampaignWithLinks(
  projectId: number,
  advertiser: string,
  price: number,
  linkName: string,
  tags?: Array<{ tagKey: string; tagValue: string }> | Record<string, string>,
  isClosedLink: boolean = false,
  createInviteFn?: (channelId: string | number, campaignId: number, name?: string, isClosed?: boolean, label?: string) => Promise<{ inviteLink: string; savedLink: any }>,
  // When set, the owner already made this invite link by hand in Telegram: it
  // is bound to the new campaign as-is and no new invite is created in the
  // channel. Omitting it keeps the original behaviour (bot mints the invite).
  readyLink?: ReadyLinkInput
) {
  // Validate the ready link BEFORE the campaign row exists. Between the moment
  // the admin typed it and this call, the link could have been taken by
  // another campaign or auto-registered by the chat_member handler — and if we
  // created the campaign first and then failed to attach a link, the DB would
  // be left with an orphan campaign that has to be cleaned up by hand.
  let verifiedRef: string | null = null;
  if (readyLink) {
    const normalized = normalizeInviteRef(readyLink.telegramRef);
    if (!normalized.ok) throw new Error(normalized.error);

    const match = await resolveLinkByTelegramRef(normalized.ref);
    if (match.status === "found") {
      const existing = match.link;
      const owner = await getCampaignById(existing.campaignId);
      throw new Error(
        `Ссылка уже привязана к кампании #${existing.campaignId}` +
          (owner ? ` («${owner.advertiser}»)` : "") +
          ". Перенесите её в дашборде вместо создания новой кампании."
      );
    }
    verifiedRef = normalized.ref;
  }

  const campaign = await createCampaign({
    projectId,
    advertiser,
    price,
    tags,
  });

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  let channelLink: { inviteLink: string; savedLink: any } | null = null;

  if (readyLink && verifiedRef) {
    // Attach the hand-made link. The unique index on links.telegram_ref is the
    // last line of defence against a race with the auto-registration path, so
    // a failure here rolls the fresh campaign back rather than leaving it empty.
    try {
      const savedLink = await createLinkForCampaign(
        campaign.id,
        verifiedRef,
        readyLink.linkType,
        readyLink.label
      );
      channelLink = { inviteLink: verifiedRef, savedLink };
    } catch (error) {
      await deleteCampaignCascade(campaign.id);
      throw error;
    }
  } else if (project?.telegramChatId && createInviteFn) {
    // By composition, not by type: a channel that also has a bot is still a
    // channel people can be invited into, and that used to be refused here
    // because its type was no longer "channel".
    // 1. Channel invite link
    const inviteName = `${advertiser} — ${linkName}`;
    channelLink = await createInviteFn(project.telegramChatId, campaign.id, inviteName, isClosedLink, linkName);
  }

  return {
    campaign,
    channelLink,
  };
}

export const UNASSIGNED_ADVERTISER = "Не размечено (авто)";

export async function getProjectByChatId(chatId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.telegramChatId, chatId),
  });
  return project || null;
}

export async function getOrCreateUnassignedCampaign(projectId: number) {
  const existing = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.projectId, projectId), eq(campaigns.advertiser, UNASSIGNED_ADVERTISER)),
  });
  if (existing) return existing;

  const [created] = await db
    .insert(campaigns)
    .values({ projectId, advertiser: UNASSIGNED_ADVERTISER, price: 0 })
    .returning();

  return created;
}

export async function reassignLinkCampaign(linkId: number, campaignId: number) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) {
    throw new Error(`Campaign ${campaignId} not found`);
  }

  // A link can be moved to a campaign of another project — the picker offers
  // every campaign. Its events carry a project of their own, so they have to
  // move with it: otherwise they would keep counting towards the old project
  // while the link itself had left it. One transaction for both, and the same
  // twin rule as a project merge — an exact copy already in the target project
  // on the unique key is the same event, and it stays.
  const updated = db.transaction((tx) => {
    const [row] = tx.update(links).set({ campaignId }).where(eq(links.id, linkId)).returning().all();
    if (!row) return null;

    tx.run(sql`
      DELETE FROM events WHERE id IN (
        SELECT e.id FROM events e
        WHERE e.link_id = ${linkId}
          AND e.project_id <> ${campaign.projectId}
          AND EXISTS (
            SELECT 1 FROM events k
            WHERE k.project_id = ${campaign.projectId}
              AND k.tg_user_id = e.tg_user_id
              AND k.event_type = e.event_type
              AND k.ts = e.ts
          )
      )
    `);
    tx.update(events).set({ projectId: campaign.projectId }).where(eq(events.linkId, linkId)).run();
    return row;
  });

  if (!updated) {
    throw new Error(`Link ${linkId} not found`);
  }

  // dailyStats is a pre-aggregated cache keyed by campaignId — moving a link's
  // historical events to a new campaign needs an explicit recompute, since
  // aggregate() otherwise only runs when a brand new event is logged.
  await aggregate();

  return updated;
}

export async function getLinkByRef(telegramRef: string) {
  const link = await db.query.links.findFirst({
    where: eq(links.telegramRef, telegramRef),
  });
  return link || null;
}

/** Telegram replaces the hash with these when it hides a link from us. */
const TRUNCATION_MARKS = ["...", "…"];

/**
 * The shortest prefix we accept as proof that two refs are the same link.
 * `https://t.me/+` is 14 characters, so this demands at least six characters of
 * hash on top — Telegram hands out eight, and anything shorter than this could
 * collide between unrelated links.
 */
const MIN_PREFIX_LENGTH = 20;

function splitRef(raw: string): { base: string; truncated: boolean } | null {
  let value = String(raw ?? "").trim();
  if (!value) return null;

  let truncated = false;
  for (const mark of TRUNCATION_MARKS) {
    if (value.endsWith(mark)) {
      value = value.slice(0, -mark.length);
      truncated = true;
      break;
    }
  }

  const normalized = normalizeInviteRef(value);
  return normalized.ok ? { base: normalized.ref, truncated } : null;
}

function sameLink(
  a: { base: string; truncated: boolean },
  b: { base: string; truncated: boolean }
): boolean {
  // Two full links must be equal. Prefix matching is only sound when at least
  // one side is a link Telegram deliberately shortened — otherwise
  // `https://t.me/+ABC` would "match" the unrelated `https://t.me/+ABCDEF`.
  if (!a.truncated && !b.truncated) return a.base === b.base;

  const [shorter, longer] =
    a.base.length <= b.base.length ? [a.base, b.base] : [b.base, a.base];
  return shorter.length >= MIN_PREFIX_LENGTH && longer.startsWith(shorter);
}

export type LinkMatch =
  | { status: "found"; link: typeof links.$inferSelect; ambiguousWith?: number[] }
  | { status: "none" };

/**
 * Finds the stored link a Telegram ref refers to, tolerating the hash Telegram
 * hides from us.
 *
 * `ChatInviteLink.invite_link` is documented as: "If the link was created by
 * another chat administrator, then the second part of the link will be replaced
 * with '…'." Every invite an admin makes by hand in the app therefore reaches
 * this bot as `https://t.me/+<8 chars>...`, and an exact compare against the
 * full URL the admin pasted into the campaign card can never hit — which is
 * precisely the case the hand-made-link binding exists for.
 *
 * So the compare falls back to a prefix, and it has to work in both directions:
 * the incoming ref may be the shortened one (stored row is full), or the stored
 * row may be the shortened one (the link auto-registered on someone's join
 * before an admin got round to binding it).
 *
 * Filtering happens in JS rather than SQL on purpose: SQLite's LIKE is
 * case-insensitive for ASCII while invite hashes are case-sensitive, so a LIKE
 * prefix would cheerfully match two different links. The table holds tens of
 * rows, so reading it is cheaper than getting that subtlety wrong.
 */
export async function resolveLinkByTelegramRef(rawRef: string): Promise<LinkMatch> {
  const incoming = splitRef(rawRef);
  if (!incoming) return { status: "none" };

  const all = await db.select().from(links);
  const matches = all.filter((row) => {
    const stored = splitRef(row.telegramRef);
    return stored !== null && sameLink(stored, incoming);
  });

  if (matches.length === 0) return { status: "none" };

  // Duplicates mean two rows describe one physical link — usually a full URL
  // bound by hand next to a shortened one that auto-registered earlier. Dropping
  // the event would lose a join for good, so attribute to the oldest row (stable
  // across redeliveries) and let the caller shout about the duplicates.
  const [oldest, ...rest] = matches.sort((x, y) => x.id - y.id);
  return rest.length > 0
    ? { status: "found", link: oldest, ambiguousWith: rest.map((r) => r.id) }
    : { status: "found", link: oldest };
}

/** Corrects a link's recorded type once Telegram tells us what it really is. */
export async function setLinkType(linkId: number, linkType: string) {
  await db.update(links).set({ linkType }).where(eq(links.id, linkId));
}

export async function getCampaignById(id: number) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, id),
  });
  if (!campaign) return null;

  const tags = await db
    .select()
    .from(campaignTags)
    .where(eq(campaignTags.campaignId, id));

  const campaignLinks = await db
    .select()
    .from(links)
    .where(eq(links.campaignId, id));

  return {
    ...campaign,
    tags,
    links: campaignLinks,
  };
}

/**
 * Where a user came from, for the "new user" and "new purchase" notices the
 * bots send their admins.
 *
 * Two things this used to get wrong. It looked at the user's latest event in
 * *any* project, so someone whose last action was in the VPN had the VPN's
 * source reported by the privatka bot. And it only understood campaign links:
 * a user who arrived through a UTM link has no link on their events, so they
 * were reported as organic. Now the lookup stays inside the caller's project
 * when the caller says which one (projectId or botUsername), and a UTM touch is
 * reported as such. The response keeps the old field names, so a bot that does
 * not know about UTM still prints a sensible line: "UTM — <label>".
 */
export async function getAttributionForUser(
  tgUserId: string,
  scope: { projectId?: number; botUsername?: string } = {}
) {
  const projectId = scope.projectId ?? findProjectIdByBotUsername(scope.botUsername);

  const [touch] = await db
    .select({ linkId: events.linkId, utmLinkId: events.utmLinkId })
    .from(events)
    .where(
      and(
        eq(events.tgUserId, tgUserId),
        or(isNotNull(events.linkId), isNotNull(events.utmLinkId)),
        ...(projectId !== undefined ? [eq(events.projectId, projectId)] : [])
      )
    )
    .orderBy(desc(events.ts), desc(events.id))
    .limit(1);

  if (!touch) return null;

  if (touch.linkId) {
    const link = await db.query.links.findFirst({
      where: eq(links.id, touch.linkId),
    });
    if (!link) return null;

    const campaign = await getCampaignById(link.campaignId);
    if (!campaign) return null;

    const tags: Record<string, string> = {};
    for (const t of campaign.tags) {
      tags[t.tagKey] = t.tagValue;
    }

    return {
      kind: "link" as const,
      linkId: link.id,
      campaignId: campaign.id,
      advertiser: campaign.advertiser,
      telegramRef: link.telegramRef,
      label: link.label,
      tags,
    };
  }

  const utm = await db.query.utmLinks.findFirst({
    where: eq(utmLinks.id, touch.utmLinkId!),
  });
  if (!utm) return null;

  return {
    kind: "utm" as const,
    utmLinkId: utm.id,
    advertiser: "UTM",
    telegramRef: buildDeepLink(utm) ?? utm.slug,
    label: utm.label || `${utm.utmSource} / ${utm.utmCampaign}`,
    tags: {} as Record<string, string>,
    utmSource: utm.utmSource,
    utmMedium: utm.utmMedium,
    utmCampaign: utm.utmCampaign,
  };
}

export async function getCampaignTags(campaignId: number) {
  return await db
    .select()
    .from(campaignTags)
    .where(eq(campaignTags.campaignId, campaignId));
}

export async function getDistinctTagValues(tagKey: string): Promise<string[]> {
  const rows = await db
    .select({ tagValue: campaignTags.tagValue })
    .from(campaignTags)
    .where(eq(campaignTags.tagKey, tagKey));

  const distinctValues = Array.from(new Set(rows.map((r) => r.tagValue))).filter(Boolean);
  return distinctValues;
}

export async function upsertCampaignTag(
  campaignId: number,
  tagKey: string,
  tagValue: string
) {
  const existing = await db.query.campaignTags.findFirst({
    where: and(
      eq(campaignTags.campaignId, campaignId),
      eq(campaignTags.tagKey, tagKey)
    ),
  });

  if (existing) {
    const [updated] = await db
      .update(campaignTags)
      .set({ tagValue })
      .where(
        and(
          eq(campaignTags.campaignId, campaignId),
          eq(campaignTags.tagKey, tagKey)
        )
      )
      .returning();
    return updated;
  } else {
    const [inserted] = await db
      .insert(campaignTags)
      .values({
        campaignId,
        tagKey,
        tagValue,
      })
      .returning();
    return inserted;
  }
}

export async function deleteCampaignTag(campaignId: number, tagKey: string) {
  await db
    .delete(campaignTags)
    .where(
      and(
        eq(campaignTags.campaignId, campaignId),
        eq(campaignTags.tagKey, tagKey)
      )
    );
  return { success: true };
}

// Cascades a single campaign delete across its links/tags/stats/events —
// mirrors deleteProjectCascade above, just scoped to one campaign instead of
// every campaign under a project. There's no DB-level ON DELETE CASCADE (SQLite
// FK enforcement isn't even turned on here), so this has to be done by hand.
export async function deleteCampaignCascade(campaignId: number) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) return null;

  // One synchronous transaction, for two reasons. Atomicity: a failure half way
  // used to leave the events and links gone and the campaign still there. And
  // interleaving: this used to be a chain of awaits, and the daily aggregation —
  // which runs after every incoming event — could slip in between them and
  // write daily_stats rows back for this very campaign after they had been
  // cleared, making the final DELETE fail on the foreign key. A synchronous
  // better-sqlite3 transaction cannot be interrupted by other JavaScript.
  return db.transaction((tx) => {
    const linkIds = tx
      .select({ id: links.id })
      .from(links)
      .where(eq(links.campaignId, campaignId))
      .all()
      .map((l) => l.id);

    const deletedEventsCount = linkIds.length
      ? tx.delete(events).where(inArray(events.linkId, linkIds)).run().changes
      : 0;
    const deletedLinksCount = tx.delete(links).where(eq(links.campaignId, campaignId)).run().changes;
    const deletedTagsCount = tx.delete(campaignTags).where(eq(campaignTags.campaignId, campaignId)).run().changes;
    const deletedStatsCount = tx.delete(dailyStats).where(eq(dailyStats.campaignId, campaignId)).run().changes;
    // A buy whose campaign was trashed by hand and then purged stays a buy —
    // it only loses its tracking link and with it the results.
    tx.update(adBuys).set({ campaignId: null }).where(eq(adBuys.campaignId, campaignId)).run();
    const [deletedCampaign] = tx.delete(campaigns).where(eq(campaigns.id, campaignId)).returning().all();

    return {
      deletedCampaign,
      deletedLinksCount,
      deletedTagsCount,
      deletedStatsCount,
      deletedEventsCount,
    };
  });
}

// Soft-deletes a campaign into the trash. It disappears from all normal
// listings/stats immediately but can be restored via restoreCampaign() until
// it's purged (see purgeCampaignCascade below / src/jobs/purgeTrash.ts).
export async function softDeleteCampaign(campaignId: number, adminId: string) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) return null;
  if (campaign.deletedAt) return campaign; // already in the trash, no-op

  const [updated] = await db
    .update(campaigns)
    .set({ deletedAt: new Date() })
    .where(eq(campaigns.id, campaignId))
    .returning();

  await logAdminAction(adminId, "campaign_trash", "campaign", campaignId, campaign.advertiser);
  return updated;
}

// Restores a campaign out of the trash, provided it hasn't been purged yet.
export async function restoreCampaign(campaignId: number, adminId: string) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign || !campaign.deletedAt) return null;

  const [updated] = await db
    .update(campaigns)
    .set({ deletedAt: null })
    .where(eq(campaigns.id, campaignId))
    .returning();

  await logAdminAction(adminId, "campaign_restore", "campaign", campaignId, campaign.advertiser);
  return updated;
}

// Lists campaigns currently in the trash, most recently trashed first.
export async function getTrashedCampaigns() {
  return db
    .select()
    .from(campaigns)
    .where(isNotNull(campaigns.deletedAt))
    .orderBy(desc(campaigns.deletedAt));
}

// Permanently deletes a campaign that is ALREADY in the trash, cascading to
// its links/tags/stats/events (reuses the existing deleteCampaignCascade
// hard-delete). Refuses to purge a campaign that hasn't been trashed first,
// so this can't be used as a bypass around the trash confirmation step.
// adminId is the human admin's tg id for a manual "empty this now" action,
// or the literal string "system" when called by the automatic daily purge
// job in src/jobs/purgeTrash.ts.
export async function purgeCampaignCascade(campaignId: number, adminId: string) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) return null;
  if (!campaign.deletedAt) {
    throw new Error("Campaign must be in the trash before it can be purged");
  }

  const result = await deleteCampaignCascade(campaignId);
  if (result) {
    await logAdminAction(adminId, "campaign_purge", "campaign", campaignId, campaign.advertiser);
  }
  return result;
}

export async function getCampaignFullHistory(campaignId: number) {
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaignId),
  });
  if (!campaign) return null;

  const tags = await getCampaignTags(campaignId);
  const campaignLinks = await db
    .select()
    .from(links)
    .where(eq(links.campaignId, campaignId));

  const linkIds = campaignLinks.map((l) => l.id);

  let campaignEvents: Array<any> = [];
  if (linkIds.length > 0) {
    campaignEvents = await db
      .select()
      .from(events)
      .where(inArray(events.linkId, linkIds))
      .orderBy(desc(events.ts));
  }

  return {
    campaign,
    tags,
    links: campaignLinks,
    events: campaignEvents,
  };
}

export interface CampaignsPageParams {
  page: number;
  pageSize: number;
  q?: string;
  // Only this contact's campaigns — the ad section's "all campaigns of this admin".
  contactId?: number;
}

export interface CampaignsPageLinkRow {
  id: number;
  telegramRef: string;
  linkType: string;
  label: string | null;
  joins: number;
  subs: number;
  buyers: number;
  revenue: number;
  cps: number | null;
  pricePerSub: number | null;
  cohortAcquiredUsers: number;
  avgCohortLtv: number | null;
}

export interface CampaignsPageRow {
  id: number;
  projectId: number;
  advertiser: string;
  price: number;
  creative: string | null;
  createdAt: Date;
  retention24h: number | null;
  retention48h: number | null;
  links: CampaignsPageLinkRow[];
}

// Paginated version of the "по ссылкам" campaigns table: fetches one page of
// campaigns (newest first) plus only the links/events/retention needed for
// those campaigns, instead of the N+1 pattern of computing extended metrics
// for every campaign in the project up front.
export async function getCampaignsPage(
  params: CampaignsPageParams
): Promise<{ rows: CampaignsPageRow[]; total: number }> {
  const { page, pageSize } = params;
  const q = params.q?.trim();
  const offset = (page - 1) * pageSize;

  let whereClause = isNull(campaigns.deletedAt);
  if (q) {
    const needle = `%${q}%`;
    const matches = await db
      .selectDistinct({ id: campaigns.id })
      .from(campaigns)
      .leftJoin(links, eq(links.campaignId, campaigns.id))
      .where(
        and(
          isNull(campaigns.deletedAt),
          sql`lower_unicode(${campaigns.advertiser}) LIKE lower_unicode(${needle})
          OR CAST(${campaigns.id} AS TEXT) LIKE ${needle}
          OR lower_unicode(coalesce(${links.label}, '')) LIKE lower_unicode(${needle})
          OR lower_unicode(coalesce(${links.telegramRef}, '')) LIKE lower_unicode(${needle})`
        )
      );
    const matchingIds = matches.map((m) => m.id);
    if (matchingIds.length === 0) return { rows: [], total: 0 };
    whereClause = and(isNull(campaigns.deletedAt), inArray(campaigns.id, matchingIds))!;
  }
  if (params.contactId) whereClause = and(whereClause, eq(campaigns.contactId, params.contactId))!;

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(campaigns)
    .where(whereClause);

  const pageCampaigns = await db
    .select()
    .from(campaigns)
    .where(whereClause)
    .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
    .limit(pageSize)
    .offset(offset);

  if (pageCampaigns.length === 0) return { rows: [], total: Number(total) || 0 };

  const campaignIds = pageCampaigns.map((c) => c.id);

  const [pageLinks, pageTags, retentions, cohort] = await Promise.all([
    db.select().from(links).where(inArray(links.campaignId, campaignIds)),
    db
      .select()
      .from(campaignTags)
      .where(and(inArray(campaignTags.campaignId, campaignIds), eq(campaignTags.tagKey, "creative"))),
    Promise.all(campaignIds.map((id) => getRetentionStats(id))),
    getCohortLtv(),
  ]);

  const cohortByLink = cohort.byLink;

  const linkIds = pageLinks.map((l) => l.id);
  const pageEvents = linkIds.length
    ? await db.select().from(events).where(inArray(events.linkId, linkIds))
    : [];

  const retentionByCampaign = new Map(campaignIds.map((id, i) => [id, retentions[i]]));
  const creativeByCampaign = new Map(pageTags.map((t) => [t.campaignId, t.tagValue]));

  const linksByCampaign = new Map<number, typeof pageLinks>();
  for (const l of pageLinks) {
    const arr = linksByCampaign.get(l.campaignId) || [];
    arr.push(l);
    linksByCampaign.set(l.campaignId, arr);
  }
  // Events are no longer guaranteed to carry a link — organic ones never do.
  // This map is keyed by link, so those rows simply have no place in it; they
  // are counted at the project level instead, not here.
  const eventsByLink = new Map<number, typeof pageEvents>();
  for (const e of pageEvents) {
    if (e.linkId === null) continue;
    const arr = eventsByLink.get(e.linkId) || [];
    arr.push(e);
    eventsByLink.set(e.linkId, arr);
  }

  const rows: CampaignsPageRow[] = pageCampaigns.map((camp) => {
    const campLinks = linksByCampaign.get(camp.id) || [];
    const linkStats = campLinks.map((l) => {
      const linkEvents = eventsByLink.get(l.id) || [];
      const entryEvents = linkEvents.filter((e) =>
        (FUNNEL_ENTRY_TYPES as readonly string[]).includes(e.eventType)
      );
      const joins = entryEvents.length;
      const subs = new Set(entryEvents.map((e) => e.tgUserId)).size;
      const buyers = new Set(
        linkEvents.filter((e) => e.eventType === EVENT_TYPES.PAYMENT).map((e) => e.tgUserId)
      ).size;
      const revenue = linkEvents
        .filter((e) => e.eventType === EVENT_TYPES.PAYMENT || e.eventType === EVENT_TYPES.RENEWAL)
        .reduce((s, e) => s + (e.amount || 0), 0);
      return { link: l, joins, subs, buyers, revenue };
    });

    // Same proportional price-split as the per-campaign history view: a
    // campaign's price is allocated across its own links by revenue share
    // (falling back to joins share), which is why links always stay grouped
    // with the rest of their campaign's links on the same page.
    const totalRevenue = linkStats.reduce((s, x) => s + x.revenue, 0);
    const totalJoins = linkStats.reduce((s, x) => s + x.joins, 0);

    const linkRows: CampaignsPageLinkRow[] = linkStats.map((x) => {
      const linkCohort = cohortByLink.get(x.link.id) || { acquiredUsers: 0, cohortRevenue: 0 };
      let share: number;
      if (totalRevenue > 0) share = x.revenue / totalRevenue;
      else if (totalJoins > 0) share = x.joins / totalJoins;
      else share = linkStats.length ? 1 / linkStats.length : 0;
      const priceAlloc = camp.price * share;
      return {
        id: x.link.id,
        telegramRef: x.link.telegramRef,
        linkType: x.link.linkType,
        label: x.link.label,
        joins: x.joins,
        subs: x.subs,
        buyers: x.buyers,
        revenue: x.revenue,
        cps: x.buyers ? priceAlloc / x.buyers : null,
        pricePerSub: x.subs ? priceAlloc / x.subs : null,
        cohortAcquiredUsers: linkCohort.acquiredUsers,
        avgCohortLtv:
          linkCohort.acquiredUsers > 0
            ? Number((linkCohort.cohortRevenue / linkCohort.acquiredUsers).toFixed(2))
            : null,
      };
    });

    const ret = retentionByCampaign.get(camp.id) || { retention24h: null, retention48h: null };

    return {
      id: camp.id,
      projectId: camp.projectId,
      advertiser: camp.advertiser,
      price: camp.price,
      creative: creativeByCampaign.get(camp.id) || null,
      createdAt: camp.createdAt,
      retention24h: ret.retention24h,
      retention48h: ret.retention48h,
      links: linkRows,
    };
  });

  return { rows, total: Number(total) || 0 };
}
