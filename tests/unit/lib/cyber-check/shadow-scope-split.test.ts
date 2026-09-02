import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFinalResponsesShadowObservation } from "@/lib/cyber-check/admission";
import { cyberCheckEncodingCapacity } from "@/lib/cyber-check/capacity";

const mocks = vi.hoisted(() => ({
  getEnvConfig: vi.fn(),
  submitReview: vi.fn(),
}));

vi.mock("@/lib/config/env.schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config/env.schema")>();
  return {
    ...actual,
    getEnvConfig: () => ({ ...actual.getEnvConfig(), ...mocks.getEnvConfig() }),
  };
});

vi.mock("@/lib/cyber-check/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cyber-check/client")>();
  return {
    ...actual,
    submitReview: mocks.submitReview,
  };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function shadowEnv() {
  mocks.getEnvConfig.mockReturnValue({
    CYBER_CHECK_MODE: "shadow",
    CYBER_CHECK_URL: "http://127.0.0.1:8090",
    CYBER_CHECK_GATEWAY_TOKEN: "gateway-token",
    CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
    CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
  });
}

function createInput() {
  const message = { model: "gpt-5.6-sol", stream: true, input: "observe me" };
  const bodyString = JSON.stringify(message);
  const session = {
    headers: new Headers({ "content-type": "application/json" }),
    sessionId: "sess-1",
    requestSequence: 3,
    clientAbortSignal: null,
    messageContext: { id: "req-1", user: { id: 7 } },
    getStableRequestIdentity: () => ({ requestId: "req-1", principalId: "7" }),
    setCyberCheckObservation: vi.fn(),
    getCyberCheckObservation: vi.fn(() => null),
    clearCyberCheckObservation: vi.fn(),
  };
  const provider = { id: 41, providerType: "codex" };
  return { session, provider, message, bodyString };
}

describe("shadow observation scope discipline (request-body retention fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shadowEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("charges encoding capacity before upload and releases it when the upload rejects", async () => {
    const input = createInput();
    let rejectUpload!: (reason: Error) => void;
    mocks.submitReview.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectUpload = reject;
        })
    );

    const prepared = prepareFinalResponsesShadowObservation({
      session: input.session as never,
      provider: input.provider as never,
      requestPath: "/v1/responses",
      message: input.message,
      bodyString: input.bodyString,
    });
    expect(prepared).not.toBeNull();
    expect(input.session.setCyberCheckObservation).toHaveBeenCalledOnce();
    expect(mocks.submitReview).not.toHaveBeenCalled(); // 无同步前缀
    const beforeCharge = cyberCheckEncodingCapacity.snapshot();

    const completion = (() => {
      const captured = input.session.setCyberCheckObservation.mock.calls[0][0] as {
        completion: Promise<{ status: string }>;
      };
      return captured.completion;
    })();
    prepared!.start();
    await vi.waitFor(() => expect(mocks.submitReview).toHaveBeenCalledOnce());

    // 上传等待期间:容量租约在途(计费 = 64KB + 3 × bodyBytes)。
    const duringCharge = cyberCheckEncodingCapacity.snapshot();
    expect(duringCharge - beforeCharge).toBe(64 * 1024 + 3 * Buffer.byteLength(input.bodyString));

    rejectUpload(new Error("upload failed"));
    await expect(completion).resolves.toMatchObject({ status: "capture_gap" });
    // 上传结算后:容量退回,原始 message/bodyString 的保留随之结束。
    expect(cyberCheckEncodingCapacity.snapshot()).toBe(beforeCharge);
  });

  it("projects the packet before awaiting the upload (sync prologue inside the deferred task)", async () => {
    const input = createInput();
    let resolveUpload!: (value: unknown) => void;
    mocks.submitReview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpload = resolve;
        })
    );

    const prepared = prepareFinalResponsesShadowObservation({
      session: input.session as never,
      provider: input.provider as never,
      requestPath: "/v1/responses",
      message: input.message,
      bodyString: input.bodyString,
    });
    const captured = input.session.setCyberCheckObservation.mock.calls[0][0] as {
      completion: Promise<{ status: string }>;
    };
    prepared!.start();
    // setImmediate 任务跑完即已调用 submitReview——投影在等待上传之前完成,
    // 上传 promise 挂起不阻塞投影(顺序:project → upload)。
    await vi.waitFor(() => expect(mocks.submitReview).toHaveBeenCalledOnce());
    const [, packet] = mocks.submitReview.mock.calls[0] as unknown as [
      unknown,
      { source: { body_sha256?: string } },
    ];
    expect(packet.source.body_sha256).toBeTypeOf("string");

    resolveUpload({ status: "completed", decision: "allow", enforcement_mode: "shadow" });
    await expect(captured.completion).resolves.toMatchObject({ status: "recorded" });
  });
});
