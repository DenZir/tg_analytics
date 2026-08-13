import { db } from "../db/index.js";
import { events } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { aggregate } from "../jobs/dailyAggregate.js";

export interface LogEventInput {
  linkId?: number;
  tgUserId: string;
  eventType: string;
  amount?: number;
  ts?: Date;
}

export async function logEvent(input: LogEventInput) {
  let resolvedLinkId = input.linkId;

  if (!resolvedLinkId) {
    const lastTouch = await db
      .select({ linkId: events.linkId })
      .from(events)
      .where(eq(events.tgUserId, input.tgUserId))
      .orderBy(desc(events.ts), desc(events.id))
      .limit(1);

    if (lastTouch.length > 0 && lastTouch[0].linkId) {
      resolvedLinkId = lastTouch[0].linkId;
    } else {
      throw new Error(
        `Cannot attribute event: no prior touch found for tgUserId ${input.tgUserId}. First event for a new user must include linkId.`
      );
    }
  }

  try {
    const [insertedEvent] = await db
      .insert(events)
      .values({
        linkId: resolvedLinkId,
        tgUserId: input.tgUserId,
        eventType: input.eventType,
        amount: input.amount ?? 0,
        ts: input.ts ?? new Date(),
      })
      .returning();

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
