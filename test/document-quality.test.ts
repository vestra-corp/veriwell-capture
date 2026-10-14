import { describe, expect, it } from "vitest";
import {
  computeFrameStats,
  evaluateDocumentFrame,
  getDocumentThresholds,
  motionScore,
  skinToneRatioFromPixels,
  visibleCoverGuideRect,
  type CaptureQuality,
} from "../src/document-quality.js";

function rgba(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return data;
}

const goodQuality: CaptureQuality = { width: 1920, height: 1080, blurScore: 120, glareRatio: 0.02, edgeRatio: 0.05 };
const goodSignals = { quality: goodQuality, brightness: 130, motion: 2, skinRatio: 0.05 };

describe("visibleCoverGuideRect", () => {
  it("maps a guide on a cropped portrait preview back to the landscape source", () => {
    const rect = visibleCoverGuideRect({ videoWidth: 1920, videoHeight: 1080, clientWidth: 400, clientHeight: 400 }, 0.1);
    // Visible area is the centre 1080x1080 square; the guide is its inner 80%.
    expect(rect.sx).toBeCloseTo(420 + 108);
    expect(rect.sy).toBeCloseTo(108);
    expect(rect.sw).toBeCloseTo(864);
    expect(rect.sh).toBeCloseTo(864);
  });

  it("uses the full frame when the aspect ratios match and inset is 0", () => {
    expect(visibleCoverGuideRect({ videoWidth: 640, videoHeight: 480, clientWidth: 320, clientHeight: 240 }, 0))
      .toEqual({ sx: 0, sy: 0, sw: 640, sh: 480 });
  });

  it("throws while the camera has no frame yet", () => {
    expect(() => visibleCoverGuideRect({ videoWidth: 0, videoHeight: 0, clientWidth: 0, clientHeight: 0 })).toThrow();
  });
});

describe("computeFrameStats", () => {
  it("sees a flat grey frame as blurry, edgeless and glare-free", () => {
    const stats = computeFrameStats(rgba(32, 24, () => [128, 128, 128]), 32, 24);
    expect(stats).toMatchObject({ blurScore: 0, edgeRatio: 0, glareRatio: 0, brightness: 128 });
  });

  it("sees fine stripes as sharp with many edges", () => {
    const stats = computeFrameStats(rgba(32, 24, (x) => (Math.floor(x / 2) % 2 === 0 ? [20, 20, 20] : [230, 230, 230])), 32, 24, 1920, 1080);
    expect(stats.blurScore).toBeGreaterThan(1_000);
    expect(stats.edgeRatio).toBe(1);
    expect(stats.width).toBe(1920);
  });

  it("measures glare from blown-out pixels", () => {
    const stats = computeFrameStats(rgba(10, 10, (x) => (x < 3 ? [255, 255, 255] : [100, 100, 100])), 10, 10);
    expect(stats.glareRatio).toBe(0.3);
  });
});

describe("motionScore and skin ratio", () => {
  it("is 0 without a previous frame and grows with change", () => {
    const a = new Float32Array(16).fill(100);
    const b = new Float32Array(16).fill(130);
    expect(motionScore(a, null)).toBe(0);
    expect(motionScore(a, a)).toBe(0);
    expect(motionScore(b, a)).toBe(30);
  });

  it("detects skin-tone pixels", () => {
    expect(skinToneRatioFromPixels(rgba(4, 4, () => [200, 150, 120]), 16)).toBe(1);
    expect(skinToneRatioFromPixels(rgba(4, 4, () => [40, 60, 200]), 16)).toBe(0);
  });
});

describe("evaluateDocumentFrame", () => {
  const desktop = getDocumentThresholds(false);
  const phone = getDocumentThresholds(true);

  it("is ready for a sharp, steady, well-lit document", () => {
    expect(evaluateDocumentFrame(goodSignals, desktop)).toEqual({ ready: true, issue: null, message: "Looking good - hold still" });
  });

  it("reports the most important problem first", () => {
    expect(evaluateDocumentFrame({ ...goodSignals, skinRatio: 0.6, brightness: 10 }, desktop).issue).toBe("face-in-guide");
    expect(evaluateDocumentFrame({ ...goodSignals, brightness: 40 }, desktop).issue).toBe("too-dark");
    expect(evaluateDocumentFrame({ ...goodSignals, quality: { ...goodQuality, glareRatio: 0.25 } }, desktop).issue).toBe("glare");
    expect(evaluateDocumentFrame({ ...goodSignals, motion: 15 }, desktop).issue).toBe("motion");
    expect(evaluateDocumentFrame({ ...goodSignals, quality: { ...goodQuality, blurScore: 20 } }, desktop).issue).toBe("blurry");
    expect(evaluateDocumentFrame({ ...goodSignals, quality: { ...goodQuality, edgeRatio: 0.005 } }, desktop).issue).toBe("no-document");
    expect(evaluateDocumentFrame({ ...goodSignals, quality: { ...goodQuality, glareRatio: 0.15 } }, desktop).issue).toBe("slight-glare");
  });

  it("is more forgiving on phones", () => {
    const shaky = { ...goodSignals, motion: 15, skinRatio: 0.4, brightness: 50 };
    expect(evaluateDocumentFrame(shaky, desktop).ready).toBe(false);
    expect(evaluateDocumentFrame(shaky, phone).ready).toBe(true);
  });
});
