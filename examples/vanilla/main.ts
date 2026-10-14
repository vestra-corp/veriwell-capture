import {
  advanceStableHold,
  analyseVideoFrame,
  assessDocumentFrame,
  assessVideoFrame,
  cameraErrorMessage,
  canCaptureAfterHold,
  captureJpegFrame,
  DEFAULT_POSE_SEQUENCE,
  DOCUMENT_GUIDE_INSET,
  EMPTY_HOLD,
  feedbackEnabled,
  isCoarsePointerDevice,
  parseDrivingLicence,
  parsePassport,
  playCue,
  POSE_HOLD_MS,
  POSE_LABELS,
  POSE_PROMPTS,
  preloadFaceGuidance,
  setFeedbackEnabled,
  speak,
  startCamera,
  stopCamera,
  stopSpeaking,
  unlockFeedback,
  type StableHoldState,
  type TurnDirection,
} from "veriwell-capture";

function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

// Only one camera runs at a time; starting one stops the other.
let stopActiveCamera: (() => void) | null = null;

/* ---------------------------------------------------------------- sound */

const soundToggle = $<HTMLInputElement>("sound");
soundToggle.checked = feedbackEnabled();
soundToggle.addEventListener("change", () => {
  if (soundToggle.checked) unlockFeedback();
  setFeedbackEnabled(soundToggle.checked);
});

/* ------------------------------------------------------ document capture */

const docVideo = $<HTMLVideoElement>("doc-video");
const docGuide = $("doc-guide");
const docStatus = $("doc-status");
const docStart = $<HTMLButtonElement>("doc-start");
const docCaptureButton = $<HTMLButtonElement>("doc-capture");
const docResult = $("doc-result");

function documentCapture() {
  let stream: MediaStream | null = null;
  let timer: number | undefined;

  const stop = () => {
    window.clearInterval(timer);
    stopCamera(stream, docVideo);
    stream = null;
    docCaptureButton.disabled = true;
    docGuide.classList.remove("ready");
  };

  const take = () => {
    try {
      const quality = analyseVideoFrame(docVideo);
      const jpeg = captureJpegFrame(docVideo, { maxWidth: 1920, quality: 0.92, inset: DOCUMENT_GUIDE_INSET });
      playCue("shutter");
      stop();
      docStatus.textContent = "Captured";
      $<HTMLImageElement>("doc-image").src = jpeg;
      $("doc-quality").textContent = JSON.stringify(quality, null, 2);
      docResult.hidden = false;
      docStart.textContent = "Retake";
    } catch (error) {
      docStatus.textContent = error instanceof Error ? error.message : "Capture failed";
    }
  };

  docCaptureButton.addEventListener("click", take);

  docStart.addEventListener("click", async () => {
    unlockFeedback(); // must run inside the tap handler for iOS
    stopActiveCamera?.();
    stopActiveCamera = stop;
    docResult.hidden = true;
    docStatus.textContent = "Starting camera…";
    try {
      stream = await startCamera(docVideo, "environment");
    } catch (error) {
      docStatus.textContent = cameraErrorMessage(error);
      return;
    }
    docCaptureButton.disabled = false;

    const coarse = isCoarsePointerDevice();
    const armedAt = performance.now() + 2_000; // give the user time to bring the card up
    const holdMs = coarse ? 1_400 : 2_000;
    const graceMs = coarse ? 1_600 : 1_200;
    let hold: StableHoldState = EMPTY_HOLD;
    let previousGrey: Float32Array | null = null;

    timer = window.setInterval(() => {
      const now = performance.now();
      if (now < armedAt) {
        docStatus.textContent = "Place your ID in the guide";
        return;
      }
      const { guidance, grey } = assessDocumentFrame(docVideo, previousGrey, { coarsePointer: coarse });
      previousGrey = grey;
      hold = advanceStableHold(hold, guidance.ready, now, graceMs);
      docGuide.classList.toggle("ready", guidance.ready);
      if (hold.startedAt === null) {
        docStatus.textContent = guidance.message;
        return;
      }
      if (hold.startedAt === now) playCue("lock", 1_500);
      const remaining = Math.max(0, holdMs - (now - hold.startedAt));
      docStatus.textContent = `Hold still · capturing in ${Math.max(1, Math.ceil(remaining / 1000))}`;
      if (remaining === 0 && guidance.ready) take();
    }, 220);
  });
}

/* ----------------------------------------------------- guided face poses */

const faceVideo = $<HTMLVideoElement>("face-video");
const faceGuide = $("face-guide");
const faceStatus = $("face-status");
const faceStart = $<HTMLButtonElement>("face-start");
const faceSteps = $("face-steps");
const faceLive = $("face-live");
const faceResult = $("face-result");

function renderSteps(current: number) {
  faceSteps.replaceChildren(
    ...DEFAULT_POSE_SEQUENCE.map((gesture, index) => {
      const item = document.createElement("li");
      item.textContent = `${index < current ? "✓ " : ""}${POSE_LABELS[gesture]}`;
      if (index < current) item.className = "done";
      if (index === current) item.className = "current";
      return item;
    }),
  );
}

function guidedPoses() {
  let stream: MediaStream | null = null;
  let timer: number | undefined;
  renderSteps(-1);

  // Warm the face model early so the first frame is not blocked on the download.
  void preloadFaceGuidance().catch(() => {
    faceStatus.textContent = "Face model failed to load";
  });

  const stop = () => {
    window.clearInterval(timer);
    stopCamera(stream, faceVideo);
    stream = null;
    stopSpeaking();
    faceGuide.classList.remove("ready");
  };

  faceStart.addEventListener("click", async () => {
    unlockFeedback();
    stopActiveCamera?.();
    stopActiveCamera = stop;
    faceResult.hidden = true;
    faceResult.replaceChildren();
    faceStatus.textContent = "Starting camera…";
    try {
      stream = await startCamera(faceVideo, "user");
    } catch (error) {
      faceStatus.textContent = cameraErrorMessage(error);
      return;
    }

    const frames: string[] = [];
    let index = 0;
    let firstTurn: TurnDirection | null = null;
    let hold: StableHoldState = EMPTY_HOLD;
    let locked = false;
    let inFlight = false;

    const beginStep = () => {
      const gesture = DEFAULT_POSE_SEQUENCE[index];
      if (!gesture) return;
      renderSteps(index);
      hold = EMPTY_HOLD;
      faceLive.textContent = POSE_PROMPTS[gesture];
      // Let the step chime finish before speaking.
      speak(POSE_PROMPTS[gesture], index === 0 ? 0 : 450);
    };

    const finish = () => {
      stop();
      renderSteps(DEFAULT_POSE_SEQUENCE.length);
      playCue("success");
      faceStatus.textContent = "All poses captured";
      faceResult.replaceChildren(
        ...frames.map((src) => Object.assign(document.createElement("img"), { src, alt: "Captured pose" })),
      );
      faceResult.hidden = false;
      faceStart.textContent = "Start again";
      // In a real flow, send `frames` to your server for the actual liveness and face-match decision.
    };

    const inspect = async () => {
      const gesture = DEFAULT_POSE_SEQUENCE[index];
      if (!gesture || locked || inFlight) return;
      inFlight = true;
      try {
        const result = await assessVideoFrame(faceVideo, gesture, firstTurn);
        const now = performance.now();
        const framed = result.faceFound && result.centered && result.sizeOkay;
        // Once a hold has started, keep it while the face stays framed.
        hold = advanceStableHold(hold, result.ready || (hold.startedAt !== null && framed), now);
        faceGuide.classList.toggle("ready", result.ready);
        if (hold.startedAt === null) {
          faceStatus.textContent = result.message;
          return;
        }
        const holdMs = POSE_HOLD_MS[gesture];
        if (hold.startedAt === now && holdMs > 0) playCue("lock", 900);
        const remaining = Math.max(0, holdMs - (now - hold.startedAt));
        if (remaining > 0) {
          faceStatus.textContent = `Hold still · ${Math.ceil(remaining / 1000)}`;
          return;
        }
        if (!canCaptureAfterHold(result, true)) {
          faceStatus.textContent = framed ? "Hold still" : result.message;
          return;
        }

        locked = true;
        frames.push(captureJpegFrame(faceVideo, { maxWidth: 960, quality: 0.84 }));
        if (gesture === "left" && result.turnDirection) firstTurn = result.turnDirection;
        playCue("step", 0);
        index += 1;
        if (index >= DEFAULT_POSE_SEQUENCE.length) {
          finish();
          return;
        }
        beginStep();
        window.setTimeout(() => { locked = false; }, 450);
      } catch (error) {
        faceStatus.textContent = error instanceof Error ? error.message : "Face guidance failed";
      } finally {
        inFlight = false;
      }
    };

    faceStatus.textContent = "Loading face model…";
    beginStep();
    timer = window.setInterval(() => void inspect(), 200);
  });
}

/* ------------------------------------------------------------ MRZ parser */

function mrzParser() {
  const input = $<HTMLTextAreaElement>("mrz-input");
  const output = $("mrz-output");
  $("mrz-passport").addEventListener("click", () => {
    output.textContent = JSON.stringify(parsePassport(input.value), null, 2);
  });
  $("mrz-licence").addEventListener("click", () => {
    output.textContent = JSON.stringify(parseDrivingLicence(input.value), null, 2);
  });
}

documentCapture();
guidedPoses();
mrzParser();
