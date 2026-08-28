import { desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { adminActions } from "../db/schema.js";

export async function logAdminAction(
  adminId: string,
  action: string,
  targetType: string,
  targetId: number,
  details?: string | null
) {
  await db.insert(adminActions).values({
    adminId,
    action,
    targetType,
    targetId,
    details: details ?? null,
  });
}

export async function getRecentAdminActions(limit = 50) {
  return db.select().from(adminActions).orderBy(desc(adminActions.ts)).limit(limit);
}
