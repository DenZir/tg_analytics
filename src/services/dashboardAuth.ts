import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../db/index.js";
import { dashboardSessions } from "../db/schema.js";
import { eq, gt, and } from "drizzle-orm";

export const SESSION_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

// Creates a fresh one-time login token for an already-verified admin
// Telegram user, to be sent back to them as a dashboard login link.
export async function createLoginToken(tgUserId: string): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(dashboardSessions).values({
    token,
    tgUserId,
    expiresAt,
  });

  return token;
}

// Looks up a token; if valid, rotates it to a new token (so the original
// one-time link can't be replayed) and returns the new token. Returns null
// if the token is unknown or expired.
export async function redeemAndRotateToken(token: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(dashboardSessions)
    .where(eq(dashboardSessions.token, token))
    .limit(1);

  const session = rows[0];
  if (!session || session.expiresAt.getTime() < Date.now()) {
    return null;
  }

  const newToken = generateToken();
  await db
    .update(dashboardSessions)
    .set({ token: newToken, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .where(eq(dashboardSessions.id, session.id));

  return newToken;
}

// Looks up an unexpired session by its current token, returning the
// associated admin's Telegram user ID, or null if not found/expired.
export async function getSessionTgUserId(token: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(dashboardSessions)
    .where(and(eq(dashboardSessions.token, token), gt(dashboardSessions.expiresAt, new Date())))
    .limit(1);

  return rows[0]?.tgUserId ?? null;
}

// Telegram Login Widget hands the browser a signed profile payload and
// redirects here with it in the query string. Every field is attacker-
// controllable, so the `hash` is the ONLY thing that makes this trustworthy:
// it's an HMAC-SHA256 of the sorted "key=value" payload, keyed by the SHA-256
// of the bot token — a secret only Telegram and this server hold. Without
// this check anyone could simply request /auth/telegram?id=<an admin id>.
const TELEGRAM_LOGIN_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

export type TelegramLoginResult =
  | { ok: true; tgUserId: string }
  | { ok: false; reason: string };

export function verifyTelegramLogin(
  params: Record<string, string>,
  botToken: string
): TelegramLoginResult {
  const { hash, ...rest } = params;

  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: "missing or malformed hash" };
  if (!rest.id) return { ok: false, reason: "missing id" };
  if (!rest.auth_date) return { ok: false, reason: "missing auth_date" };

  const dataCheckString = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("\n");

  const secretKey = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(hash.toLowerCase(), "hex");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: "signature mismatch" };
  }

  // Replay guard: without it a captured callback URL would log someone in
  // forever, since the signature itself never expires.
  const authDateMs = Number(rest.auth_date) * 1000;
  if (!Number.isFinite(authDateMs) || Date.now() - authDateMs > TELEGRAM_LOGIN_MAX_AGE_MS) {
    return { ok: false, reason: "auth_date too old" };
  }

  return { ok: true, tgUserId: String(rest.id) };
}
