import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.js";
import { projects } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { channelBot } from "../bots/channelBot.js";
import { PROJECT_TYPES } from "../db/projectTypes.js";

/**
 * Project avatars, taken from Telegram.
 *
 * What is and isn't possible here is set by the Bot API, not by us. A channel
 * the bot administers answers `getChat` with a photo; another *bot* does not —
 * there is no call that returns a second bot's profile picture, and a username
 * alone is not enough. So a bot-backed project borrows the avatar of the
 * channel it sells access to, and anything left over falls back to a monogram
 * drawn by the dashboard.
 *
 * Results are cached on disk next to the database, because a Telegram round
 * trip per avatar per page render would be absurd for a picture that changes
 * once a year. Failures are cached too, for a shorter time: without that, a
 * project that simply has no photo would re-ask Telegram on every render.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

function cacheDir(): string {
  const dbPath = process.env.DB_PATH || "./analytics.dev.db";
  const dir = path.join(path.dirname(path.resolve(dbPath)), "avatars");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cachePaths(projectId: number) {
  const dir = cacheDir();
  return {
    image: path.join(dir, `${projectId}.jpg`),
    miss: path.join(dir, `${projectId}.miss`),
  };
}

function freshEnough(file: string, ttlMs: number): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

/**
 * Which Telegram chat's picture represents this project.
 *
 * A channel speaks for itself. A bot project has no chat of its own, so it
 * borrows from the channel that points at it — the link the admin already drew
 * on the Проекты screen, read backwards.
 */
async function resolveChatId(projectId: number): Promise<string | null> {
  const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return null;
  if (project.telegramChatId) return project.telegramChatId;

  const linkedChannel = await db
    .select({ telegramChatId: projects.telegramChatId })
    .from(projects)
    .where(eq(projects.linkedProjectId, projectId))
    .get();

  return linkedChannel?.telegramChatId ?? null;
}

async function downloadFromTelegram(chatId: string): Promise<Buffer | null> {
  if (!channelBot) return null;

  const chat = await channelBot.telegram.getChat(chatId);
  // `small_file_id` is the 160×160 variant — plenty for a 22px circle, and a
  // fraction of the bytes of the big one.
  const fileId = (chat as { photo?: { small_file_id?: string } }).photo?.small_file_id;
  if (!fileId) return null;

  const file = await channelBot.telegram.getFile(fileId);
  if (!file.file_path) return null;

  const token = process.env.CHANNEL_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Returns the project's avatar as JPEG bytes, or null when there is none to be
 * had. Never throws: a missing avatar is a cosmetic detail, and the dashboard
 * draws a monogram instead.
 */
export async function getProjectAvatar(projectId: number): Promise<Buffer | null> {
  const { image, miss } = cachePaths(projectId);

  if (freshEnough(image, CACHE_TTL_MS)) {
    try {
      return fs.readFileSync(image);
    } catch {
      // Unreadable cache entry: fall through and fetch it again.
    }
  }
  if (freshEnough(miss, MISS_TTL_MS)) return null;

  try {
    const chatId = await resolveChatId(projectId);
    const buffer = chatId ? await downloadFromTelegram(chatId) : null;

    if (buffer) {
      fs.writeFileSync(image, buffer);
      try {
        fs.rmSync(miss, { force: true });
      } catch {
        /* ничего страшного */
      }
      return buffer;
    }

    fs.writeFileSync(miss, "");
    return null;
  } catch (err) {
    console.error(`[avatars] Failed to fetch the avatar for project ${projectId}:`, err);
    // A network blip shouldn't be remembered for an hour, but a stale picture
    // is better than none: serve whatever is on disk, however old.
    try {
      return fs.readFileSync(image);
    } catch {
      return null;
    }
  }
}

/** True for projects whose own chat can have a picture at all. */
export function canHaveOwnAvatar(projectType: string): boolean {
  return projectType === PROJECT_TYPES.CHANNEL;
}
