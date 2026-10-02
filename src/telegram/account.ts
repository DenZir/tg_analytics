/**
 * The Telegram account session — the analytics' own eyes on ad posts.
 *
 * Bots cannot read other people's channels; an account can, so the checker
 * looks at posts through one. It is a separate device of the owner's account,
 * logged in once with `npm run tg:login` (phone and code typed by the owner,
 * never stored) — not a copy of the posting bot's session, so revoking one
 * never takes the other down.
 *
 * Read-only by design: nothing here sends, edits or deletes anything.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { TelegramClient, proxyTransportFromUrl } from "@mtcute/node";

export const SESSION_PATH = process.env.TG_SESSION_PATH || "./tg-session/account.session";

export interface AccountConfig {
  apiId: number;
  apiHash: string;
  storage: string;
  proxy: string | null;
}

/** The config, or why there is none — the checker stays off rather than crashing the app. */
export function accountConfig(): { ok: true; cfg: AccountConfig } | { ok: false; reason: string } {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH?.trim();
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) {
    return { ok: false, reason: "не заданы TG_API_ID и TG_API_HASH" };
  }
  return {
    ok: true,
    cfg: { apiId, apiHash, storage: SESSION_PATH, proxy: process.env.TELEGRAM_PROXY_URL?.trim() || null },
  };
}

/**
 * Whether the session file holds a real login. A file alone means nothing: an
 * abandoned login leaves a handshake key behind but no user.
 */
export function hasLogin(storage: string): boolean {
  if (!fs.existsSync(storage)) return false;
  try {
    const db = new Database(storage, { readonly: true });
    try {
      return db.prepare("SELECT 1 FROM key_value WHERE key = 'current_user'").get() !== undefined;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function createClient(cfg: AccountConfig): TelegramClient {
  fs.mkdirSync(path.dirname(path.resolve(cfg.storage)), { recursive: true });
  return new TelegramClient({
    apiId: cfg.apiId,
    apiHash: cfg.apiHash,
    storage: cfg.storage,
    ...(cfg.proxy ? { transport: proxyTransportFromUrl(cfg.proxy) } : {}),
  });
}

/** One look at a post, as the checker needs it. */
export interface PostLook {
  present: boolean;
  date?: Date;
  views?: number | null;
  nextDate?: Date | null;
}

export interface PostReader {
  look(chat: string, messageId: number): Promise<PostLook>;
}

const sameChat = (chat: string, msgChat: { id: number; username?: string | null }) =>
  chat.startsWith("-") ? String(msgChat.id) === chat : (msgChat.username ?? "").toLowerCase() === chat.toLowerCase();

/**
 * Reader over a started client.
 *
 * A message is trusted only if it came from the chat that was asked for: mtcute
 * has been seen returning a message from another chat (see posting's PLAN.md,
 * 2026-09-13). Here a wrong message would mean a wrong verdict about someone's
 * post, so a mismatch is an error, not a result.
 */
export function clientReader(client: TelegramClient): PostReader {
  let dialogsWarmed = false;

  // A private channel is addressed by its id, and resolving an id needs the
  // channel's access hash — known only once the account has seen it in its
  // dialogs. Walk them once, then try again.
  const withPeer = async <T>(chat: string, fn: (peer: string | number) => Promise<T>): Promise<T> => {
    const peer = chat.startsWith("-") ? Number(chat) : chat;
    try {
      return await fn(peer);
    } catch (error: any) {
      if (dialogsWarmed || typeof peer !== "number") throw error;
      dialogsWarmed = true;
      for await (const _ of client.iterDialogs({ limit: 1000 })) {
        // iterating fills the peer cache; nothing to do with the dialogs themselves
      }
      return await fn(peer);
    }
  };

  return {
    async look(chat, messageId) {
      return withPeer(chat, async (peer) => {
        const [msg] = await client.getMessages(peer, [messageId]);
        if (!msg) return { present: false };
        if (!sameChat(chat, msg.chat as any) || msg.id !== messageId) {
          throw new Error(`Telegram вернул сообщение не из того канала (${msg.chat.id}/${msg.id})`);
        }
        // The next post in the channel: the first newer message that is not a
        // part of our own album.
        const newer = await client.getHistory(peer, { offset: { id: messageId, date: 0 }, reverse: true, limit: 10 });
        let nextDate: Date | null = null;
        for (const m of newer) {
          if (m.id <= messageId || !sameChat(chat, m.chat as any)) continue;
          if (msg.groupedIdUnique && m.groupedIdUnique === msg.groupedIdUnique) continue;
          if (m.isService) continue;
          if (!nextDate || m.date < nextDate) nextDate = m.date;
        }
        return { present: true, date: msg.date, views: msg.views ?? null, nextDate };
      });
    },
  };
}
