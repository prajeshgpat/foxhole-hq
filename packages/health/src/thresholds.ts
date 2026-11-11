/** Starting points from docs/PLAN.md section 8.3. Tune against real sessions. */
export interface Thresholds {
  /** Identical (tool, target) tool.start events in a row that count as a loop. */
  readonly loopRepeatCount: number;
  /** Consecutive tool.start events inspected for an A-B-A-B alternation. */
  readonly loopAlternationLength: number;
  /**
   * A repeated command (Bash) that did not report a failure only counts as a loop at
   * loopRepeatCount plus this many repeats.
   */
  readonly loopPassingRepeatExtra: number;
  /** Failed tool.end events in a row. */
  readonly errorStreakLength: number;
  /** Number of latest tool.end events the failure ratio is computed over (also the minimum needed). */
  readonly errorRatioWindow: number;
  /** The ratio rule fires when failures are strictly more than this share of the window. */
  readonly errorRatioShare: number;
  readonly stallMinutes: number;
  readonly longWaitMinutes: number;
  readonly zombieMinutes: number;
  /** Earlier turns with usage required before cache-drop can be judged. */
  readonly cacheDropMinEarlierTurns: number;
  /** Latest cache-read share must be strictly below this fraction of the earlier mean. */
  readonly cacheDropFraction: number;
  /** Cache-drop compares a turn with the previous turn only when they ended this close together. */
  readonly cacheTurnWindowMinutes: number;
  readonly collisionWindowMinutes: number;
  /** A signal escalates from warn to alert at this multiple of its time or count threshold. */
  readonly alertMultiple: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({
  loopRepeatCount: 3,
  loopAlternationLength: 6,
  loopPassingRepeatExtra: 2,
  errorStreakLength: 3,
  errorRatioWindow: 10,
  errorRatioShare: 0.5,
  stallMinutes: 10,
  longWaitMinutes: 5,
  zombieMinutes: 120,
  cacheDropMinEarlierTurns: 3,
  cacheDropFraction: 0.5,
  cacheTurnWindowMinutes: 5,
  collisionWindowMinutes: 30,
  alertMultiple: 2,
});

/** Merges overrides onto the defaults without mutating either. Undefined override values are ignored. */
export function resolveThresholds(overrides?: Partial<Thresholds>): Thresholds {
  const defined = Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined);
  return Object.freeze({ ...DEFAULT_THRESHOLDS, ...Object.fromEntries(defined) });
}
