import { afterEach, describe, expect, it, vi } from "vitest";
import { cameraErrorCode, cameraErrorMessage, requestCameraStream } from "../src/camera.js";

function stubCamera(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>, secure = true) {
  vi.stubGlobal("window", { isSecureContext: secure });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(getUserMedia) } });
  return navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>;
}

describe("camera errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains insecure pages and missing APIs", () => {
    vi.stubGlobal("window", { isSecureContext: false });
    expect(cameraErrorCode(new Error("x"))).toBe("insecure-context");
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", {});
    expect(cameraErrorCode(new Error("x"))).toBe("unsupported");
  });

  it("maps DOMException names", () => {
    stubCamera(async () => ({}) as MediaStream);
    expect(cameraErrorCode(new DOMException("no", "NotAllowedError"))).toBe("permission-denied");
    expect(cameraErrorCode(new DOMException("no", "NotFoundError"))).toBe("not-found");
    expect(cameraErrorCode(new DOMException("no", "NotReadableError"))).toBe("busy");
    expect(cameraErrorCode(new DOMException("no", "OverconstrainedError"))).toBe("overconstrained");
    expect(cameraErrorCode({ name: "SecurityError" })).toBe("security");
    expect(cameraErrorMessage(new Error("?"))).toMatch(/could not start/);
  });
});

describe("requestCameraStream", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("relaxes constraints until a camera starts", async () => {
    const stream = { id: "stream" } as MediaStream;
    let calls = 0;
    const getUserMedia = stubCamera(async () => {
      calls += 1;
      if (calls < 3) throw new DOMException("no", "OverconstrainedError");
      return stream;
    });
    await expect(requestCameraStream("environment")).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once permission is denied", async () => {
    const getUserMedia = stubCamera(async () => {
      throw new DOMException("no", "NotAllowedError");
    });
    await expect(requestCameraStream("user")).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
