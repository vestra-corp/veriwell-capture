import { describe, expect, it } from "vitest";
import { advanceStableHold, EMPTY_HOLD, type StableHoldState } from "../src/stable-hold.js";

describe("advanceStableHold", () => {
  it("keeps a countdown stable through brief landmark-tracking flicker", () => {
    let state: StableHoldState = EMPTY_HOLD;
    state = advanceStableHold(state, true, 1_000);
    state = advanceStableHold(state, false, 1_250);
    state = advanceStableHold(state, true, 1_500);
    expect(state).toEqual({ startedAt: 1_000, lastReadyAt: 1_500 });
  });

  it("resets after guidance has genuinely been lost", () => {
    let state: StableHoldState = EMPTY_HOLD;
    state = advanceStableHold(state, true, 1_000);
    state = advanceStableHold(state, false, 3_600);
    expect(state).toEqual({ startedAt: null, lastReadyAt: null });
  });

  it("honours a custom grace period", () => {
    let state = advanceStableHold(EMPTY_HOLD, true, 1_000, 500);
    state = advanceStableHold(state, false, 1_400, 500);
    expect(state.startedAt).toBe(1_000);
    state = advanceStableHold(state, false, 1_600, 500);
    expect(state.startedAt).toBeNull();
  });
});
