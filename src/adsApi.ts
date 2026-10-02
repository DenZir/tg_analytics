/**
 * /api/ads — the ad section: contacts, buys, sales, settlements.
 *
 * Mounted behind the same /api auth as everything else. Validation lives in
 * the services; a refusal there is an AdInputError carrying its HTTP status
 * and a message meant for the owner, which is passed through as is.
 */
import express from "express";
import { AD_SLOTS, AD_SLOT_TIME } from "./db/adTypes.js";
import {
  AdInputError,
  createContact,
  deleteContact,
  listContacts,
  updateContact,
} from "./services/adContacts.js";
import {
  attachBuyLink,
  createBuy,
  createSale,
  deleteBuy,
  deleteSale,
  listAdProjects,
  listDeals,
  setMandatorySlots,
  updateBuy,
  updateSale,
  type InviteMinter,
} from "./services/adDeals.js";
import { listSettlements, settleContact, undoSettlement } from "./services/adSettlements.js";
import { logAdminAction } from "./services/auditLog.js";
import { checkerStatus } from "./jobs/adChecks.js";

type Handler = (req: express.Request, res: express.Response) => Promise<unknown>;

export function createAdsRouter(opts: {
  getAdminId: (req: express.Request) => Promise<string>;
  mintInvite: InviteMinter | null;
}) {
  const r = express.Router();

  const wrap = (fn: Handler) => async (req: express.Request, res: express.Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (error: any) {
      if (error instanceof AdInputError) {
        res.status(error.status).json({ error: error.message, ...error.details });
        return;
      }
      console.error(`[ads] ${req.method} ${req.originalUrl} failed:`, error);
      res.status(500).json({ error: error?.message ?? "Internal error" });
    }
  };

  const idParam = (req: express.Request) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new AdInputError("Неверный id");
    return id;
  };

  /** Audit trail for every change; a failure to log never undoes the change. */
  const audit = async (req: express.Request, action: string, type: string, id: number, details?: unknown) => {
    try {
      await logAdminAction(await opts.getAdminId(req), action, type, id, details ? JSON.stringify(details) : null);
    } catch (error) {
      console.error(`[ads] Failed to log ${action} for ${type} ${id}:`, error);
    }
  };

  const body = (req: express.Request) =>
    (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

  // Everything the section needs to start: channels, contacts, slot vocabulary.
  r.get(
    "/bootstrap",
    wrap(async () => ({
      projects: await listAdProjects(),
      contacts: await listContacts(),
      slots: AD_SLOTS,
      slotTimes: AD_SLOT_TIME,
      canMintInvites: !!opts.mintInvite,
      // is the post checker on (account session), and if not, why
      checker: checkerStatus(),
    }))
  );

  r.get(
    "/deals",
    wrap(async (req) => {
      const q = req.query;
      return listDeals({
        from: typeof q.from === "string" ? q.from : undefined,
        to: typeof q.to === "string" ? q.to : undefined,
        contactId: Number(q.contactId) || undefined,
      });
    })
  );

  r.put(
    "/projects/:id/mandatory-slots",
    wrap(async (req) => {
      const id = idParam(req);
      const slots = await setMandatorySlots(id, body(req).slots);
      await audit(req, "ad_mandatory_slots", "project", id, { slots });
      return { slots };
    })
  );

  // --- contacts ---

  r.get("/contacts", wrap(async () => listContacts()));

  r.post(
    "/contacts",
    wrap(async (req, res) => {
      const out = await createContact(body(req));
      await audit(req, "ad_contact_create", "contact", out.contact.id);
      res.status(201);
      return out;
    })
  );

  r.patch(
    "/contacts/:id",
    wrap(async (req) => {
      const id = idParam(req);
      const out = await updateContact(id, body(req));
      await audit(req, "ad_contact_update", "contact", id, body(req));
      return out;
    })
  );

  r.delete(
    "/contacts/:id",
    wrap(async (req) => {
      const id = idParam(req);
      const out = await deleteContact(id);
      await audit(req, "ad_contact_delete", "contact", id);
      return out;
    })
  );

  // Everything with one person, for the «Операции» view: all deals both ways
  // and the settlements made so far. The balance is computed from these in
  // the browser, with the same rule the server uses when settling.
  r.get(
    "/contacts/:id/ops",
    wrap(async (req) => {
      const id = idParam(req);
      const [deals, settlements] = await Promise.all([listDeals({ contactId: id }), listSettlements(id)]);
      return { ...deals, settlements };
    })
  );

  r.post(
    "/contacts/:id/settlements",
    wrap(async (req, res) => {
      const id = idParam(req);
      const out = await settleContact(id, await opts.getAdminId(req));
      await audit(req, "ad_settle", "contact", id, out.settlement);
      res.status(201);
      return out;
    })
  );

  r.delete(
    "/settlements/:id",
    wrap(async (req) => {
      const id = idParam(req);
      const out = await undoSettlement(id);
      await audit(req, "ad_settle_undo", "contact", out.contactId, { settlementId: id });
      return out;
    })
  );

  // --- buys ---

  r.post(
    "/buys",
    wrap(async (req, res) => {
      const out = await createBuy(body(req), opts.mintInvite);
      await audit(req, "ad_buy_create", "ad_buy", out.buy.id);
      res.status(201);
      return out;
    })
  );

  r.patch(
    "/buys/:id",
    wrap(async (req) => {
      const id = idParam(req);
      const out = await updateBuy(id, body(req));
      await audit(req, "ad_buy_update", "ad_buy", id, body(req));
      return out;
    })
  );

  // { readyLink } attaches a pasted link; an empty body mints a new one.
  r.post(
    "/buys/:id/link",
    wrap(async (req) => {
      const id = idParam(req);
      const out = await attachBuyLink(id, body(req).readyLink, opts.mintInvite);
      await audit(req, "ad_buy_link", "ad_buy", id);
      return out;
    })
  );

  r.delete(
    "/buys/:id",
    wrap(async (req) => {
      const id = idParam(req);
      const out = await deleteBuy(id, await opts.getAdminId(req));
      await audit(req, "ad_buy_delete", "ad_buy", id);
      return out;
    })
  );

  // --- sales ---

  r.post(
    "/sales",
    wrap(async (req, res) => {
      const out = await createSale(body(req));
      await audit(req, "ad_sale_create", "ad_sale", out.sale.id);
      res.status(201);
      return out;
    })
  );

  r.patch(
    "/sales/:id",
    wrap(async (req) => {
      const id = idParam(req);
      const out = await updateSale(id, body(req));
      await audit(req, "ad_sale_update", "ad_sale", id, body(req));
      return out;
    })
  );

  r.delete(
    "/sales/:id",
    wrap(async (req) => {
      const id = idParam(req);
      const out = await deleteSale(id);
      await audit(req, "ad_sale_delete", "ad_sale", id);
      return out;
    })
  );

  return r;
}
