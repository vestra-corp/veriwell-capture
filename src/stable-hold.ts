/**
 * A small state machine for "hold still for N ms, then capture" countdowns
 * that does not restart every time a detector flickers for a frame or two.
 *
 * @packageDocumentation
 */

/** Hold timer state. Start with {@link EMPTY_HOLD}. */
export interface StableHoldState {
  /** When the current hold started (same clock as `now`), or null when not holding. */
  startedAt: number | null;
  /** Last time the frame was ready, or null when not holding. */
  lastReadyAt: number | null;
}

/** The initial, not-holding state. */
export const EMPTY_HOLD: Readonly<StableHoldState> = Object.freeze({ startedAt: null, lastReadyAt: null });

/** Default grace period during which a not-ready frame does not reset the hold. */
export const DEFAULT_HOLD_GRACE_MS = 2_400;

/**
 * Advance the hold timer by one observation.
 *
 * - When `ready`, the hold starts (if it had not) and `lastReadyAt` moves to `now`.
 * - When not ready, the hold survives as long as the last ready frame was at
 *   most `graceMs` ago, so brief tracking flicker does not restart the countdown.
 * - Otherwise the hold resets.
 *
 * Check `next.startedAt === now` to detect the moment a hold begins (a good
 * time for a "lock" sound), and `now - next.startedAt >= holdMs` to capture.
 *
 * @param state - Previous state.
 * @param ready - Whether the current frame is ready.
 * @param now - Current time in ms (for example `performance.now()`).
 * @param graceMs - Flicker tolerance. Default {@link DEFAULT_HOLD_GRACE_MS}.
 */
export function advanceStableHold(
  state: StableHoldState,
  ready: boolean,
  now: number,
  graceMs = DEFAULT_HOLD_GRACE_MS,
): StableHoldState {
  if (ready) {
    return { startedAt: state.startedAt ?? now, lastReadyAt: now };
  }
  if (state.startedAt !== null && state.lastReadyAt !== null && now - state.lastReadyAt <= graceMs) {
    return state;
  }
  return { startedAt: null, lastReadyAt: null };
}
