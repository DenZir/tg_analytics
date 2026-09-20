/**
 * The kinds of project the analytics understands.
 *
 * `channel` — a Telegram channel people subscribe to. Entry into the funnel is
 * the join event.
 *
 * `bot_subscription` — a paid channel sold through a bot ("приватка"). The bot
 * takes the money, the channel holds the content.
 *
 * `bot_direct` — a bot that sells its own product with no channel behind it at
 * all (the VPN). Nobody ever joins anything, so its funnel starts where the
 * conversation does: `/start`.
 *
 * The distinction matters because every metric that used to divide by "channel
 * subscribers" has no denominator in a `bot_direct` project. Counting funnel
 * entries per project instead of channel joins per campaign gives all three
 * kinds a base that actually exists.
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
