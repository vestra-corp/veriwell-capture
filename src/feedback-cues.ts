/**
 * Sound, voice and vibration cues for capture flows.
 *
 * During head turns the user cannot read the screen, so every state change
 * that matters is also audible: a soft tick when a pose locks on, a rising
 * chime when a frame is captured and the next step starts, and a spoken
 * instruction for that step.
 *
 * Tones are synthesised with Web Audio (no audio files). Browsers only allow
 * sound after a user gesture, so call {@link unlockFeedback} from the tap that
 * starts the camera. Everything is a silent no-op outside a browser or when the
 * user has muted feedback.
 *
 * @packageDocumentation
 */

/** A feedback cue. */
export type Cue = "lock" | "step" | "shutter" | "success" | "failure";

/** Global feedback settings. */
export interface FeedbackConfig {
  /** localStorage key that remembers the mute choice. Default `"veriwell-capture:sound"`. */
  storageKey: string;
  /** BCP 47 language for spoken prompts. Default `"en-GB"`. */
  lang: string;
  /** Speech rate. Default 1.05. */
  rate: number;
}

const DEFAULT_CONFIG: FeedbackConfig = { storageKey: "veriwell-capture:sound", lang: "en-GB", rate: 1.05 };

/** Vibration pattern (ms) used for each cue on devices that support it. */
export const CUE_VIBRATION: Readonly<Record<Cue, number | readonly number[]>> = Object.freeze({
  lock: 15,
  step: [30, 40, 30],
  shutter: 25,
  success: [40, 60, 80],
  failure: 140,
});

let config: FeedbackConfig = { ...DEFAULT_CONFIG };
let context: AudioContext | null = null;
let enabled: boolean | null = null;
let lastCueAt: Partial<Record<Cue, number>> = {};
const listeners = new Set<() => void>();

/** Change the storage key, speech language or rate. Call before first use. */
export function configureFeedback(options: Partial<FeedbackConfig>): void {
  config = { ...config, ...options };
  enabled = null;
}

function readEnabled(): boolean {
  if (enabled !== null) return enabled;
  enabled = true;
  try {
    if (window.localStorage.getItem(config.storageKey) === "off") enabled = false;
  } catch {
    // Storage can be blocked (private mode); feedback stays on.
  }
  return enabled;
}

/** Whether sound, speech and vibration are on. Always false outside a browser. */
export function feedbackEnabled(): boolean {
  return typeof window !== "undefined" && readEnabled();
}

/** Turn feedback on or off and remember the choice in localStorage. Muting stops current speech. */
export function setFeedbackEnabled(value: boolean): void {
  enabled = value;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(config.storageKey, value ? "on" : "off");
  } catch {
    // Not persisted; still applies for this page.
  }
  if (!value) window.speechSynthesis?.cancel();
  listeners.forEach((listener) => listener());
}

/**
 * Subscribe to mute/unmute changes. Returns an unsubscribe function.
 * (Compatible with React's `useSyncExternalStore`.)
 */
export function subscribeFeedback(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Prepare audio and speech. Call this synchronously from a tap/click handler
 * (for example the "Enable camera" button): iOS Safari and Chrome only allow
 * sound and speech that were first started by a user gesture.
 */
export function unlockFeedback(): void {
  if (typeof window === "undefined") return;
  try {
    // Safari (Audio Session API): play as ambient audio that respects the silent switch.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = "ambient";
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!context && Ctor) context = new Ctor();
    if (context?.state === "suspended") void context.resume();
    if (window.speechSynthesis) {
      const primer = new SpeechSynthesisUtterance("");
      primer.volume = 0;
      window.speechSynthesis.speak(primer);
    }
  } catch {
    // Audio is a nicety; never block the capture flow.
  }
}

function tone(ctx: AudioContext, frequency: number, start: number, duration: number, peak: number, type: OscillatorType = "sine") {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

function click(ctx: AudioContext, start: number) {
  const length = Math.floor(ctx.sampleRate * 0.06);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.value = 2_600;
  gain.gain.value = 0.35;
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(start);
}

/**
 * Play a cue (tone plus vibration where supported).
 *
 * - `lock`: soft tick, the pose/document was found, hold still.
 * - `step`: rising two-note chime, frame captured, next step.
 * - `shutter`: camera click.
 * - `success` / `failure`: final result.
 *
 * Repeats of the same cue within `minGapMs` are dropped so a flickering
 * detector cannot make it chatter.
 */
export function playCue(cue: Cue, minGapMs = 600): void {
  if (!feedbackEnabled()) return;
  const now = performance.now();
  if (now - (lastCueAt[cue] ?? -Infinity) < minGapMs) return;
  lastCueAt = { ...lastCueAt, [cue]: now };
  try {
    navigator.vibrate?.(CUE_VIBRATION[cue] as number | number[]);
  } catch {
    // iOS has no Vibration API for web pages.
  }
  const ctx = context;
  if (!ctx || ctx.state !== "running") return;
  const t = ctx.currentTime + 0.01;
  switch (cue) {
    case "lock":
      tone(ctx, 880, t, 0.09, 0.07);
      break;
    case "step":
      tone(ctx, 659.25, t, 0.14, 0.12, "triangle");
      tone(ctx, 987.77, t + 0.11, 0.22, 0.12, "triangle");
      break;
    case "shutter":
      click(ctx, t);
      tone(ctx, 1_318.5, t + 0.05, 0.12, 0.05);
      break;
    case "success":
      tone(ctx, 523.25, t, 0.2, 0.1, "triangle");
      tone(ctx, 659.25, t + 0.09, 0.22, 0.1, "triangle");
      tone(ctx, 783.99, t + 0.18, 0.45, 0.11, "triangle");
      break;
    case "failure":
      tone(ctx, 440, t, 0.18, 0.1, "triangle");
      tone(ctx, 329.63, t + 0.16, 0.3, 0.1, "triangle");
      break;
  }
}

/**
 * Speak a short instruction with the Web Speech API, replacing anything still
 * being said. Use `delayMs` to let a {@link playCue} chime finish first.
 */
export function speak(text: string, delayMs = 0): void {
  if (!feedbackEnabled() || typeof window === "undefined" || !window.speechSynthesis) return;
  const say = () => {
    if (!feedbackEnabled()) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = config.lang;
      utterance.rate = config.rate;
      window.speechSynthesis.speak(utterance);
    } catch {
      // Speech unavailable; the on-screen text still applies.
    }
  };
  if (delayMs > 0) window.setTimeout(say, delayMs);
  else say();
}

/** Stop any speech in progress. */
export function stopSpeaking(): void {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
}

/** Forget remembered state (audio context, mute cache, cue timestamps, config). Intended for tests. */
export function resetFeedback(): void {
  context = null;
  enabled = null;
  lastCueAt = {};
  config = { ...DEFAULT_CONFIG };
}
