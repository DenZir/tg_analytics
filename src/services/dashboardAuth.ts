import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { dashboardSessions } from "../db/schema.js";
import { eq, gt, and } from "drizzle-orm";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
    .set({ token: newToken })
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
