/**
 * Guided face poses on top of the MediaPipe Face Landmarker: framing, distance,
 * head turns, blink and smile, evaluated per video frame in the browser.
 *
 * These signals guide the user to produce good selfie frames. They are not a
 * liveness or anti-spoofing decision; see the README.
 *
 * @packageDocumentation
 */
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";

/** A pose the user is asked to perform. */
export type GuidedGesture = "centre" | "left" | "right" | "blink" | "smile";

/** Head turn direction in image coordinates: -1 or 1. */
export type TurnDirection = -1 | 1;

/** Per-frame face guidance. */
export interface FaceGuidance {
  /** Face framed, sized and the requested gesture detected. */
  ready: boolean;
  /** A face with a full landmark set was found. */
  faceFound: boolean;
  /** Face centre is inside the target oval area. */
  centered: boolean;
  /** Face is neither too far away nor too close. */
  sizeOkay: boolean;
  /** The requested gesture is currently detected. */
  gestureDetected: boolean;
  /** Current head turn, or null when roughly facing the camera. */
  turnDirection: TurnDirection | null;
  /** Short, user-facing instruction (English). */
  message: string;
}

/** The pose order used by the reference flow. */
export const DEFAULT_POSE_SEQUENCE: readonly GuidedGesture[] = Object.freeze(["centre", "left", "right", "blink", "smile"]);

/** Short on-screen labels for each pose. */
export const POSE_LABELS: Readonly<Record<GuidedGesture, string>> = Object.freeze({
  centre: "Centre your face",
  left: "Turn to one side",
  right: "Turn to the other side",
  blink: "Blink both eyes",
  smile: "Smile",
});

/**
 * Spoken prompt for each pose. During head turns the screen is out of view,
 * so read these aloud with {@link speak} at the start of each step.
 */
export const POSE_PROMPTS: Readonly<Record<GuidedGesture, string>> = Object.freeze({
  centre: "Look straight at the camera and hold still.",
  left: "Turn your head to one side.",
  right: "Now turn your head the other way.",
  blink: "Blink both eyes.",
  smile: "And smile.",
});

/** Suggested hold (ms) before capturing each pose. Blinks are captured at once. */
export const POSE_HOLD_MS: Readonly<Record<GuidedGesture, number>> = Object.freeze({
  centre: 1_100,
  left: 1_100,
  right: 1_100,
  blink: 0,
  smile: 1_100,
});

/** MediaPipe Tasks Vision version this package is built and tested against. */
export const MEDIAPIPE_VERSION = "0.10.35";
/** Default WASM fileset location (jsDelivr, matching {@link MEDIAPIPE_VERSION}). */
export const DEFAULT_WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
/** Default Face Landmarker model (Google-hosted, float16). */
export const DEFAULT_MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/** Where to load MediaPipe from, and how. */
export interface FaceLandmarkerOptions {
  /** Base URL of the MediaPipe WASM fileset. Default {@link DEFAULT_WASM_PATH}. */
  wasmPath?: string;
  /** URL of `face_landmarker.task`. Default {@link DEFAULT_MODEL_PATH}. */
  modelPath?: string;
  /**
   * Assets to try when the primary (self-hosted) ones fail to load. Defaults to
   * the public CDN locations; pass `false` to never fall back (for example
   * under a strict Content Security Policy).
   */
  fallback?: { wasmPath: string; modelPath: string } | false;
  /** MediaPipe delegate. Default "CPU", which is the most reliable on phones. */
  delegate?: "CPU" | "GPU";
  /**
   * Before loading a self-hosted model, fetch its first bytes and skip it if it
   * comes back as HTML or text (a proxy or bot-challenge page). Default true.
   */
  probe?: boolean;
  /** Timeout for self-hosted assets. Default 15 s. */
  primaryTimeoutMs?: number;
  /** Timeout for CDN / fallback assets. Default 30 s. */
  fallbackTimeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function assetLooksServable(url: string): Promise<boolean> {
  try {
    const response = await withTimeout(
      fetch(url, { method: "GET", cache: "no-store", headers: { Range: "bytes=0-15" } }),
      4_000,
      `Probe ${url}`,
    );
    if (!response.ok && response.status !== 206) return false;
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    return !type.includes("text/html") && !type.includes("text/plain");
  } catch {
    return false;
  }
}

async function createLandmarker(wasmPath: string, modelPath: string, delegate: "CPU" | "GPU"): Promise<FaceLandmarker> {
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const files = await FilesetResolver.forVisionTasks(wasmPath);
  return FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: modelPath, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.45,
    minFacePresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
    outputFaceBlendshapes: true,
  });
}

async function loadLandmarker(options: FaceLandmarkerOptions): Promise<FaceLandmarker> {
  const wasmPath = options.wasmPath ?? DEFAULT_WASM_PATH;
  const modelPath = options.modelPath ?? DEFAULT_MODEL_PATH;
  const delegate = options.delegate ?? "CPU";
  const fallback = options.fallback === undefined
    ? { wasmPath: DEFAULT_WASM_PATH, modelPath: DEFAULT_MODEL_PATH }
    : options.fallback;
  const usingDefaults = wasmPath === DEFAULT_WASM_PATH && modelPath === DEFAULT_MODEL_PATH;
  const fallbackTimeout = options.fallbackTimeoutMs ?? 30_000;

  if (usingDefaults) return withTimeout(createLandmarker(wasmPath, modelPath, delegate), fallbackTimeout, "Face model");

  let primaryError: unknown = new Error(`Face model at ${modelPath} is not reachable`);
  const servable = options.probe === false || (await assetLooksServable(modelPath));
  if (servable) {
    try {
      return await withTimeout(createLandmarker(wasmPath, modelPath, delegate), options.primaryTimeoutMs ?? 15_000, "Face model");
    } catch (error) {
      primaryError = error;
    }
  }
  if (!fallback) throw primaryError;
  return withTimeout(createLandmarker(fallback.wasmPath, fallback.modelPath, delegate), fallbackTimeout, "Fallback face model");
}

const landmarkers = new Map<string, Promise<FaceLandmarker>>();

function cacheKey(options: FaceLandmarkerOptions): string {
  return JSON.stringify([
    options.wasmPath ?? DEFAULT_WASM_PATH,
    options.modelPath ?? DEFAULT_MODEL_PATH,
    options.fallback ?? null,
    options.delegate ?? "CPU",
  ]);
}

/**
 * Load (once) and return a MediaPipe `FaceLandmarker` configured for video.
 * Concurrent calls share one load; a failed load is retried on the next call.
 */
export function getFaceLandmarker(options: FaceLandmarkerOptions = {}): Promise<FaceLandmarker> {
  const key = cacheKey(options);
  let promise = landmarkers.get(key);
  if (!promise) {
    promise = loadLandmarker(options).catch((error: unknown) => {
      landmarkers.delete(key);
      throw error;
    });
    landmarkers.set(key, promise);
  }
  return promise;
}

/**
 * Start downloading the face model early (for example during the document
 * step) so the first selfie frame is not blocked on a multi-megabyte download.
 */
export function preloadFaceGuidance(options: FaceLandmarkerOptions = {}): Promise<void> {
  return getFaceLandmarker(options).then(() => undefined);
}

/** Close every loaded landmarker and free its WASM memory. */
export async function closeFaceGuidance(): Promise<void> {
  const pending = [...landmarkers.values()];
  landmarkers.clear();
  await Promise.all(pending.map((promise) => promise.then((landmarker) => landmarker.close(), () => undefined)));
}

function blendshapeScores(result: FaceLandmarkerResult): Map<string, number> {
  return new Map((result.faceBlendshapes[0]?.categories ?? []).map((item) => [item.categoryName, item.score]));
}

const NO_FACE: FaceGuidance = Object.freeze({
  ready: false,
  faceFound: false,
  centered: false,
  sizeOkay: false,
  gestureDetected: false,
  turnDirection: null,
  message: "Position one face inside the oval",
});

/**
 * Evaluate one Face Landmarker result against a requested gesture. Pure function.
 *
 * Coordinates are normalised to the analysed frame, so the target oval is
 * assumed to be centred in the preview. For `"right"`, pass the direction
 * recorded when the `"left"` pose was captured as `firstTurn`: the user may
 * turn either way first, and the second turn must be the opposite one.
 *
 * @param result - Output of `FaceLandmarker.detectForVideo`.
 * @param gesture - The pose being asked for.
 * @param firstTurn - Direction of the first head turn, or null.
 */
export function evaluateFaceGuidance(
  result: FaceLandmarkerResult,
  gesture: GuidedGesture,
  firstTurn: TurnDirection | null,
): FaceGuidance {
  const landmarks = result.faceLandmarks[0];
  if (!landmarks || landmarks.length < 264) return { ...NO_FACE };

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of landmarks) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const faceWidth = maxX - minX;
  const faceHeight = maxY - minY;
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const centered = Math.abs(centreX - 0.5) <= 0.16 && Math.abs(centreY - 0.48) <= 0.22;
  const sizeOkay = faceWidth >= 0.18 && faceWidth <= 0.82 && faceHeight >= 0.24 && faceHeight <= 0.9;

  // Landmark indices from the MediaPipe canonical face mesh: 1 nose tip, 33 / 263 outer eye corners.
  const nose = landmarks[1]!;
  const leftEye = landmarks[33]!;
  const rightEye = landmarks[263]!;
  const eyeDistance = Math.max(Math.abs(rightEye.x - leftEye.x), 0.01);
  const yaw = (nose.x - (leftEye.x + rightEye.x) / 2) / eyeDistance;
  const turnDirection: TurnDirection | null = Math.abs(yaw) >= 0.11 ? (yaw < 0 ? -1 : 1) : null;
  const scores = blendshapeScores(result);
  const bothEyesClosed = Math.min(scores.get("eyeBlinkLeft") ?? 0, scores.get("eyeBlinkRight") ?? 0) >= 0.35;
  const smiling = ((scores.get("mouthSmileLeft") ?? 0) + (scores.get("mouthSmileRight") ?? 0)) / 2 >= 0.28;

  let gestureDetected = false;
  // "centre" only validates framing and distance. Direction is checked by the
  // left/right steps; using yaw here would make a still face flicker.
  if (gesture === "centre") gestureDetected = true;
  if (gesture === "left") gestureDetected = turnDirection !== null;
  if (gesture === "right") gestureDetected = turnDirection !== null && firstTurn !== null && turnDirection !== firstTurn;
  if (gesture === "blink") gestureDetected = bothEyesClosed;
  if (gesture === "smile") gestureDetected = smiling;

  let message = "Hold that position";
  if (!sizeOkay) message = faceWidth < 0.24 ? "Move a little closer" : "Move a little farther away";
  else if (!centered) message = "Move your face into the centre of the oval";
  else if (!gestureDetected) {
    message = {
      centre: "Look straight at the camera",
      left: "Turn your head clearly to either side",
      right: "Turn your head to the other side",
      blink: "Blink both eyes",
      smile: "Give a clear smile",
    }[gesture];
  }

  return { ready: centered && sizeOkay && gestureDetected, faceFound: true, centered, sizeOkay, gestureDetected, turnDirection, message };
}

/**
 * After the hold timer has elapsed, allow capture while the face is still
 * framed even if the gesture score flickers on this exact frame.
 */
export function canCaptureAfterHold(guidance: FaceGuidance, holdElapsed: boolean): boolean {
  if (!holdElapsed) return false;
  if (guidance.ready) return true;
  return guidance.faceFound && guidance.centered && guidance.sizeOkay;
}

/**
 * Run the Face Landmarker on the current video frame and evaluate it.
 * Loads the model on first use (see {@link preloadFaceGuidance}).
 *
 * @example
 * ```ts
 * const guidance = await assessVideoFrame(video, "blink", null);
 * if (guidance.ready) capture();
 * ```
 */
export async function assessVideoFrame(
  video: HTMLVideoElement,
  gesture: GuidedGesture,
  firstTurn: TurnDirection | null,
  options: FaceLandmarkerOptions = {},
): Promise<FaceGuidance> {
  if (video.readyState < 2 /* HAVE_CURRENT_DATA */) {
    return { ...NO_FACE, message: "Waiting for camera" };
  }
  const landmarker = await getFaceLandmarker(options);
  return evaluateFaceGuidance(landmarker.detectForVideo(video, performance.now()), gesture, firstTurn);
}
