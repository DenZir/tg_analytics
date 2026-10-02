/**
 * Contacts of the ad section — the people I buy placements from and sell them
 * to. One row per person, whichever side of the deal they are on.
 *
 * A username is what people type and what the dashboard shows, but it is not
 * an identity: admins change it, and a freed one can be taken by someone else.
 * So a username change keeps the old one in contact_usernames (search still
 * finds it), and the stable link is the Telegram user id.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { adBuys, adSales, campaigns, contacts, contactUsernames } from "../db/schema.js";

export class AdInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const TG_ID_RE = /^\d{1,20}$/;

/**
 * "@kot_tgg", "kot_tgg" and "https://t.me/kot_tgg" all mean the same username.
 * Empty input means "no username"; anything else malformed is rejected rather
 * than stored half-right.
 */
export function normalizeUsername(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^(https?:\/\/)?(t\.me|telegram\.me)\//i, "").replace(/^@/, "").replace(/\/+$/, "");
  if (!USERNAME_RE.test(s)) {
    throw new AdInputError(
      `«${String(raw).trim()}» — не юзернейм Telegram: латиница, цифры и _, от 4 до 32 символов, начинается с буквы`
    );
  }
  return s;
}

function normalizeTgUserId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (!TG_ID_RE.test(s)) throw new AdInputError("Telegram ID — это число");
  return s;
}

function normalizeName(raw: unknown): string {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) throw new AdInputError("Укажите имя контакта");
  if (s.length > 64) throw new AdInputError("Имя длиннее 64 символов");
  if (/[()]/.test(s)) throw new AdInputError("Имя без скобок — юзернейм пишется отдельно");
  return s;
}

/** "Кот (@kot_tgg)" — the one way a contact is written everywhere. */
export function contactLabel(c: { name: string; username: string | null }): string {
  return c.username ? `${c.name} (@${c.username})` : c.name;
}

export interface ContactDto {
  id: number;
  name: string;
  username: string | null;
  tgUserId: string | null;
  oldUsernames: string[];
  label: string;
  buys: number;
  sales: number;
}

/**
 * Every contact with its old usernames and deal counts. The list is small (a
 * few hundred people at most), so the dashboard loads it whole and searches it
 * locally — by name, username, old usernames and the wrong keyboard layout —
 * without a request per keystroke.
 */
export async function listContacts(): Promise<ContactDto[]> {
  const [rows, olds, buyCounts, saleCounts] = await Promise.all([
    db.select().from(contacts).orderBy(contacts.name),
    db.select().from(contactUsernames).orderBy(contactUsernames.replacedAt),
    db
      .select({ id: adBuys.contactId, n: sql<number>`count(*)` })
      .from(adBuys)
      .groupBy(adBuys.contactId),
    db
      .select({ id: adSales.contactId, n: sql<number>`count(*)` })
      .from(adSales)
      .groupBy(adSales.contactId),
  ]);
  const oldBy = new Map<number, string[]>();
  for (const o of olds) {
    const arr = oldBy.get(o.contactId) ?? [];
    if (!arr.some((u) => u.toLowerCase() === o.username.toLowerCase())) arr.push(o.username);
    oldBy.set(o.contactId, arr);
  }
  const buys = new Map(buyCounts.map((r) => [r.id, Number(r.n)]));
  const sales = new Map(saleCounts.map((r) => [r.id, Number(r.n)]));
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    username: c.username,
    tgUserId: c.tgUserId,
    oldUsernames: oldBy.get(c.id) ?? [],
    label: contactLabel(c),
    buys: buys.get(c.id) ?? 0,
    sales: sales.get(c.id) ?? 0,
  }));
}

export async function getContact(id: number) {
  return db.query.contacts.findFirst({ where: eq(contacts.id, id) });
}

async function findByUsername(username: string, exceptId?: number) {
  const rows = await db
    .select()
    .from(contacts)
    .where(
      and(
        sql`lower(${contacts.username}) = lower(${username})`,
        exceptId ? ne(contacts.id, exceptId) : undefined
      )
    );
  return rows[0];
}

/** Someone else who used this username before — worth a warning, not a refusal. */
async function previousOwner(username: string, exceptId?: number) {
  const rows = await db
    .select({ id: contacts.id, name: contacts.name, username: contacts.username })
    .from(contactUsernames)
    .innerJoin(contacts, eq(contacts.id, contactUsernames.contactId))
    .where(
      and(
        sql`lower(${contactUsernames.username}) = lower(${username})`,
        exceptId ? ne(contacts.id, exceptId) : undefined
      )
    );
  return rows[0];
}

async function assertFree(username: string | null, tgUserId: string | null, exceptId?: number) {
  if (username) {
    const taken = await findByUsername(username, exceptId);
    if (taken) {
      throw new AdInputError(`@${username} уже записан за контактом «${contactLabel(taken)}»`, 409, {
        contactId: taken.id,
      });
    }
  }
  if (tgUserId) {
    const rows = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.tgUserId, tgUserId), exceptId ? ne(contacts.id, exceptId) : undefined));
    if (rows[0]) {
      throw new AdInputError(`Telegram ID ${tgUserId} уже у контакта «${contactLabel(rows[0])}»`, 409, {
        contactId: rows[0].id,
      });
    }
  }
}

export async function createContact(input: { name?: unknown; username?: unknown; tgUserId?: unknown }) {
  const name = normalizeName(input.name);
  const username = normalizeUsername(input.username);
  const tgUserId = normalizeTgUserId(input.tgUserId);
  await assertFree(username, tgUserId);
  const [row] = await db.insert(contacts).values({ name, username, tgUserId }).returning();
  const prev = username ? await previousOwner(username, row.id) : undefined;
  return {
    contact: row,
    notice: prev
      ? `@${username} раньше был у контакта «${contactLabel(prev)}» — проверьте, что это другой человек`
      : null,
  };
}

/**
 * Renames a contact. A changed username moves the old one into the history;
 * taking back a username from the contact's own history just drops it from
 * there. Campaigns tied to the contact get the new label, so the Campaigns tab
 * shows the same name the ad section does.
 */
export async function updateContact(
  id: number,
  input: { name?: unknown; username?: unknown; tgUserId?: unknown }
) {
  const current = await getContact(id);
  if (!current) throw new AdInputError("Контакт не найден", 404);

  const name = input.name !== undefined ? normalizeName(input.name) : current.name;
  const username = input.username !== undefined ? normalizeUsername(input.username) : current.username;
  const tgUserId = input.tgUserId !== undefined ? normalizeTgUserId(input.tgUserId) : current.tgUserId;
  await assertFree(username, tgUserId, id);

  const usernameChanged = (username ?? "").toLowerCase() !== (current.username ?? "").toLowerCase();
  const prev = usernameChanged && username ? await previousOwner(username, id) : undefined;

  const updated = db.transaction((tx) => {
    if (usernameChanged) {
      if (current.username) {
        tx.insert(contactUsernames).values({ contactId: id, username: current.username }).run();
      }
      if (username) {
        tx.delete(contactUsernames)
          .where(
            and(
              eq(contactUsernames.contactId, id),
              sql`lower(${contactUsernames.username}) = lower(${username})`
            )
          )
          .run();
      }
    }
    const row = tx
      .update(contacts)
      .set({ name, username, tgUserId })
      .where(eq(contacts.id, id))
      .returning()
      .get();
    tx.update(campaigns)
      .set({ advertiser: contactLabel(row) })
      .where(eq(campaigns.contactId, id))
      .run();
    return row;
  });

  return {
    contact: updated,
    notice: prev
      ? `@${username} раньше был у контакта «${contactLabel(prev)}» — проверьте, что это другой человек`
      : null,
  };
}

/** Only a contact nobody has dealt with can go — deals must keep their counterparty. */
export async function deleteContact(id: number) {
  const current = await getContact(id);
  if (!current) throw new AdInputError("Контакт не найден", 404);
  const [b] = await db.select({ n: sql<number>`count(*)` }).from(adBuys).where(eq(adBuys.contactId, id));
  const [s] = await db.select({ n: sql<number>`count(*)` }).from(adSales).where(eq(adSales.contactId, id));
  if (Number(b.n) + Number(s.n) > 0) {
    throw new AdInputError("У контакта есть сделки — его нельзя удалить", 409);
  }
  db.transaction((tx) => {
    tx.update(campaigns).set({ contactId: null }).where(eq(campaigns.contactId, id)).run();
    tx.delete(contactUsernames).where(eq(contactUsernames.contactId, id)).run();
    tx.delete(contacts).where(eq(contacts.id, id)).run();
  });
  return { ok: true };
}

/**
 * The contact an old free-text campaign advertiser refers to, if there is one:
 * "@x" or "x" by username, otherwise by exact name among contacts without a
 * username. Never creates a contact — the bot's quick campaign form should not
 * be filling the address book behind the owner's back.
 */
export async function matchContactByAdvertiser(advertiser: string): Promise<number | null> {
  const text = advertiser.trim();
  if (!text) return null;
  const bare = text.replace(/^@/, "");
  if (USERNAME_RE.test(bare)) {
    const hit = await findByUsername(bare);
    if (hit) return hit.id;
  }
  if (text.startsWith("@")) return null;
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(sql`${contacts.username} IS NULL`, sql`lower_unicode(${contacts.name}) = lower_unicode(${text})`));
  return rows.length === 1 ? rows[0].id : null;
}

export async function contactsByIds(ids: number[]) {
  if (!ids.length) return new Map<number, typeof contacts.$inferSelect>();
  const rows = await db.select().from(contacts).where(inArray(contacts.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}
