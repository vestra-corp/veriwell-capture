# veriwell-capture

Open-source browser toolkit for ID document and selfie capture: auto-framing, blur/glare checks, guided face poses with sound and voice cues, and a passport/driving-licence MRZ parser. Runs entirely on the device.

Made by [Veriwell](https://veriwell.xyz). This is the capture layer from Veriwell's verification flow, published under the Apache License 2.0 so anyone can build a better camera experience.

- **Document capture**: maps an on-screen guide onto the camera frame (even when the preview is cropped), scores blur, glare, edges, brightness and hand shake, spots a face held up instead of a card, and auto-captures after a steady hold.
- **Guided face poses**: centre, turn left/right, blink and smile, using the MediaPipe Face Landmarker in the browser, with a hold timer that does not reset on every flicker.
- **Feedback cues**: synthesised tick/chime/shutter tones, spoken prompts and vibration, so people can follow along while their head is turned away from the screen. Includes a remembered mute switch.
- **MRZ parsing**: OCR-tolerant passport MRZ (ICAO 9303 TD3) parsing with check digits, plus UK photocard driving licence dates.
- **Camera helpers**: `getUserMedia` with constraint fallbacks, iOS-safe inline playback and plain-English error messages.

The core has no framework dependency. Optional React hooks live in `veriwell-capture/react`.

## Why on-device?

Identity documents and faces are some of the most sensitive data people share. Every check here runs in the browser on a small, downscaled copy of the camera frame. Nothing is uploaded by this library: you decide which captured frames, if any, leave the device.

By default the MediaPipe WebAssembly files and the face model are downloaded from public CDNs (jsDelivr and Google Cloud Storage), so those hosts see a normal file request. You can [self-host them](#self-hosting-the-face-model) instead.

## Important: client-side checks are not a security boundary

Everything in this package helps a person take a usable photo. **None of it proves that a document is genuine or that a live person is present.** Anyone can modify JavaScript running in their own browser, replay a video or feed in a virtual camera.

- Treat every value from this library (quality scores, `ready` flags, detected gestures, parsed MRZ fields) as a UX hint.
- Make the real decision on your server: re-run OCR and MRZ checks on the uploaded image, do liveness and face matching server-side, and enforce your own thresholds there.
- The thresholds in this package are tuned for guidance (when to auto-capture, what to tell the user), not for acceptance.

## Install

```sh
npm install veriwell-capture
```

`@mediapipe/tasks-vision` is installed as a dependency and only loaded (via dynamic `import()`) when you use face guidance. React is an optional peer dependency, needed only for `veriwell-capture/react`.

Camera access needs a secure context: HTTPS, or `http://localhost` during development.

## Quick start

### Document capture

```ts
import {
  advanceStableHold,
  assessDocumentFrame,
  captureJpegFrame,
  DOCUMENT_GUIDE_INSET,
  EMPTY_HOLD,
  playCue,
  startCamera,
  stopCamera,
  unlockFeedback,
  cameraErrorMessage,
} from "veriwell-capture";

const video = document.querySelector("video")!; // <video muted playsinline autoplay> with object-fit: cover
const status = document.querySelector("#status")!;
// Draw your guide over the video with `inset: 12%` so it matches DOCUMENT_GUIDE_INSET.

button.addEventListener("click", async () => {
  unlockFeedback(); // call inside the tap so iOS allows sound later
  let stream: MediaStream;
  try {
    stream = await startCamera(video, "environment");
  } catch (error) {
    status.textContent = cameraErrorMessage(error);
    return;
  }

  let hold = EMPTY_HOLD;
  let previous: Float32Array | null = null;
  const timer = setInterval(() => {
    const now = performance.now();
    const { guidance, grey } = assessDocumentFrame(video, previous);
    previous = grey;
    hold = advanceStableHold(hold, guidance.ready, now, 1_200);
    status.textContent = guidance.message; // e.g. "Tilt to reduce glare"

    if (hold.startedAt === now) playCue("lock");
    if (hold.startedAt !== null && guidance.ready && now - hold.startedAt >= 2_000) {
      clearInterval(timer);
      const jpeg = captureJpegFrame(video, { inset: DOCUMENT_GUIDE_INSET }); // data:image/jpeg;base64,...
      playCue("shutter");
      stopCamera(stream, video);
      // upload `jpeg` to your server for the real checks
    }
  }, 220);
});
```

`guidance.issue` gives a machine-readable reason (`"too-dark"`, `"glare"`, `"motion"`, `"blurry"`, `"no-document"`, `"slight-glare"`, `"face-in-guide"`) if you want to translate the messages. Phones get slightly more forgiving thresholds than desktops; override them with `assessDocumentFrame(video, previous, { thresholds: { blurMin: 40 } })`.

### Guided face poses

```ts
import {
  advanceStableHold,
  assessVideoFrame,
  canCaptureAfterHold,
  captureJpegFrame,
  DEFAULT_POSE_SEQUENCE,
  EMPTY_HOLD,
  playCue,
  POSE_HOLD_MS,
  POSE_PROMPTS,
  preloadFaceGuidance,
  speak,
  type TurnDirection,
} from "veriwell-capture";

preloadFaceGuidance(); // start the model download early

// after startCamera(video, "user"):
let step = 0;
let firstTurn: TurnDirection | null = null;
let hold = EMPTY_HOLD;
const frames: string[] = [];
speak(POSE_PROMPTS[DEFAULT_POSE_SEQUENCE[0]!]);

async function tick() {
  const gesture = DEFAULT_POSE_SEQUENCE[step];
  if (!gesture) return;
  const result = await assessVideoFrame(video, gesture, firstTurn);
  const now = performance.now();
  const framed = result.faceFound && result.centered && result.sizeOkay;
  hold = advanceStableHold(hold, result.ready || (hold.startedAt !== null && framed), now);
  if (hold.startedAt === null) return show(result.message);
  if (hold.startedAt === now) playCue("lock");
  if (now - hold.startedAt < POSE_HOLD_MS[gesture] || !canCaptureAfterHold(result, true)) return;

  frames.push(captureJpegFrame(video, { maxWidth: 960, quality: 0.84 }));
  if (gesture === "left" && result.turnDirection) firstTurn = result.turnDirection;
  playCue("step");
  hold = EMPTY_HOLD;
  step += 1;
  const next = DEFAULT_POSE_SEQUENCE[step];
  if (next) speak(POSE_PROMPTS[next], 450); // after the chime
  else playCue("success"); // send `frames` to your server
}
```

Run `tick` every ~200 ms and skip a tick while the previous one is still running. The person may turn either way first; the `"right"` step then requires the opposite direction.

`evaluateFaceGuidance(result, gesture, firstTurn)` is the pure function behind `assessVideoFrame`, so you can feed it results from your own `FaceLandmarker` too.

### Feedback cues

```ts
import { playCue, speak, unlockFeedback, setFeedbackEnabled, configureFeedback } from "veriwell-capture";

configureFeedback({ lang: "en-US", storageKey: "my-app:sound" }); // optional
startButton.onclick = () => { unlockFeedback(); /* start camera */ };

playCue("lock");    // soft tick: found it, hold still
playCue("step");    // rising chime: captured, next step
playCue("shutter"); // camera click
playCue("success"); // or "failure"
speak("Turn your head to one side.");
setFeedbackEnabled(false); // remembered in localStorage
```

React:

```tsx
import { useCamera, useFeedbackEnabled } from "veriwell-capture/react";
import { unlockFeedback } from "veriwell-capture";

function Capture() {
  const { videoRef, active, error, start } = useCamera("environment");
  const [soundOn, setSoundOn] = useFeedbackEnabled();
  return (
    <>
      <video ref={videoRef} muted playsInline autoPlay />
      {!active && <button onClick={() => { unlockFeedback(); void start(); }}>Enable camera</button>}
      <button onClick={() => { if (!soundOn) unlockFeedback(); setSoundOn(!soundOn); }}>
        {soundOn ? "Mute" : "Unmute"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
```

### MRZ parsing

This package does not include OCR. Run any OCR engine you like (for example Tesseract.js in the browser, or one on your server) and pass the text in:

```ts
import { parsePassport, parseDrivingLicence } from "veriwell-capture";

const passport = parsePassport(ocrText); // every check digit must pass
// { valid, dateOfBirth: "1974-08-12", expiryDate: "2012-04-15", error, line, checks, checksumsPassed }

const live = parsePassport(ocrText, { strict: false }); // OCR-tolerant, for framing feedback only

const licence = parseDrivingLicence(ocrText);
// { valid, dateOfBirth, expiryDate, error, hasUkMarkers }
```

By default `parsePassport` requires every ICAO 9303 check digit to pass. With `strict: false` it is OCR-tolerant (both dates parse and either two check digits pass or the line has the TD3 shape), which is handy for live "we can read it" feedback while the user is still framing the document. Check digits only catch misreads; anyone can compute them, so they never prove a document is genuine. Repeat the check on your server. Lower-level helpers are exported too: `mrzCheckDigit`, `mrzChecksum`, `mrzDate`, `digitizeMrz`, `softMrzLine`, `findPassportMrzLine`.

`parseDrivingLicence` collects `DD.MM.YYYY` dates and takes the earliest past date as the birth date and the latest future date as the expiry.

## API overview

| Module | Exports |
| --- | --- |
| Camera | `startCamera`, `stopCamera`, `requestCameraStream`, `waitForVideoReady`, `cameraErrorCode`, `cameraErrorMessage` |
| Document quality | `assessDocumentFrame`, `analyseVideoFrame`, `captureJpegFrame`, `visibleCoverGuideRect`, `evaluateDocumentFrame`, `getDocumentThresholds`, `computeFrameStats`, `motionScore`, `skinToneRatioFromPixels`, `isCoarsePointerDevice`, `DOCUMENT_GUIDE_INSET` |
| Face guidance | `assessVideoFrame`, `evaluateFaceGuidance`, `canCaptureAfterHold`, `preloadFaceGuidance`, `getFaceLandmarker`, `closeFaceGuidance`, `DEFAULT_POSE_SEQUENCE`, `POSE_LABELS`, `POSE_PROMPTS`, `POSE_HOLD_MS`, `MEDIAPIPE_VERSION`, `DEFAULT_WASM_PATH`, `DEFAULT_MODEL_PATH` |
| Hold timer | `advanceStableHold`, `EMPTY_HOLD`, `DEFAULT_HOLD_GRACE_MS` |
| Feedback | `playCue`, `speak`, `stopSpeaking`, `unlockFeedback`, `feedbackEnabled`, `setFeedbackEnabled`, `subscribeFeedback`, `configureFeedback`, `resetFeedback`, `CUE_VIBRATION` |
| MRZ | `parsePassport`, `parseDrivingLicence`, `findPassportMrzLine`, `softMrzLine`, `digitizeMrz`, `mrzDate`, `mrzChecksum`, `mrzCheckDigit` |
| `veriwell-capture/react` | `useCamera`, `useFeedbackEnabled` |

Every export has TSDoc comments, so your editor shows the details.

## Self-hosting the face model

Copy `node_modules/@mediapipe/tasks-vision/wasm/` and [`face_landmarker.task`](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task) to your own static hosting and pass the locations everywhere you use face guidance:

```ts
const assets = { wasmPath: "/mediapipe/wasm", modelPath: "/models/face_landmarker.task" };
preloadFaceGuidance(assets);
await assessVideoFrame(video, "centre", null, assets);
```

If the self-hosted files fail to load (or come back as an HTML page, which some proxies and bot challenges do) the loader falls back to the CDN. Pass `fallback: false` to disable that, for example under a strict Content Security Policy. Keep the WASM files at the same version as the installed `@mediapipe/tasks-vision` (`MEDIAPIPE_VERSION`).

## Browser support

Recent Chrome, Edge, Firefox and Safari on desktop, Android and iOS. Notes:

- **Secure context**: camera access only works over HTTPS or on `localhost`. `cameraErrorMessage` explains this to the user.
- **In-app browsers** (some social and messaging apps) may block the camera. The error message suggests opening the page in Safari or Chrome.
- **iOS audio unlock**: Safari only plays Web Audio and speech that were started by a user gesture. Call `unlockFeedback()` synchronously inside the tap handler that starts the camera (before any `await`). On Safari with the Audio Session API, cues play as ambient audio and respect the silent switch.
- **No vibration on iOS**: Safari does not implement the Vibration API, so `playCue` is sound-only there.
- **Speech voices** differ by device and language; prompts are short so they work with any voice. Set the language with `configureFeedback({ lang })`.
- **Face guidance** needs WebAssembly. The default CPU delegate is the most reliable on phones; try `delegate: "GPU"` on desktops.
- **Inline video on iOS**: `startCamera` sets `muted` and `playsinline` for you. Keep `object-fit: cover` on the video so `visibleCoverGuideRect` matches what the user sees.

## Example

A plain HTML + TypeScript demo of document capture, guided poses with sound cues and the MRZ parser lives in [`examples/vanilla`](examples/vanilla).

```sh
npm install
npm run example
```

Open the printed `localhost` URL on a computer with a webcam. To try it on a phone you need HTTPS, for example through a tunnel or a local certificate.

## Development

```sh
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # ESM + .d.ts in dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Credits

- Face tracking uses [MediaPipe](https://github.com/google-ai-edge/mediapipe) Tasks Vision by Google, licensed under Apache-2.0. The WASM runtime and the Face Landmarker model are downloaded at runtime and are not part of this repository; see Google's model card for the model's terms.
- The sample passport MRZ in the tests and demo is the ICAO Doc 9303 specimen for the fictional state of Utopia. All other sample data is made up.

## Licence

[Apache License 2.0](LICENSE). Copyright 2026 Vestra.
