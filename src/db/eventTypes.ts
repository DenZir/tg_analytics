export const EVENT_TYPES = {
  JOIN: "join",
  LEAVE: "leave",
  LEAD: "lead",
  TRIAL_START: "trial_start",
  PAYMENT: "payment",
  RENEWAL: "renewal",
  CHURN: "churn",
  JOIN_REQUEST: "join_request",
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * How an event was attributed — recorded on the row rather than inferred from
 * which id happens to be non-null, so a query can group by it directly and a
 * future fourth kind of attribution doesn't turn every report into a puzzle.
 *
 * `organic` is not a failure case. It is the honest answer for a buyer who
 * arrived without a tracked link, and counting those is the whole point: a
 * project where organic revenue quietly grows looks identical to a project
 * losing events, unless the two are told apart.
 */
export const EVENT_SOURCES = {
  LINK: "link",
  UTM: "utm",
  ORGANIC: "organic",
} as const;

export type EventSource = (typeof EVENT_SOURCES)[keyof typeof EVENT_SOURCES];

export const FUNNEL_ENTRY_TYPES = [
  EVENT_TYPES.JOIN,
  EVENT_TYPES.LEAD,
  EVENT_TYPES.TRIAL_START,
] as const;
