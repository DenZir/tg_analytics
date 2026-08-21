// Multi-admin allowlist, replacing the old single ADMIN_CHAT_ID env var.
// ADMIN_TG_IDS is a comma-separated list of Telegram user IDs.

export function getAdminIds(): string[] {
  const raw = process.env.ADMIN_TG_IDS || "";
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

// An empty/unset admin list denies everyone rather than falling back to
// "allow everyone" — this is a deliberate, safer default than the old
// ADMIN_CHAT_ID behavior (which skipped the check entirely when unset).
export function isAdmin(tgUserId: string | number | undefined | null): boolean {
  if (tgUserId === undefined || tgUserId === null) return false;
  return getAdminIds().includes(String(tgUserId));
}
