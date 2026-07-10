import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types/provider";

const wsState = vi.hoisted(() => ({
  closeErrorsWithoutListener: 0,
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class RejectingWebSocket extends EventEmitter {
    readyState = 0;

    constructor() {
      super();
      queueMicrotask(() => {
        this.emit("unexpected-response", {}, { statusCode: 404, statusMessage: "Not Found" });
      });
    }

    close() {
      this.readyState = 2;
      process.nextTick(() => {
        if (this.listenerCount("error") === 0) {
          wsState.closeErrorsWithoutListener += 1;
        } else {
          this.emit(
            "error",
            new Error("WebSocket was closed before the connection was established")
          );
        }
        this.readyState = 3;
        this.emit("close", 1006, Buffer.alloc(0));
      });
    }

    terminate() {
      if (this.readyState === 0) {
        this.close();
        return;
      }
      this.readyState = 3;
    }
  }

  return { default: RejectingWebSocket };
});

import { tryResponsesWebsocketUpstream } from "../upstream-adapter";

function codexProvider(): Provider {
  return {
    id: 1,
    name: "rejecting-codex",
    providerType: "codex",
    costMultiplier: 1,
  } as Provider;
}

describe("tryResponsesWebsocketUpstream close safety", () => {
  afterEach(() => {
    wsState.closeErrorsWithoutListener = 0;
  });

  it("keeps a listener for delayed close errors after an upgrade rejection fallback", async () => {
    const result = await tryResponsesWebsocketUpstream({
      provider: codexProvider(),
      upstreamUrl: "http://upstream.invalid/v1/responses",
      upstreamHeaders: new Headers({ authorization: "Bearer sk-test" }),
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    expect(result).toMatchObject({
      failed: true,
      reason: "ws_upgrade_rejected",
      cacheableAsUnsupported: true,
    });

    await new Promise<void>((resolve) => process.nextTick(resolve));

    expect(wsState.closeErrorsWithoutListener).toBe(0);
  });
});
