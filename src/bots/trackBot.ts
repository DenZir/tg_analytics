/**
 * The tracking bot («отслежка»): the face the section shows to admins I bought
 * places from. A separate bot from the channel bot on purpose — that one is my
 * private console and an admin in my channels; this one talks to strangers, and
 * if one of them blocks or reports it, nothing of mine goes down with it.
 *
 * It only shows cards: /start trk_<token> sends the card of that buy, «Обновить»
 * redraws it. jobs/adTrack.ts keeps the cards current and sends the final result.
 */
import { Telegraf } from "telegraf";
import { HttpsProxyAgent } from "https-proxy-agent";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { adTrackLinks, adTrackViews } from "../db/schema.js";
import { cardInput, renderCard } from "../services/adTrack.js";

const token = process.env.TRACK_BOT_TOKEN?.trim();
const proxyUrl = process.env.TELEGRAM_PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

export const trackBot = token ? new Telegraf(token, agent ? { telegram: { agent } } : undefined) : null;

let username: string | null = null;
/** The bot's @username once it is up — the dashboard builds the links from it. */
export const trackBotUsername = () => username;

export const refreshKeyboard = (trackId: number) => ({
  inline_keyboard: [[{ text: "🔄 Обновить", callback_data: `trk:r:${trackId}` }]],
});

if (trackBot) {
  trackBot.start(async (ctx) => {
    try {
      const payload = ctx.startPayload?.replace(/^trk_/, "");
      const link = payload ? await db.query.adTrackLinks.findFirst({ where: eq(adTrackLinks.token, payload) }) : undefined;
      if (!link) {
        await ctx.reply("Это бот отслежки рекламы. Откройте ссылку на отслежку, которую прислал закупщик.");
        return;
      }
      const input = await cardInput(link.buyId, new Date());
      if (!input) {
        await ctx.reply("Этого закупа больше нет — отслежка закрыта.");
        return;
      }
      const text = renderCard(input);
      const msg = await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: refreshKeyboard(link.id) } as any);
      // One card per person and buy: a second /start moves the live card to the new message.
      const chatId = String(ctx.chat.id);
      const existing = await db.query.adTrackViews.findFirst({ where: and(eq(adTrackViews.trackId, link.id), eq(adTrackViews.chatId, chatId)) });
      if (existing) {
        db.update(adTrackViews).set({ messageId: msg.message_id, lastText: text }).where(eq(adTrackViews.id, existing.id)).run();
      } else {
        db.insert(adTrackViews).values({ trackId: link.id, chatId, messageId: msg.message_id, lastText: text }).run();
      }
    } catch (error) {
      console.error("[trackBot] /start failed:", error);
      await ctx.reply("Не получилось открыть отслежку, попробуйте ещё раз чуть позже.").catch(() => {});
    }
  });

  trackBot.action(/^trk:r:(\d+)$/, async (ctx) => {
    try {
      const trackId = Number(ctx.match[1]);
      const link = await db.query.adTrackLinks.findFirst({ where: eq(adTrackLinks.id, trackId) });
      const view = link
        ? await db.query.adTrackViews.findFirst({ where: and(eq(adTrackViews.trackId, trackId), eq(adTrackViews.chatId, String(ctx.chat?.id))) })
        : undefined;
      const input = link ? await cardInput(link.buyId, new Date(), !!view?.finalSentAt) : null;
      if (!input) {
        await ctx.answerCbQuery("Этого закупа больше нет");
        return;
      }
      const text = renderCard({ ...input, final: !!view?.finalSentAt });
      if (text !== view?.lastText) {
        await ctx.editMessageText(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: refreshKeyboard(trackId) } as any);
        if (view) db.update(adTrackViews).set({ lastText: text }).where(eq(adTrackViews.id, view.id)).run();
      }
      await ctx.answerCbQuery("Обновлено");
    } catch (error: any) {
      // "message is not modified" — the numbers are the same, which is fine
      if (!String(error?.description ?? error?.message).includes("not modified")) console.error("[trackBot] refresh failed:", error);
      await ctx.answerCbQuery().catch(() => {});
    }
  });
}

export async function startTrackBot() {
  if (!trackBot) {
    console.log("[trackBot] Skipped start: TRACK_BOT_TOKEN is empty in .env");
    return;
  }
  try {
    const me = await trackBot.telegram.getMe();
    username = me.username ?? null;
    console.log(`[trackBot] @${username} ready`);
    await trackBot.launch({ allowedUpdates: ["message", "callback_query"] });
  } catch (error) {
    console.error("[trackBot] Launch error:", error);
  }
}
