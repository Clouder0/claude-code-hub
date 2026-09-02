import { describe, expect, test } from "vitest";
import { BoundedStreamTextAccumulator } from "@/app/v1/_lib/proxy/response-handler";

const encoder = new TextEncoder();

function pushText(acc: BoundedStreamTextAccumulator, text: string): void {
  acc.pushBytes(encoder.encode(text));
}

describe("BoundedStreamTextAccumulator finalization release", () => {
  test("finish() 释放原始 chunk 字节但保留快照字段与计数器", () => {
    const acc = new BoundedStreamTextAccumulator();
    pushText(acc, "event: response.created\ndata: {}\n\n");
    pushText(acc, 'data: {"delta":"hello"}\n\n');

    const snapshot = acc.finish();

    expect(snapshot.text).toContain("response.created");
    expect(snapshot.chunkCount).toBe(2);
    expect(snapshot.totalBytes).toBeGreaterThan(0);
    expect(snapshot.bufferedBytes).toBeGreaterThan(0);

    // chunk 字节已释放：缓存计数归零，但对外语义字段来自快照，不受影响
    expect(acc.bufferedByteCount).toBe(0);
    expect(acc.chunkCount).toBe(2);
    expect(acc.totalByteCount).toBe(snapshot.totalBytes);
    expect(acc.isTruncated).toBe(snapshot.truncated);

    // 二次 finish 幂等：返回缓存快照，不从已清空的数组重建
    const again = acc.finish();
    expect(again).toBe(snapshot);
  });

  test("finish() 后继续 pushBytes 仍正常累积（异常路径兼容）", () => {
    const acc = new BoundedStreamTextAccumulator();
    pushText(acc, "first");
    const first = acc.finish();
    expect(first.text).toBe("first");

    pushText(acc, "-second");
    const second = acc.finish();

    expect(second.text).toBe("-second");
    expect(second.chunkCount).toBe(2);
    expect(second.totalBytes).toBe(12);
  });

  test("releaseRetainedText() 断开文本引用，计数器保留供 getCollectedChunkCount 回退", () => {
    const acc = new BoundedStreamTextAccumulator();
    pushText(acc, 'data: {"usage":1}\n\n');
    const snapshot = acc.finish();
    expect(snapshot.text).not.toBe("");

    acc.releaseRetainedText();

    // 计数器仍在：观测回退路径（lastStreamTextSnapshot 置空后）读取的是它
    expect(acc.chunkCount).toBe(1);
    expect(acc.totalByteCount).toBeGreaterThan(0);
  });

  test("超限截断语义在释放后仍可从快照读出", () => {
    const acc = new BoundedStreamTextAccumulator();
    const bigChunk = "x".repeat(256 * 1024);
    for (let i = 0; i < 60; i += 1) {
      pushText(acc, bigChunk);
    }
    const snapshot = acc.finish();

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.totalBytes).toBe(60 * 256 * 1024);
    expect(snapshot.bufferedBytes).toBeLessThan(snapshot.totalBytes);
    expect(acc.bufferedByteCount).toBe(0);
  });
});
