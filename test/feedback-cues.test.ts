import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureFeedback,
  feedbackEnabled,
  playCue,
  resetFeedback,
  setFeedbackEnabled,
  speak,
  subscribeFeedback,
} from "../src/feedback-cues.js";

function stubBrowser(stored: Record<string, string> = {}) {
  const vibrate = vi.fn();
  const cancel = vi.fn();
  const speakFn = vi.fn();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => { stored[key] = value; },
    },
    speechSynthesis: { cancel, speak: speakFn },
    setTimeout,
  });
  vi.stubGlobal("navigator", { vibrate });
  vi.stubGlobal("SpeechSynthesisUtterance", class {
    lang = "";
    rate = 1;
    constructor(public text: string) {}
  });
  return { stored, vibrate, cancel, speakFn };
}

describe("feedback cues", () => {
  beforeEach(() => resetFeedback());
  afterEach(() => vi.unstubAllGlobals());

  it("is silent and safe without a browser", () => {
    expect(feedbackEnabled()).toBe(false);
    expect(() => playCue("step")).not.toThrow();
    expect(() => speak("hello")).not.toThrow();
    expect(() => setFeedbackEnabled(false)).not.toThrow();
  });

  it("is on by default and vibrates with a cue", () => {
    const { vibrate } = stubBrowser();
    expect(feedbackEnabled()).toBe(true);
    playCue("lock");
    expect(vibrate).toHaveBeenCalledWith(15);
  });

  it("drops repeats of the same cue inside the gap", () => {
    const { vibrate } = stubBrowser();
    playCue("lock", 10_000);
    playCue("lock", 10_000);
    playCue("step", 10_000);
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it("remembers mute, notifies subscribers and stops speech", () => {
    const { stored, vibrate, cancel, speakFn } = stubBrowser();
    const listener = vi.fn();
    const unsubscribe = subscribeFeedback(listener);
    setFeedbackEnabled(false);
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(stored["veriwell-capture:sound"]).toBe("off");
    expect(cancel).toHaveBeenCalled();
    playCue("success");
    speak("Blink both eyes.");
    expect(vibrate).not.toHaveBeenCalled();
    expect(speakFn).not.toHaveBeenCalled();

    resetFeedback();
    expect(feedbackEnabled()).toBe(false);
  });

  it("speaks the instruction when enabled", () => {
    const { speakFn } = stubBrowser();
    speak("Turn your head to one side.");
    expect(speakFn).toHaveBeenCalledTimes(1);
    expect(speakFn.mock.calls[0]![0].text).toBe("Turn your head to one side.");
    expect(speakFn.mock.calls[0]![0].lang).toBe("en-GB");
  });

  it("uses the configured storage key and language", () => {
    const { stored, speakFn } = stubBrowser({ "my-app:sound": "off" });
    configureFeedback({ storageKey: "my-app:sound", lang: "de-DE" });
    expect(feedbackEnabled()).toBe(false);
    setFeedbackEnabled(true);
    expect(stored["my-app:sound"]).toBe("on");
    speak("Bitte lächeln.");
    expect(speakFn.mock.calls[0]![0].lang).toBe("de-DE");
  });
});
