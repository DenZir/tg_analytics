import { Telegraf } from "telegraf";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getLinkByRef } from "../services/campaigns.js";
import { logEvent } from "../services/events.js";
import { EVENT_TYPES } from "../db/eventTypes.js";

const token = process.env.PRIV_BOT_TOKEN;
const proxyUrl = process.env.TELEGRAM_PROXY_URL;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

export const privBot = token
  ? new Telegraf(token, agent ? { telegram: { agent } } : undefined)
  : null;

if (privBot) {
  privBot.start(async (ctx) => {
    try {
      const payload = ctx.startPayload;
      if (payload) {
        let link = await getLinkByRef(payload);
        if (!link) {
          // Fallback search if telegramRef includes payload
          link = await getLinkByRef(`https://t.me/${ctx.botInfo.username}?start=${payload}`);
        }

        if (link) {
          await logEvent({
            linkId: link.id,
            tgUserId: String(ctx.from.id),
            eventType: EVENT_TYPES.LEAD,
            languageCode: ctx.from.language_code,
          });
          console.log(`[privBot] Logged lead event for user ${ctx.from.id}`);
        }
      }
      await ctx.reply("Welcome! Your lead has been tracked.");
    } catch (error) {
      console.error("[privBot] Error handling start payload:", error);
    }
  });
}

export async function startPrivBot() {
  if (!privBot) {
    console.log("[privBot] Skipped start: PRIV_BOT_TOKEN is empty in .env");
    return;
  }
  try {
    await privBot.launch();
    console.log("[privBot] Bot started successfully.");
  } catch (error) {
    console.error("[privBot] Launch error:", error);
  }
}
