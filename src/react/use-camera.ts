import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { cameraErrorMessage, startCamera, stopCamera, type FacingMode } from "../camera.js";

/** Return value of {@link useCamera}. */
export interface UseCameraResult {
  /** Attach to a `<video muted playsInline autoPlay>` element. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** True while the stream is running. */
  active: boolean;
  /** A friendly message when the camera could not start, otherwise null. */
  error: string | null;
  /** Start (or restart) the camera. Call from a tap handler on iOS. */
  start: () => Promise<void>;
  /** Stop the camera and release the device. */
  stop: () => void;
}

/**
 * Manage a camera stream for a `<video>` element. The camera is stopped
 * automatically on unmount.
 *
 * @param facingMode - `"user"` for selfies, `"environment"` for documents.
 *
 * @example
 * ```tsx
 * const { videoRef, active, error, start } = useCamera("environment");
 * return <>
 *   <video ref={videoRef} muted playsInline autoPlay />
 *   {!active && <button onClick={() => { unlockFeedback(); void start(); }}>Enable camera</button>}
 *   {error && <p role="alert">{error}</p>}
 * </>;
 * ```
 */
export function useCamera(facingMode: FacingMode): UseCameraResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    stopCamera(streamRef.current, videoRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setActive(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    stop();
    const video = videoRef.current;
    if (!video) {
      setError("The camera preview is not on the page yet.");
      return;
    }
    try {
      streamRef.current = await startCamera(video, facingMode);
      setActive(true);
    } catch (reason) {
      setError(cameraErrorMessage(reason));
    }
  }, [facingMode, stop]);

  useEffect(() => stop, [stop]);
  return { videoRef, active, error, start, stop };
}
