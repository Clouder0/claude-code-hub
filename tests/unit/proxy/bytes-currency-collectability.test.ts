import { describe, expect, test } from "vitest";
import { ProxySession } from "@/app/v1/_lib/proxy/session";

/**
 * bytes 通货的可收性证明：setForwardedRequestBody 之后，完整解析树必须真正
 * 可被 GC 回收（仅通货 bytes 与投影存活）——这是 2026-09-03 午间 OOM 修复
 * （3× 堆内保留 → 1× 堆外）的核心机制断言。
 *
 * 需要 `--expose-gc` 才能确定性回收；未暴露时跳过（结构语义已由
 * forwarded-request-body-cache.test.ts 覆盖）。运行方式：
 * `NODE_OPTIONS=--expose-gc npx vitest run tests/unit/proxy/bytes-currency-collectability.test.ts`
 */
const gcAvailable = typeof (globalThis as { gc?: () => void }).gc === "function";
const maybeTest = gcAvailable ? test : test.skip;

function createSession(requestMessage: Record<string, unknown> = {}): ProxySession {
  return new (
    ProxySession as unknown as {
      new (init: {
        startTime: number;
        method: string;
        requestUrl: URL;
        headers: Headers;
        headerLog: string;
        request: { message: Record<string, unknown>; log: string; model: string | null };
        userAgent: string | null;
        context: unknown;
        clientAbortSignal: AbortSignal | null;
      }): ProxySession;
    }
  )({
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL("http://localhost/v1/responses"),
    headers: new Headers(),
    headerLog: "",
    request: { message: requestMessage, log: "(test)", model: null },
    userAgent: null,
    context: {},
    clientAbortSignal: null,
  });
}

describe("bytes-currency collectability", () => {
  maybeTest("tree is collectable after setForwardedRequestBody; currency bytes remain", async () => {
    const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
    // 树在独立 async 任务内创建并序列化；await 弹掉其栈帧、setImmediate 让
    // 事件循环复用该栈区，避免保守栈扫描把陈旧槽位当强引用。
    const prepare = async (): Promise<{ treeRef: WeakRef<object>; bodyString: string }> => {
      const filler = "x".repeat(64 * 1024);
      const tree: Record<string, unknown> = {
        model: "gpt-5.6-codex",
        stream: true,
        input: Array.from({ length: 128 }, (_, i) => ({ role: "user", content: `${i}${filler}` })),
      };
      const session = createSession();
      const bodyString = JSON.stringify(tree);
      expect(bodyString.length).toBeGreaterThan(4 * 1024 * 1024);
      session.setForwardedRequestBody(bodyString, tree);
      expect(session.isRequestMessageProjection()).toBe(true);
      (globalThis as { sessionUnderObservation?: ProxySession }).sessionUnderObservation = session;
      return { treeRef: new WeakRef(tree), bodyString };
    };

    const { treeRef, bodyString } = await prepare();
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    gc();
    expect(treeRef.deref()).toBeUndefined();

    // 回收后通货与投影读取不受影响。
    const session = (globalThis as { sessionUnderObservation: ProxySession }).sessionUnderObservation;
    expect(session.getBillingModel()).toBe("gpt-5.6-codex");
    expect(session.getForwardedRequestBodyText()).toBe(bodyString);
    delete (globalThis as { sessionUnderObservation?: ProxySession }).sessionUnderObservation;
  });

  maybeTest("N concurrent simulated requests retain ~1×body external bytes, not ~3× heap", () => {
    const gc = (globalThis as { gc: () => void }).gc;
    const N = 8;
    const fillerChars = 4 * 1024 * 1024; // 单个 body ≈ 4MB（一位字符 ≈ 1 字节）

    gc();
    gc();
    const before = process.memoryUsage();

    const sessions: ProxySession[] = [];
    for (let i = 0; i < N; i++) {
      const session = createSession();
      // 模拟 doForward：树在块内创建、序列化（局部 string）、set（树退位）——
      // 块结束后树与序列化局部量均可回收，仅通货 bytes 存活。
      {
        const filler = "y".repeat(fillerChars);
        const tree: Record<string, unknown> = {
          model: "gpt-5.6-codex",
          stream: true,
          input: [{ role: "user", content: filler }],
        };
        session.setForwardedRequestBody(JSON.stringify(tree), tree);
      }
      sessions.push(session);
    }

    gc();
    gc();
    const after = process.memoryUsage();

    const bodyBytesApprox = fillerChars + 256;
    const externalDelta = after.arrayBuffers - before.arrayBuffers;
    const heapDelta = after.heapUsed - before.heapUsed;
    // 通货：≈ N × bodyBytes 的 ArrayBuffer（外部），留 JSON 膨胀与杂项余量。
    expect(externalDelta).toBeGreaterThan(N * bodyBytesApprox * 0.75);
    expect(externalDelta).toBeLessThan(N * bodyBytesApprox * 1.5);
    // 树与序列化串不再驻留堆：heapUsed 增量远小于旧语义的 N × 3×body。
    expect(heapDelta).toBeLessThan(N * bodyBytesApprox * 0.75);

    for (const session of sessions) {
      expect(session.getBillingModel()).toBe("gpt-5.6-codex");
    }
  });
});
