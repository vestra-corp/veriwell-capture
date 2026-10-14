# Contributing

Thanks for helping. Bug reports, device-specific camera quirks and small focused pull requests are all welcome.

## Setup

```sh
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # ESM + .d.ts in dist/
npm run example    # vanilla demo on localhost
```

Development needs Node 22.12 or newer (CI runs Node 22 and 24). The published package itself runs in browsers and has no Node requirement.

## Guidelines

- Keep the core in `src/` framework-agnostic and dependency-free (MediaPipe is loaded lazily). React-only code goes in `src/react/`.
- Prefer pure functions that can be unit-tested without a browser (see `evaluateDocumentFrame`, `evaluateFaceGuidance`, `computeFrameStats`), and add tests in `test/` for behaviour changes.
- Add TSDoc to every public export.
- If you change a guidance threshold, explain in the pull request which devices or conditions you tested it on.
- Never commit real identity documents, faces or personal data. Use the ICAO specimen or clearly made-up values in tests and examples.
- Update `CHANGELOG.md` under an "Unreleased" heading.

## Reporting bugs

Please include the browser, OS and device model, and whether the page was opened in an in-app browser. Camera behaviour varies a lot between devices.

Security issues: see [SECURITY.md](SECURITY.md). Please do not report them in public issues.

By contributing you agree that your contributions are licensed under the Apache License 2.0.
