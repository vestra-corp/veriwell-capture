import { useSyncExternalStore } from "react";
import { feedbackEnabled, setFeedbackEnabled, subscribeFeedback } from "../feedback-cues.js";

/**
 * Current mute state plus a setter, kept in sync across every component that
 * uses it. Renders as enabled on the server.
 *
 * @example
 * ```tsx
 * const [soundOn, setSoundOn] = useFeedbackEnabled();
 * <button onClick={() => { if (!soundOn) unlockFeedback(); setSoundOn(!soundOn); }}>
 *   {soundOn ? "Mute" : "Unmute"}
 * </button>
 * ```
 */
export function useFeedbackEnabled(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribeFeedback, feedbackEnabled, () => true);
  return [value, setFeedbackEnabled];
}
