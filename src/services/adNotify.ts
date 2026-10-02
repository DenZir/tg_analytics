/**
 * Telling the admins about a problem with an ad post, through the channel bot.
 *
 * One message per deal and check pass, listing only the warnings that are new;
 * jobs/adChecks.ts remembers what was sent, so a post deleted early is reported
 * once, not every five minutes.
 */
import { channelBot } from "../bots/channelBot.js";
import { getAdminIds } from "../config/admins.js";
import type { AdSlot } from "../db/adTypes.js";
import type { Warn } from "./adPosts.js";

const SLOT_LABEL: Record<AdSlot, string> = {
  morning: "Утро",
  day: "День",
  evening: "Вечер",
  night: "Ночь",
  stories: "Сторис",
  n9: "Нейтрал на 9",
  n17: "Нейтрал на 17",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "14 ч 20 мин" */
export function duration(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} ч${m ? ` ${m} мин` : ""}` : `${m} мин`;
}

/** The same wording the dashboard uses for each warning. */
export function warnLine(w: Warn): string {
  const d = w.data ?? {};
  switch (w.code) {
    case "early":
      return `пост удалён раньше срока — продержался ${duration(Number(d.lived))}, <b>не хватило ${duration(Number(d.short))}</b>`;
    case "top":
      return `не простоял час в топе — <b>не хватило ${d.short} мин</b>`;
    case "late":
      return `вышел в <b>${d.fact}</b> вместо ${d.plan}`;
    case "cpmfail":
      return "CPM: пост снят до фиксации — сумма посчитана по последнему замеру";
    case "noclicks":
      return "пост вышел больше 3 часов назад, а заходов по ссылке нет";
    case "notout":
      return `пост не вышел — прошло ${duration(Number(d.after))} после времени места`;
    case "nopost":
      return "место прошло, а ссылки на пост нет — проверка его не видит";
    case "nolook":
      return `не удаётся проверить пост: ${esc(String(d.reason ?? ""))}`;
  }
}

/** Whether at least one admin got it — only then is the warning marked as sent. */
export async function notifyAdmins(header: string, date: string, slot: AdSlot, lines: string[], dealId: string): Promise<boolean> {
  if (!channelBot) return false;
  const admins = getAdminIds();
  if (!admins.length) return false;
  const [, m, d] = date.split("-");
  const text = `${header}\n${d}.${m} · ${SLOT_LABEL[slot]}\n\n${lines.map((l) => `• ${l}`).join("\n")}`;
  const base = (process.env.DASHBOARD_URL || "").replace(/\/+$/, "");
  // Telegram refuses buttons that point at localhost; a dev setup gets the text alone.
  const url = base && !/\/\/(localhost|127\.)/.test(base) ? `${base}/ads.html?deal=${encodeURIComponent(dealId)}` : null;
  let delivered = false;
  for (const id of admins) {
    try {
      await channelBot.telegram.sendMessage(id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(url ? { reply_markup: { inline_keyboard: [[{ text: "Открыть в дашборде", url }]] } } : {}),
      } as any);
      delivered = true;
    } catch (error) {
      console.error(`[adNotify] Failed to notify admin ${id} about ${dealId}:`, error);
    }
  }
  return delivered;
}
