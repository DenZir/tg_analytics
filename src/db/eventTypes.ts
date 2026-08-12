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

export const FUNNEL_ENTRY_TYPES = [
  EVENT_TYPES.JOIN,
  EVENT_TYPES.LEAD,
  EVENT_TYPES.TRIAL_START,
] as const;
