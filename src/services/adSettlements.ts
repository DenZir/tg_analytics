/**
 * «Рассчитались» — settling up with a contact.
 *
 * Buys and sales with one person are netted against each other: what I bought
 * from them I owe, what they bought from me they owe. A settlement zeroes that
 * balance without touching a single deal — it records which operations it
 * closed, and the balance afterwards counts only the rest.
 *
 * The server decides what goes in, not the browser: an operation counts once it
 * is agreed or out ("agreed", "live", "done") and its amount is known. A CPM
 * deal still waiting for its views and anything only planned wait for the next
 * settlement. A sale package is one operation, however many channels it spans.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { adBuys, adSalePlaces, adSales, adSettlementItems, adSettlements } from "../db/schema.js";
import { AD_COMMITTED_STATUSES, type AdDealKind } from "../db/adTypes.js";
import { AdInputError, getContact } from "./adContacts.js";
import { amountOfBuy, amountOfSale } from "./adDeals.js";

const opKey = (kind: AdDealKind, id: number) => `${kind}:${id}`;

async function settledKeys(contactId: number): Promise<Set<string>> {
  const rows = await db
    .select({ kind: adSettlementItems.kind, dealId: adSettlementItems.dealId })
    .from(adSettlementItems)
    .innerJoin(adSettlements, eq(adSettlements.id, adSettlementItems.settlementId))
    .where(eq(adSettlements.contactId, contactId));
  return new Set(rows.map((r) => opKey(r.kind as AdDealKind, r.dealId)));
}

/** Operations with this contact that are owed and not yet settled. */
async function openOperations(contactId: number) {
  const closed = await settledKeys(contactId);
  const committed = AD_COMMITTED_STATUSES as string[];

  const buys = await db
    .select()
    .from(adBuys)
    .where(and(eq(adBuys.contactId, contactId), inArray(adBuys.status, committed)));
  const sales = await db
    .select()
    .from(adSales)
    .where(and(eq(adSales.contactId, contactId), inArray(adSales.status, committed)));
  const places = sales.length
    ? await db.select().from(adSalePlaces).where(inArray(adSalePlaces.saleId, sales.map((s) => s.id)))
    : [];

  const ops: Array<{ kind: AdDealKind; dealId: number; amount: number }> = [];
  for (const b of buys) {
    const amount = amountOfBuy(b);
    if (amount != null && !closed.has(opKey("buy", b.id))) ops.push({ kind: "buy", dealId: b.id, amount });
  }
  for (const s of sales) {
    const amount = amountOfSale(s, places.filter((p) => p.saleId === s.id));
    if (amount != null && !closed.has(opKey("sale", s.id))) ops.push({ kind: "sale", dealId: s.id, amount });
  }
  return ops;
}

/** Positive: I owe them. Negative: they owe me. */
const netOf = (ops: Array<{ kind: AdDealKind; amount: number }>) =>
  ops.reduce((s, o) => s + (o.kind === "buy" ? o.amount : -o.amount), 0);

export async function listSettlements(contactId: number) {
  const rows = await db
    .select()
    .from(adSettlements)
    .where(eq(adSettlements.contactId, contactId))
    .orderBy(adSettlements.createdAt, adSettlements.id);
  const items = rows.length
    ? await db.select().from(adSettlementItems).where(inArray(adSettlementItems.settlementId, rows.map((r) => r.id)))
    : [];
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    net: r.net,
    createdBy: r.createdBy,
    // The same ids the deal rows carry, so the browser can mark them «закрыто».
    ids: items
      .filter((i) => i.settlementId === r.id)
      .map((i) => (i.kind === "buy" ? `З-${i.dealId}` : `П-${i.dealId}`)),
  }));
}

export async function settleContact(contactId: number, adminId: string) {
  if (!(await getContact(contactId))) throw new AdInputError("Контакт не найден", 404);
  const ops = await openOperations(contactId);
  if (!ops.length) throw new AdInputError("Закрывать нечего — все операции уже в расчёте", 409);
  const net = Math.round(netOf(ops) * 100) / 100;

  const settlement = db.transaction((tx) => {
    const s = tx.insert(adSettlements).values({ contactId, net, createdBy: adminId }).returning().get();
    tx.insert(adSettlementItems)
      .values(ops.map((o) => ({ settlementId: s.id, kind: o.kind, dealId: o.dealId })))
      .run();
    return s;
  });
  return { settlement: { id: settlement.id, at: settlement.createdAt, net, count: ops.length } };
}

/**
 * Undoes a settlement. Only the latest one per contact: undoing an older one
 * would reopen operations that a later settlement's balance was computed
 * without, and its recorded "было" would stop meaning anything.
 */
export async function undoSettlement(id: number) {
  const s = await db.query.adSettlements.findFirst({ where: eq(adSettlements.id, id) });
  if (!s) throw new AdInputError("Расчёт не найден", 404);
  const [latest] = await db
    .select({ id: adSettlements.id })
    .from(adSettlements)
    .where(eq(adSettlements.contactId, s.contactId))
    .orderBy(desc(adSettlements.createdAt), desc(adSettlements.id))
    .limit(1);
  if (latest && latest.id !== id) throw new AdInputError("Отменить можно только последнее обнуление", 409);
  db.transaction((tx) => {
    tx.delete(adSettlementItems).where(eq(adSettlementItems.settlementId, id)).run();
    tx.delete(adSettlements).where(eq(adSettlements.id, id)).run();
  });
  return { ok: true, contactId: s.contactId };
}
