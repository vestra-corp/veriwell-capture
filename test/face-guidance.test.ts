import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { describe, expect, it } from "vitest";
import { canCaptureAfterHold, evaluateFaceGuidance, type TurnDirection } from "../src/face-guidance.js";

function result(input: {
  noseX?: number;
  blink?: number;
  smile?: number;
  includeFace?: boolean;
  scale?: number;
} = {}): FaceLandmarkerResult {
  const scale = input.scale ?? 1;
  const landmarks = Array.from({ length: 478 }, (_, index) => ({
    x: 0.5 + ((index % 2 === 0 ? 0.35 : 0.65) - 0.5) * scale,
    y: 0.5 + ((index % 3 === 0 ? 0.3 : 0.7) - 0.5) * scale,
    z: 0,
    visibility: 1,
  }));
  landmarks[1] = { x: input.noseX ?? 0.5, y: 0.5, z: 0, visibility: 1 };
  landmarks[33] = { x: 0.42, y: 0.44, z: 0, visibility: 1 };
  landmarks[263] = { x: 0.58, y: 0.44, z: 0, visibility: 1 };
  const categories = [
    { categoryName: "eyeBlinkLeft", score: input.blink ?? 0, index: 0, displayName: "" },
    { categoryName: "eyeBlinkRight", score: input.blink ?? 0, index: 1, displayName: "" },
    { categoryName: "mouthSmileLeft", score: input.smile ?? 0, index: 2, displayName: "" },
    { categoryName: "mouthSmileRight", score: input.smile ?? 0, index: 3, displayName: "" },
  ];
  return {
    faceLandmarks: input.includeFace === false ? [] : [landmarks],
    faceBlendshapes: [{ categories, headIndex: 0, headName: "blendshapes" }],
    facialTransformationMatrixes: [],
  };
}

describe("evaluateFaceGuidance", () => {
  it("requires one centred, correctly-sized face", () => {
    expect(evaluateFaceGuidance(result({ includeFace: false }), "centre", null)).toMatchObject({ ready: false, faceFound: false });
    expect(evaluateFaceGuidance(result(), "centre", null)).toMatchObject({ ready: true, centered: true, sizeOkay: true });
  });

  it("asks the user to move closer or farther away", () => {
    expect(evaluateFaceGuidance(result({ scale: 0.4 }), "centre", null)).toMatchObject({ ready: false, sizeOkay: false, message: "Move a little closer" });
    expect(evaluateFaceGuidance(result({ scale: 2.9 }), "centre", null)).toMatchObject({ ready: false, sizeOkay: false, message: "Move a little farther away" });
  });

  it("recognises opposite head turns", () => {
    const first = evaluateFaceGuidance(result({ noseX: 0.46 }), "left", null);
    expect(first.ready).toBe(true);
    expect(first.turnDirection).not.toBeNull();
    const second = evaluateFaceGuidance(result({ noseX: 0.54 }), "right", first.turnDirection as TurnDirection);
    expect(second).toMatchObject({ ready: true, gestureDetected: true });
    const same = evaluateFaceGuidance(result({ noseX: 0.46 }), "right", first.turnDirection as TurnDirection);
    expect(same).toMatchObject({ ready: false, message: "Turn your head to the other side" });
  });

  it("requires both eyes for blink and both smile blendshapes", () => {
    expect(evaluateFaceGuidance(result({ blink: 0.8 }), "blink", null).ready).toBe(true);
    expect(evaluateFaceGuidance(result({ smile: 0.7 }), "smile", null).ready).toBe(true);
    expect(evaluateFaceGuidance(result(), "blink", null).ready).toBe(false);
  });
});

describe("canCaptureAfterHold", () => {
  const base = { ready: false, faceFound: true, centered: true, sizeOkay: true, gestureDetected: false, turnDirection: null, message: "Hold still" } as const;

  it("captures after hold even when the gesture score flickers", () => {
    expect(canCaptureAfterHold(base, true)).toBe(true);
    expect(canCaptureAfterHold({ ...base, centered: false, message: "Centre your face" }, true)).toBe(false);
  });

  it("never captures before the hold has elapsed", () => {
    expect(canCaptureAfterHold({ ...base, ready: true }, false)).toBe(false);
  });
});
