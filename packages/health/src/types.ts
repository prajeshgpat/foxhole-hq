export const SIGNAL_KINDS = [
  "loop",
  "error-streak",
  "stall",
  "long-wait",
  "zombie",
  "cache-drop",
  "collision",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export type Severity = "info" | "warn" | "alert";

/**
 * Detail values are counts and minutes. The one string is `otherSessionId` on collision signals,
 * which is an id already present in the events, never target text.
 */
export type SignalDetail = Readonly<Record<string, number | string>>;

export interface Signal {
  readonly kind: SignalKind;
  readonly sessionId: string;
  readonly severity: Severity;
  /** ISO timestamp of the event at which the condition began. */
  readonly since: string;
  readonly detail: SignalDetail;
}
