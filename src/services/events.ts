import { db } from "../db/index.js";
import { events, links, campaigns, projects, utmLinks } from "../db/schema.js";
import { eq, desc, inArray } from "drizzle-orm";
import { EVENT_SOURCES, type EventSource } from "../db/eventTypes.js";
import { aggregate } from "../jobs/dailyAggregate.js";

export interface LogEventInput {
  /**
   * Which project the event belongs to. Optional only because it can usually be
   * derived — from the link, the UTM slug, the user's own history, or the bot
   * username. Callers that know it should always send it: it is the one field
   * that makes an unattributed event recordable instead of lost.
   */
  projectId?: number;
  linkId?: number;
  utmLinkId?: number;
  /** Fallback route to the project for bots that don't track project ids. */
  botUsername?: string;
  tgUserId: string;
  eventType: string;
  amount?: number;
  ts?: Date;
  languageCode?: string;
  promoCode?: string;
  discountAmount?: number;
}

/**
 * Thrown only when an event cannot be placed in any project at all — no link,
 * no UTM slug, no history for this user and no bot we recognise. It is not the
 * "unattributed traffic" case: that one is recorded as organic.
 */
export class UnplaceableEventError extends Error {
  constructor(tgUserId: string) {
    super(
      `Cannot place event for tgUserId ${tgUserId}: no projectId, linkId, utmLinkId, ` +
        `known botUsername, or prior event to inherit a project from.`
    );
    this.name = "UnplaceableEventError";
  }
}

interface Placement {
  projectId: number;
  linkId: number | null;
  utmLinkId: number | null;
  source: EventSource;
}

/**
 * Works out which project an event belongs to and whether anything attributes
 * it, trying the most specific signal first.
 *
 * The order matters. An explicit link or slug on this very event beats the
 * user's history, because it describes what just happened rather than what
 * happened last time. History beats the bare bot username for the same reason
 * in reverse: a returning buyer should keep the campaign that brought them.
 *
 * Only the last step can fail, and it fails loudly — everything else either
 * attributes the event or records it as organic.
 */
function place(tx: any, input: LogEventInput): Placement {
  if (input.linkId) {
    const row = tx
      .select({ projectId: campaigns.projectId })
      .from(links)
      .innerJoin(campaigns, eq(links.campaignId, campaigns.id))
      .where(eq(links.id, input.linkId))
      .limit(1)
      .all();
    if (row.length > 0) {
      return {
        projectId: row[0].projectId,
        linkId: input.linkId,
        utmLinkId: null,
        source: EVENT_SOURCES.LINK,
      };
    }
  }

  if (input.utmLinkId) {
    const row = tx
      .select({ projectId: utmLinks.projectId })
      .from(utmLinks)
      .where(eq(utmLinks.id, input.utmLinkId))
      .limit(1)
      .all();
    if (row.length > 0) {
      return {
        projectId: row[0].projectId,
        linkId: null,
        utmLinkId: input.utmLinkId,
        source: EVENT_SOURCES.UTM,
      };
    }
  }

  const lastTouch = tx
    .select({
      projectId: events.projectId,
      linkId: events.linkId,
      utmLinkId: events.utmLinkId,
      source: events.source,
    })
    .from(events)
    .where(eq(events.tgUserId, input.tgUserId))
    .orderBy(desc(events.ts), desc(events.id))
    .limit(1)
    .all();

  // A user's history only carries over inside the project the caller means. A
  // buyer who exists in two projects must not drag the first one's campaign
  // into the second one's revenue.
  if (lastTouch.length > 0 && (!input.projectId || lastTouch[0].projectId === input.projectId)) {
    return {
      projectId: lastTouch[0].projectId,
      linkId: lastTouch[0].linkId,
      utmLinkId: lastTouch[0].utmLinkId,
      source: lastTouch[0].source as EventSource,
    };
  }

  if (input.projectId) {
    return {
      projectId: input.projectId,
      linkId: null,
      utmLinkId: null,
      source: EVENT_SOURCES.ORGANIC,
    };
  }

  if (input.botUsername) {
    const row = tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.botUsername, input.botUsername.replace(/^@/, "")))
      .orderBy(projects.id)
      .limit(1)
      .all();
    if (row.length > 0) {
      return {
        projectId: row[0].id,
        linkId: null,
        utmLinkId: null,
        source: EVENT_SOURCES.ORGANIC,
      };
    }
  }

  throw new UnplaceableEventError(input.tgUserId);
}

export async function logEvent(input: LogEventInput) {
  try {
    const insertedEvent = db.transaction((tx) => {
      const placement = place(tx, input);

      return tx
        .insert(events)
        .values({
          projectId: placement.projectId,
          linkId: placement.linkId,
          utmLinkId: placement.utmLinkId,
          source: placement.source,
          tgUserId: input.tgUserId,
          eventType: input.eventType,
          amount: input.amount ?? 0,
          promoCode: input.promoCode ?? null,
          discountAmount: input.discountAmount ?? 0,
          languageCode: input.languageCode ?? null,
          ts: input.ts ?? new Date(),
        })
        .returning()
        .get();
    });

    aggregate().catch((err) => {
      console.error("[events] Failed to refresh daily aggregates:", err);
    });

    return insertedEvent;
  } catch (error: any) {
    // Unique constraint violation indicates duplicate update from Telegram API -> ignore silently
    if (
      error?.code === "SQLITE_CONSTRAINT" ||
      error?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      error?.message?.includes("UNIQUE constraint failed")
    ) {
      return null;
    }
    throw error;
  }
}

const DEFAULT_RECENT_EVENTS_LIMIT = 20;
const MAX_RECENT_EVENTS_LIMIT = 100;

export async function getRecentEvents(
  limit: number = DEFAULT_RECENT_EVENTS_LIMIT,
  projectIds?: number[]
) {
  const safeLimit = Math.min(Math.max(1, limit), MAX_RECENT_EVENTS_LIMIT);

  // Left joins throughout, and the project taken straight off the event rather
  // than through the campaign: an organic event has no link and no campaign,
  // and inner joins would drop exactly the rows this feed most needs to show.
  const query = db
    .select({
      id: events.id,
      eventType: events.eventType,
      tgUserId: events.tgUserId,
      amount: events.amount,
      ts: events.ts,
      source: events.source,
      linkId: links.id,
      linkLabel: links.label,
      telegramRef: links.telegramRef,
      linkType: links.linkType,
      campaignId: campaigns.id,
      advertiser: campaigns.advertiser,
      utmLinkId: utmLinks.id,
      utmLabel: utmLinks.label,
      utmSource: utmLinks.utmSource,
      utmCampaign: utmLinks.utmCampaign,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(events)
    .innerJoin(projects, eq(events.projectId, projects.id))
    .leftJoin(links, eq(events.linkId, links.id))
    .leftJoin(campaigns, eq(links.campaignId, campaigns.id))
    .leftJoin(utmLinks, eq(events.utmLinkId, utmLinks.id))
    .orderBy(desc(events.ts))
    .limit(safeLimit);

  if (projectIds && projectIds.length > 0) {
    return await query.where(inArray(events.projectId, projectIds));
  }

  return await query;
}
