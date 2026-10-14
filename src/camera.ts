/**
 * Camera start/stop helpers around `getUserMedia`, with constraint fallbacks
 * for older phones and readable error messages.
 *
 * @packageDocumentation
 */

/** Which camera to prefer: `"user"` (selfie) or `"environment"` (rear). */
export type FacingMode = "user" | "environment";

/** Machine-readable reason a camera could not start. */
export type CameraErrorCode =
  | "insecure-context"
  | "unsupported"
  | "permission-denied"
  | "not-found"
  | "busy"
  | "overconstrained"
  | "security"
  | "unknown";

const MESSAGES: Record<CameraErrorCode, string> = {
  "insecure-context": "The camera needs a secure page (HTTPS). Open this page over https://, not http://.",
  unsupported: "This browser cannot access the camera. Open the page in Safari or Chrome (not an in-app browser).",
  "permission-denied": "Camera permission was blocked for this site. In your browser settings, allow Camera for this site, then try again.",
  "not-found": "No camera was found on this device.",
  busy: "The camera is busy in another app. Close other camera apps and try again.",
  overconstrained: "This device could not match the requested camera mode. Try again, or try a different camera.",
  security: "The camera was blocked by the browser security policy. Use HTTPS and allow camera access.",
  unknown: "The camera could not start. Allow camera access, use HTTPS, and open the page in Safari or Chrome.",
};

/** Classify a `getUserMedia` failure (or the current environment) into a {@link CameraErrorCode}. */
export function cameraErrorCode(error: unknown): CameraErrorCode {
  if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure-context";
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return "unsupported";
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "permission-denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "not-found";
  if (name === "NotReadableError" || name === "TrackStartError") return "busy";
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") return "overconstrained";
  if (name === "SecurityError") return "security";
  return "unknown";
}

/** A friendly English message for a camera failure. */
export function cameraErrorMessage(error: unknown): string {
  return MESSAGES[cameraErrorCode(error)];
}

/**
 * Request a camera stream, relaxing constraints step by step: 1080p ideal,
 * then exact facing mode, then plain facing mode, then any camera.
 *
 * @throws The last `getUserMedia` error when every attempt fails.
 */
export async function requestCameraStream(facingMode: FacingMode): Promise<MediaStream> {
  const attempts: MediaStreamConstraints[] = [
    { audio: false, video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
    { audio: false, video: { facingMode: { exact: facingMode } } },
    { audio: false, video: { facingMode } },
    { audio: false, video: true },
  ];
  let lastError: unknown;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
      // Permission errors will not be fixed by looser constraints.
      if (cameraErrorCode(error) === "permission-denied") break;
    }
  }
  throw lastError ?? new Error("getUserMedia failed");
}

/** Resolve once the video element has frame dimensions, or reject after `timeoutMs`. */
export async function waitForVideoReady(video: HTMLVideoElement, timeoutMs = 8_000): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("Camera preview timed out."));
    }, timeoutMs);
    const onReady = () => {
      if (video.videoWidth > 0) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("playing", onReady);
    };
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("playing", onReady);
    onReady();
  });
}

/**
 * Start a camera into a `<video>` element and wait until frames are flowing.
 * Sets the attributes iOS Safari needs for inline, muted autoplay.
 *
 * @returns The stream; pass it to {@link stopCamera} when done.
 * @throws The underlying error; use {@link cameraErrorMessage} to show it.
 */
export async function startCamera(video: HTMLVideoElement, facingMode: FacingMode): Promise<MediaStream> {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    throw new DOMException("Insecure context", "SecurityError");
  }
  const stream = await requestCameraStream(facingMode);
  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.setAttribute("muted", "true");
    // iOS Safari often needs play() after metadata is ready.
    await waitForVideoReady(video);
    await video.play();
    await waitForVideoReady(video);
    return stream;
  } catch (error) {
    stopCamera(stream, video);
    throw error;
  }
}

/** Stop every track of a stream and detach it from the video element. */
export function stopCamera(stream: MediaStream | null | undefined, video?: HTMLVideoElement | null): void {
  stream?.getTracks().forEach((track) => track.stop());
  if (video && video.srcObject === stream) video.srcObject = null;
}
