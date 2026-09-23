/**
 * A project is a business, not a Telegram object.
 *
 * It owns up to two things: a channel people subscribe to, and a bot that
 * sells. Which of the two it has is what its type describes:
 *
 * `channel`          — channel only. Content, no sales of its own.
 * `bot_subscription` — channel + bot ("приватка"): ads bring people into the
 *                      channel, the bot sells them access to something more.
 * `bot_direct`       — bot only (the VPN). Nobody joins anything, so the funnel
 *                      starts where the conversation does: `/start`.
 *
 * It used to be one Telegram object per project, with a channel pointing at its
 * bot through `linkedProjectId`. That split one funnel — ad, subscriber, buyer —
 * across two rows: joins landed in the channel, purchases in whichever row the
 * buyer's history happened to point at, and "revenue of this privatka" had no
 * single place to live. With both halves in one project the funnel stays whole
 * and attribution never has to cross a project boundary.
 *
 * The type is therefore derived, never chosen: see deriveProjectType(). Storing
 * it keeps queries simple; recomputing it on every change keeps it honest.
 */
export const PROJECT_TYPES = {
  CHANNEL: "channel",
  BOT_SUBSCRIPTION: "bot_subscription",
  BOT_DIRECT: "bot_direct",
} as const;

export type ProjectType = (typeof PROJECT_TYPES)[keyof typeof PROJECT_TYPES];

export const PROJECT_TYPE_VALUES = Object.values(PROJECT_TYPES) as string[];

export function isProjectType(value: string): value is ProjectType {
  return PROJECT_TYPE_VALUES.includes(value);
}

/** Project kinds that sell something directly and therefore have revenue. */
export const SELLING_PROJECT_TYPES: string[] = [
  PROJECT_TYPES.BOT_SUBSCRIPTION,
  PROJECT_TYPES.BOT_DIRECT,
];

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  [PROJECT_TYPES.CHANNEL]: "Канал",
  [PROJECT_TYPES.BOT_SUBSCRIPTION]: "Приватка",
  [PROJECT_TYPES.BOT_DIRECT]: "Бот без канала",
};

/** Anything with a Telegram chat id has a channel of its own. */
export function hasChannel(p: { telegramChatId?: string | null }): boolean {
  return !!p.telegramChatId;
}

/** Anything with a bot username sells through a bot. */
export function hasBot(p: { botUsername?: string | null }): boolean {
  return !!p.botUsername;
}

/**
 * The one place a project's type is decided — from what it actually contains.
 *
 * A project with neither half is still a channel by default: that is what a
 * brand-new, not-yet-configured entry most often turns out to be, and it keeps
 * the column non-null without inventing a fourth kind.
 */
export function deriveProjectType(p: {
  telegramChatId?: string | null;
  botUsername?: string | null;
}): ProjectType {
  if (hasChannel(p) && hasBot(p)) return PROJECT_TYPES.BOT_SUBSCRIPTION;
  if (hasBot(p)) return PROJECT_TYPES.BOT_DIRECT;
  return PROJECT_TYPES.CHANNEL;
}
