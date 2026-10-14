# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-14

Initial release.

### Added

- Document capture quality: cover-crop guide mapping (`visibleCoverGuideRect`), blur, glare, edge, brightness and motion scoring, face-in-guide detection, prioritised user guidance (`assessDocumentFrame`) and guide-cropped JPEG capture (`captureJpegFrame`).
- Guided face poses on MediaPipe Face Landmarker: framing and distance checks, head turns in both directions, blink and smile (`assessVideoFrame`, `evaluateFaceGuidance`), with configurable WASM and model locations and CDN fallback.
- Flicker-tolerant hold timer (`advanceStableHold`).
- Feedback cues: synthesised tones, spoken prompts and vibration with a persistent mute switch.
- Camera helpers: `getUserMedia` constraint fallbacks, iOS inline playback, error codes and friendly messages.
- OCR-tolerant passport MRZ parser with ICAO 9303 check digits (strict by default, `strict: false` for live OCR feedback), plus UK driving licence date extraction.
- React bindings: `useCamera` and `useFeedbackEnabled` in `veriwell-capture/react`.
- Vanilla TypeScript demo in `examples/vanilla`.
