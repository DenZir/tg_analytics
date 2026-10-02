/**
 * Keeps tracking cards current: every 5 minutes each live card is redrawn if
 * its numbers changed, and once the post's term is over the admin gets the
 * final result for exactly the time it stood — then the card freezes.
 *
 * The bot is passed in as a small sender, so the pass is tested without Telegram.
 */
import cron from "node-cron";
import { eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { adTrackLinks, adTrackViews } from "../db/schema.js";
import { cardInput, renderCard, renderFinal, termEnd } from "../services/adTrack.js";
import { refreshKeyboard, trackBot } from "../bots/trackBot.js";

export interface TrackSender {
  edit(chatId: string, messageId: number, text: string, trackId: number): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
}

/** Errors after which a card is not worth trying again: the chat or the message is gone. */
const GONE = /blocked|chat not found|message to edit not found|user is deactivated|kicked/i;

export async function refreshTrackCards(sender: TrackSender, now = new Date()) {
  const views = await db
    .select({ view: adTrackViews, link: adTrackLinks })
    .from(adTrackViews)
    .innerJoin(adTrackLinks, eq(adTrackLinks.id, adTrackViews.trackId))
    .where(isNull(adTrackViews.finalSentAt));
  let edited = 0, finals = 0;
  for (const { view, link } of views) {
    try {
      const live = await cardInput(link.buyId, now);
      if (!live) continue;
      const end = termEnd(live);
      if (end && now >= end) {
        // The final: counts as of the end of the term, not of this pass.
        const atEnd = (await cardInput(link.buyId, now, true))!;
        const card = renderCard({ ...atEnd, now, final: true });
        if (card !== view.lastText) await sender.edit(view.chatId, view.messageId, card, link.id);
        await sender.send(view.chatId, renderFinal(atEnd));
        db.update(adTrackViews).set({ lastText: card, finalSentAt: now }).where(eq(adTrackViews.id, view.id)).run();
        finals++;
        continue;
      }
      const card = renderCard(live);
      if (card !== view.lastText) {
        await sender.edit(view.chatId, view.messageId, card, link.id);
        db.update(adTrackViews).set({ lastText: card }).where(eq(adTrackViews.id, view.id)).run();
        edited++;
      }
    } catch (error: any) {
      const why = String(error?.description ?? error?.message ?? error);
      if (why.includes("not modified")) continue;
      if (GONE.test(why)) {
        // the admin blocked the bot or deleted the card — stop, there is nobody to show it to
        db.update(adTrackViews).set({ finalSentAt: now }).where(eq(adTrackViews.id, view.id)).run();
        continue;
      }
      console.warn(`[adTrack] Card ${view.id} not refreshed: ${why}`);
    }
  }
  return { edited, finals };
}

const botSender: TrackSender | null = trackBot
  ? {
      async edit(chatId, messageId, text, trackId) {
        await trackBot!.telegram.editMessageText(chatId, messageId, undefined, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: refreshKeyboard(trackId),
        } as any);
      },
      async send(chatId, text) {
        await trackBot!.telegram.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as any);
      },
    }
  : null;

let running = false;
cron.schedule("*/5 * * * *", async () => {
  if (!botSender || running) return;
  running = true;
  try {
    const r = await refreshTrackCards(botSender);
    if (r.edited || r.finals) console.log(`[adTrack] Cards refreshed: ${r.edited}, finals sent: ${r.finals}`);
  } catch (error) {
    console.error("[adTrack] Pass failed:", error);
  } finally {
    running = false;
  }
});
