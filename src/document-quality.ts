/**
 * Document frame analysis: blur, glare, edge density, brightness, motion and a
 * rough "is this a face rather than a card?" check, all computed on a small
 * downscaled copy of the live camera frame. Nothing leaves the device.
 *
 * @packageDocumentation
 */

/** Basic quality measurements for one analysed frame. */
export interface CaptureQuality {
  /** Source video width in pixels. */
  width: number;
  /** Source video height in pixels. */
  height: number;
  /** Variance of the Laplacian over the guide region. Higher is sharper. */
  blurScore: number;
  /** Share (0-1) of near-white, blown-out pixels in the guide region. */
  glareRatio: number;
  /** Share (0-1) of pixels with a strong local gradient (text, card edges). */
  edgeRatio: number;
}

/** Why a document frame is not ready yet. `null` when the frame is ready. */
export type DocumentIssue =
  | "face-in-guide"
  | "too-dark"
  | "glare"
  | "motion"
  | "blurry"
  | "no-document"
  | "slight-glare";

/** Guidance for the current document frame. */
export interface DocumentGuidance {
  /** True when the frame looks good enough to auto-capture. */
  ready: boolean;
  /** Short, user-facing instruction (English). */
  message: string;
  /** Machine-readable reason, handy for translating `message`. */
  issue: DocumentIssue | null;
  quality: CaptureQuality;
  /** Mean luma (0-255) of the guide region. */
  brightness: number;
  /** Mean absolute luma change against the previous frame (0 for the first frame). */
  motion: number;
}

/** Statistics for an analysed region, including the greyscale buffer used for motion. */
export interface FrameStats extends CaptureQuality {
  brightness: number;
  grey: Float32Array;
}

/** A rectangle in source video pixel coordinates. */
export interface VideoSampleRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Thresholds used by {@link evaluateDocumentFrame}. */
export interface DocumentThresholds {
  /** Reject when more than this share of the guide looks like skin (a selfie, not an ID). */
  skinLimit: number;
  /** Reject below this mean brightness. */
  brightnessMin: number;
  /** Reject above this mean brightness. */
  brightnessMax: number;
  /** Reject above this motion score. */
  motionLimit: number;
  /** Reject below this blur score. */
  blurMin: number;
  /** Reject below this edge ratio. */
  edgeMin: number;
  /** Ask for a small tilt above this glare ratio. */
  glareSoft: number;
  /** Reject above this glare ratio. */
  glareHard: number;
}

/** Default inset (12% on each side of the visible video) for the on-screen document guide. */
export const DOCUMENT_GUIDE_INSET = 0.12;

const ANALYSIS_WIDTH = 160;
const SKIN_SAMPLE_WIDTH = 80;
const GLARE_CHANNEL_MIN = 245;
const EDGE_GRADIENT_MIN = 45;

/**
 * Thresholds for phones/tablets (`coarsePointer = true`) and desktops/webcams.
 * Phone cameras are noisier and phone ID photos contain a printed portrait, so
 * the mobile limits are a little more forgiving.
 */
export function getDocumentThresholds(coarsePointer: boolean): DocumentThresholds {
  return coarsePointer
    ? { skinLimit: 0.48, brightnessMin: 45, brightnessMax: 220, motionLimit: 18, blurMin: 32, edgeMin: 0.01, glareSoft: 0.16, glareHard: 0.28 }
    : { skinLimit: 0.28, brightnessMin: 55, brightnessMax: 220, motionLimit: 10, blurMin: 48, edgeMin: 0.015, glareSoft: 0.12, glareHard: 0.2 };
}

/** True on touch-first devices (phones and tablets). Returns false outside a browser. */
export function isCoarsePointerDevice(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(pointer: coarse)").matches || (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);
}

type VideoLike = Pick<HTMLVideoElement, "videoWidth" | "videoHeight" | "clientWidth" | "clientHeight">;

/**
 * Map a guide drawn inset on a `object-fit: cover` video element back into
 * source video pixel coordinates.
 *
 * Phones crop the preview to fill the element, so without this mapping the user
 * can frame an ID perfectly on screen while the analysed region is somewhere
 * else. With `inset = 0.12` the returned rectangle is exactly what is visible
 * inside a guide that has `inset: 12%` over the video element.
 *
 * @throws If the video has no frame dimensions yet.
 */
export function visibleCoverGuideRect(video: VideoLike, inset = DOCUMENT_GUIDE_INSET): VideoSampleRect {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("The camera is still starting. Try again in a moment.");

  const displayWidth = Math.max(1, video.clientWidth || width);
  const displayHeight = Math.max(1, video.clientHeight || height);
  const videoAspect = width / height;
  const displayAspect = displayWidth / displayHeight;

  let visibleWidth = width;
  let visibleHeight = height;
  let offsetX = 0;
  let offsetY = 0;
  if (videoAspect > displayAspect) {
    visibleWidth = height * displayAspect;
    offsetX = (width - visibleWidth) / 2;
  } else if (videoAspect < displayAspect) {
    visibleHeight = width / displayAspect;
    offsetY = (height - visibleHeight) / 2;
  }

  return {
    sx: Math.max(0, offsetX + visibleWidth * inset),
    sy: Math.max(0, offsetY + visibleHeight * inset),
    sw: Math.max(1, visibleWidth * (1 - inset * 2)),
    sh: Math.max(1, visibleHeight * (1 - inset * 2)),
  };
}

/**
 * Compute blur, glare, edge and brightness statistics from RGBA pixels
 * (for example `ImageData.data`). Pure function; usable in workers and tests.
 *
 * @param pixels - RGBA bytes, `sampleWidth * sampleHeight * 4` long.
 * @param sampleWidth - Width of the pixel buffer.
 * @param sampleHeight - Height of the pixel buffer.
 * @param sourceWidth - Reported as `width` in the result (defaults to `sampleWidth`).
 * @param sourceHeight - Reported as `height` in the result (defaults to `sampleHeight`).
 */
export function computeFrameStats(
  pixels: ArrayLike<number>,
  sampleWidth: number,
  sampleHeight: number,
  sourceWidth = sampleWidth,
  sourceHeight = sampleHeight,
): FrameStats {
  const grey = new Float32Array(sampleWidth * sampleHeight);
  let glare = 0;
  let brightnessSum = 0;
  for (let index = 0; index < grey.length; index += 1) {
    const offset = index * 4;
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const value = red * 0.299 + green * 0.587 + blue * 0.114;
    grey[index] = value;
    brightnessSum += value;
    if (red > GLARE_CHANNEL_MIN && green > GLARE_CHANNEL_MIN && blue > GLARE_CHANNEL_MIN) glare += 1;
  }

  let laplacianSum = 0;
  let laplacianSquared = 0;
  let edges = 0;
  let samples = 0;
  for (let y = 1; y < sampleHeight - 1; y += 1) {
    for (let x = 1; x < sampleWidth - 1; x += 1) {
      const index = y * sampleWidth + x;
      const centre = grey[index] ?? 0;
      const left = grey[index - 1] ?? 0;
      const right = grey[index + 1] ?? 0;
      const up = grey[index - sampleWidth] ?? 0;
      const down = grey[index + sampleWidth] ?? 0;
      const laplacian = 4 * centre - left - right - up - down;
      laplacianSum += laplacian;
      laplacianSquared += laplacian * laplacian;
      const gradient = Math.abs(right - left) + Math.abs(down - up);
      if (gradient > EDGE_GRADIENT_MIN) edges += 1;
      samples += 1;
    }
  }
  const mean = samples === 0 ? 0 : laplacianSum / samples;
  const blurScore = samples === 0 ? 0 : laplacianSquared / samples - mean * mean;
  const pixelCount = Math.max(1, grey.length);

  return {
    width: sourceWidth,
    height: sourceHeight,
    blurScore: Math.round(blurScore * 100) / 100,
    glareRatio: Math.round((glare / pixelCount) * 10_000) / 10_000,
    edgeRatio: samples === 0 ? 0 : Math.round((edges / samples) * 10_000) / 10_000,
    brightness: Math.round((brightnessSum / pixelCount) * 10) / 10,
    grey,
  };
}

/**
 * Rough share (0-1) of skin-tone pixels in RGBA data, using a common RGB skin
 * heuristic. A high value inside the document guide usually means the camera
 * sees a face, not an ID card.
 */
export function skinToneRatioFromPixels(pixels: ArrayLike<number>, pixelCount: number): number {
  if (pixelCount <= 0) return 0;
  let skin = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const r = pixels[offset] ?? 0;
    const g = pixels[offset + 1] ?? 0;
    const b = pixels[offset + 2] ?? 0;
    if (r > 60 && g > 30 && b > 15 && r > g && r > b && Math.abs(r - g) > 12 && r - b > 15) skin += 1;
  }
  return skin / pixelCount;
}

/**
 * Mean absolute difference between two greyscale buffers (every 4th pixel).
 * Returns 0 when there is no comparable previous frame.
 */
export function motionScore(current: Float32Array, previous: Float32Array | null): number {
  if (!previous || previous.length !== current.length) return 0;
  let total = 0;
  let samples = 0;
  for (let index = 0; index < current.length; index += 4) {
    total += Math.abs((current[index] ?? 0) - (previous[index] ?? 0));
    samples += 1;
  }
  return samples === 0 ? 0 : Math.round((total / samples) * 10) / 10;
}

/** Inputs to {@link evaluateDocumentFrame}. */
export interface DocumentFrameSignals {
  quality: CaptureQuality;
  brightness: number;
  motion: number;
  skinRatio: number;
}

/**
 * Turn frame statistics into a ready flag and one instruction. Checks run in a
 * fixed priority order so the user always sees the most important fix first.
 * Pure function.
 */
export function evaluateDocumentFrame(
  signals: DocumentFrameSignals,
  thresholds: DocumentThresholds,
): { ready: boolean; message: string; issue: DocumentIssue | null } {
  const { quality, brightness, motion, skinRatio } = signals;
  const t = thresholds;
  if (skinRatio > t.skinLimit) return { ready: false, issue: "face-in-guide", message: "Hold your ID in the guide (not your face)" };
  if (brightness < t.brightnessMin) return { ready: false, issue: "too-dark", message: "Move somewhere brighter" };
  if (brightness > t.brightnessMax || quality.glareRatio > t.glareHard) return { ready: false, issue: "glare", message: "Tilt to reduce glare" };
  if (motion > t.motionLimit) return { ready: false, issue: "motion", message: "Hold the phone more still" };
  if (quality.blurScore < t.blurMin) return { ready: false, issue: "blurry", message: "Hold steady - text looks soft" };
  if (quality.edgeRatio < t.edgeMin) return { ready: false, issue: "no-document", message: "Fill the guide with your document" };
  if (quality.glareRatio > t.glareSoft) return { ready: false, issue: "slight-glare", message: "Slight glare - tilt a little" };
  return { ready: true, issue: null, message: "Looking good - hold still" };
}

function sampleRegion(video: HTMLVideoElement, sampleWidth: number, minHeight: number, inset: number): { pixels: Uint8ClampedArray; width: number; height: number } | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("The camera is still starting. Try again in a moment.");
  const sampleHeight = Math.max(minHeight, Math.round(sampleWidth * (height / width)));
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const { sx, sy, sw, sh } = visibleCoverGuideRect(video, inset);
  context.drawImage(video, sx, sy, sw, sh, 0, 0, sampleWidth, sampleHeight);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  context.clearRect(0, 0, sampleWidth, sampleHeight);
  canvas.width = 0;
  canvas.height = 0;
  return { pixels, width: sampleWidth, height: sampleHeight };
}

function analyseRegion(video: HTMLVideoElement, inset: number): FrameStats {
  const sample = sampleRegion(video, ANALYSIS_WIDTH, 90, inset);
  if (!sample) throw new Error("The browser could not analyse this frame.");
  return computeFrameStats(sample.pixels, sample.width, sample.height, video.videoWidth, video.videoHeight);
}

function skinToneRatio(video: HTMLVideoElement, inset: number): number {
  if (!video.videoWidth || !video.videoHeight) return 0;
  const sample = sampleRegion(video, SKIN_SAMPLE_WIDTH, 45, inset);
  if (!sample) return 0;
  return skinToneRatioFromPixels(sample.pixels, sample.width * sample.height);
}

/**
 * Measure blur, glare and edges inside the document guide of a playing video.
 *
 * @param video - A playing `<video>` element showing the camera stream.
 * @param inset - Guide inset as a fraction of the visible video (default {@link DOCUMENT_GUIDE_INSET}).
 */
export function analyseVideoFrame(video: HTMLVideoElement, inset = DOCUMENT_GUIDE_INSET): CaptureQuality {
  const { width, height, blurScore, glareRatio, edgeRatio } = analyseRegion(video, inset);
  return { width, height, blurScore, glareRatio, edgeRatio };
}

/** Options for {@link assessDocumentFrame}. */
export interface AssessDocumentOptions {
  /** Guide inset as a fraction of the visible video. Default {@link DOCUMENT_GUIDE_INSET}. */
  inset?: number;
  /** Use phone thresholds. Defaults to {@link isCoarsePointerDevice}. */
  coarsePointer?: boolean;
  /** Override individual thresholds. */
  thresholds?: Partial<DocumentThresholds>;
}

/**
 * Assess the current document frame and say what the user should do next.
 *
 * Call this on a timer (about every 200 ms works well) and pass back the
 * returned `grey` buffer as `previousGrey` on the next call so camera motion
 * can be measured. Combine with {@link advanceStableHold} to auto-capture once
 * the frame has been `ready` for a short, steady hold.
 *
 * @example
 * ```ts
 * let previous: Float32Array | null = null;
 * setInterval(() => {
 *   const { guidance, grey } = assessDocumentFrame(video, previous);
 *   previous = grey;
 *   label.textContent = guidance.message;
 * }, 220);
 * ```
 */
export function assessDocumentFrame(
  video: HTMLVideoElement,
  previousGrey: Float32Array | null,
  options: AssessDocumentOptions = {},
): { guidance: DocumentGuidance; grey: Float32Array } {
  const inset = options.inset ?? DOCUMENT_GUIDE_INSET;
  const stats = analyseRegion(video, inset);
  const motion = motionScore(stats.grey, previousGrey);
  const quality: CaptureQuality = {
    width: stats.width,
    height: stats.height,
    blurScore: stats.blurScore,
    glareRatio: stats.glareRatio,
    edgeRatio: stats.edgeRatio,
  };
  const thresholds = { ...getDocumentThresholds(options.coarsePointer ?? isCoarsePointerDevice()), ...options.thresholds };
  const verdict = evaluateDocumentFrame(
    { quality, brightness: stats.brightness, motion, skinRatio: skinToneRatio(video, inset) },
    thresholds,
  );
  return {
    guidance: { ...verdict, quality, brightness: stats.brightness, motion },
    grey: stats.grey,
  };
}

/** Options for {@link captureJpegFrame}. */
export interface CaptureJpegOptions {
  /** Downscale so the output is at most this wide. Default 1920. */
  maxWidth?: number;
  /** JPEG quality 0-1. Default 0.92. */
  quality?: number;
  /**
   * Crop to the visible guide with this inset (see {@link visibleCoverGuideRect}).
   * Default 0: the whole video frame.
   */
  inset?: number;
}

/**
 * Grab the current video frame as a JPEG data URL, optionally cropped to the
 * on-screen guide.
 *
 * @throws If the camera has not produced a frame yet or the canvas is unavailable.
 */
export function captureJpegFrame(video: HTMLVideoElement, options: CaptureJpegOptions = {}): string {
  const { maxWidth = 1920, quality = 0.92, inset = 0 } = options;
  if (!video.videoWidth || !video.videoHeight) throw new Error("The camera is still starting.");
  const region = inset > 0
    ? visibleCoverGuideRect(video, inset)
    : { sx: 0, sy: 0, sw: video.videoWidth, sh: video.videoHeight };
  const scale = Math.min(1, maxWidth / region.sw);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(region.sw * scale);
  canvas.height = Math.round(region.sh * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser could not capture this frame.");
  context.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, canvas.width, canvas.height);
  const capture = canvas.toDataURL("image/jpeg", quality);
  context.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;
  return capture;
}
