import { beforeEach, describe, expect, it, vi } from "vitest";

let redisClientRef: any;
let pipelineRef: any;
let redisHashes: Map<string, Map<string, string>>;

function getHash(key: string): Map<string, string> {
  let hash = redisHashes.get(key);
  if (!hash) {
    hash = new Map();
    redisHashes.set(key, hash);
  }
  return hash;
}

function readHash(key: string): Record<string, string> {
  return Object.fromEntries(getHash(key));
}

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock("@/lib/redis", () => ({
  getRedisClient: () => redisClientRef,
}));

describe("SessionManager request-scoped cost publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisHashes = new Map();
    const pipelineCommands: Array<() => void> = [];
    pipelineRef = {
      hset: vi.fn((key: string, fieldOrValues: string | Record<string, string>, value?: string) => {
        pipelineCommands.push(() => {
          const hash = getHash(key);
          if (typeof fieldOrValues === "string") {
            hash.set(fieldOrValues, value ?? "");
            return;
          }
          for (const [field, fieldValue] of Object.entries(fieldOrValues)) {
            hash.set(field, fieldValue);
          }
        });
        return pipelineRef;
      }),
      expire: vi.fn(() => pipelineRef),
      exec: vi.fn(async () => {
        for (const command of pipelineCommands.splice(0)) command();
        return [];
      }),
    };
    redisClientRef = {
      status: "ready",
      pipeline: vi.fn(() => pipelineRef),
      eval: vi.fn(async (_script: string, keyCount: number, ...args: string[]) => {
        if (keyCount === 2) {
          const [usageKey, infoKey, sequence, cost, _ttl, status, ...optionalValues] = args;
          const hash = getHash(usageKey);
          const incomingSequence = Number(sequence);
          const usageSequence = Number(hash.get("requestSequence"));
          const costSequence = Number(hash.get("costRequestSequence"));
          const currentSequence = Math.max(
            Number.isFinite(usageSequence) ? usageSequence : 0,
            Number.isFinite(costSequence) ? costSequence : 0
          );
          if (!Number.isFinite(incomingSequence) || incomingSequence < currentSequence) return 0;

          const usageIsComplete = usageSequence === incomingSequence && hash.has("status");
          if (!usageIsComplete) {
            hash.set("requestSequence", sequence);
            hash.set("status", status);
            const optionalFields = [
              "inputTokens",
              "outputTokens",
              "cacheCreationInputTokens",
              "cacheReadInputTokens",
              "statusCode",
              "errorMessage",
            ];
            for (const field of optionalFields) hash.delete(field);
            optionalFields.forEach((field, index) => {
              const value = optionalValues[index];
              if (value) hash.set(field, value);
            });
            getHash(infoKey).set("statusRequestSequence", sequence);
            getHash(infoKey).set("status", status);
          }

          const incomingCost = cost === "" ? null : Number(cost);
          if (!Number.isFinite(costSequence) || incomingSequence > costSequence) {
            hash.set("costRequestSequence", sequence);
            if (incomingCost !== null) hash.set("costUsd", cost);
            else hash.delete("costUsd");
          } else if (incomingSequence === costSequence && incomingCost !== null) {
            const currentCost = Number(hash.get("costUsd") ?? 0);
            if (incomingCost >= currentCost) hash.set("costUsd", cost);
          }
          return usageIsComplete ? 1 : 2;
        }

        const [usageKey, sequence, cost] = args;
        const hash = getHash(usageKey);
        const incomingSequence = Number(sequence);
        const incomingCost = Number(cost);
        const usageSequence = Number(hash.get("requestSequence"));
        const costSequence = Number(hash.get("costRequestSequence"));
        const currentSequence = Math.max(
          Number.isFinite(usageSequence) ? usageSequence : 0,
          Number.isFinite(costSequence) ? costSequence : 0
        );
        if (
          !Number.isFinite(incomingSequence) ||
          !Number.isFinite(incomingCost) ||
          incomingSequence < currentSequence
        ) {
          return 0;
        }
        if (!Number.isFinite(costSequence) || incomingSequence > costSequence) {
          hash.set("costRequestSequence", sequence);
          hash.set("costUsd", cost);
          return 1;
        }
        if (incomingSequence === costSequence) {
          const currentCost = Number(hash.get("costUsd") ?? 0);
          if (incomingCost >= currentCost) hash.set("costUsd", cost);
          return 1;
        }
        return 0;
      }),
    };
  });

  it("keeps every protected usage field on the newest request when an older request finishes late", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 2,
      inputTokens: 20,
      outputTokens: 2,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 6,
      costUsd: "0.02",
      status: "completed",
      statusCode: 200,
    });
    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 1,
      inputTokens: 10,
      outputTokens: 1,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3,
      costUsd: "0.50",
      status: "error",
      statusCode: 500,
      errorMessage: "late failure",
    });

    expect(readHash("session:session-1:usage")).toMatchObject({
      requestSequence: "2",
      costRequestSequence: "2",
      inputTokens: "20",
      outputTokens: "2",
      cacheCreationInputTokens: "4",
      cacheReadInputTokens: "6",
      costUsd: "0.02",
      status: "completed",
      statusCode: "200",
    });
    expect(readHash("session:session-1:usage")).not.toHaveProperty("errorMessage");
    expect(readHash("session:session-1:info")).toMatchObject({
      statusRequestSequence: "2",
      status: "completed",
    });
  });

  it("only lets the authoritative total cost increase within one request sequence", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 3,
      inputTokens: 30,
      costUsd: "0.30",
      status: "completed",
      statusCode: 200,
    });
    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 3,
      inputTokens: 999,
      costUsd: "0.10",
      status: "error",
      statusCode: 500,
    });
    await SessionManager.updateSessionCostFromRequest("session-1", 3, "0.45");
    await SessionManager.updateSessionCostFromRequest("session-1", 3, "0.40");

    expect(readHash("session:session-1:usage")).toMatchObject({
      requestSequence: "3",
      costRequestSequence: "3",
      inputTokens: "30",
      costUsd: "0.45",
      status: "completed",
      statusCode: "200",
    });
  });

  it("lets a newer request replace a higher old cost and clears absent stale fields", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 4,
      inputTokens: 40,
      outputTokens: 4,
      cacheCreationInputTokens: 8,
      cacheReadInputTokens: 12,
      costUsd: "9.00",
      status: "error",
      statusCode: 500,
      errorMessage: "old error",
    });
    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 5,
      inputTokens: 5,
      costUsd: "0.05",
      status: "completed",
      statusCode: 200,
    });

    expect(readHash("session:session-1:usage")).toEqual({
      requestSequence: "5",
      costRequestSequence: "5",
      inputTokens: "5",
      costUsd: "0.05",
      status: "completed",
      statusCode: "200",
    });
  });

  it("allows a newer cost-only settlement before its full usage and still rejects older payloads", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 6,
      inputTokens: 60,
      costUsd: "6.00",
      status: "completed",
    });
    await SessionManager.updateSessionCostFromRequest("session-1", 7, "0.07");
    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 6,
      inputTokens: 666,
      costUsd: "66.00",
      status: "error",
    });
    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 7,
      inputTokens: 70,
      costUsd: "0.10",
      status: "completed",
    });

    expect(readHash("session:session-1:usage")).toMatchObject({
      requestSequence: "7",
      costRequestSequence: "7",
      inputTokens: "70",
      costUsd: "0.10",
      status: "completed",
    });
  });

  it("routes sequenced costs through the atomic monotonic updater", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 7,
      inputTokens: 100,
      costUsd: "0.125",
      status: "completed",
      statusCode: 200,
    });

    expect(pipelineRef.hset).not.toHaveBeenCalled();
    expect(redisClientRef.eval).toHaveBeenCalledWith(
      expect.stringContaining("should_replace_usage"),
      2,
      "session:session-1:usage",
      "session:session-1:info",
      "7",
      "0.125",
      expect.any(String),
      "completed",
      "100",
      "",
      "",
      "",
      "200",
      ""
    );
  });

  it("preserves the legacy direct HSET path when no request sequence is available", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    await SessionManager.updateSessionUsage("legacy-session", {
      costUsd: "0.25",
      status: "completed",
    });

    expect(pipelineRef.hset).toHaveBeenCalledWith(
      "session:legacy-session:usage",
      expect.objectContaining({ costUsd: "0.25" })
    );
    expect(redisClientRef.eval).not.toHaveBeenCalled();
  });

  it("clears an older request cost when a newer sequenced usage has no settled cost", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 8,
      inputTokens: 80,
      costUsd: "8.00",
      status: "completed",
    });
    await SessionManager.updateSessionUsage("session-1", {
      requestSequence: 9,
      inputTokens: 90,
      status: "completed",
    });
    await SessionManager.updateSessionCostFromRequest("session-1", 8, "80.00");

    expect(readHash("session:session-1:usage")).toMatchObject({
      requestSequence: "9",
      costRequestSequence: "9",
      inputTokens: "90",
      status: "completed",
    });
    expect(readHash("session:session-1:usage")).not.toHaveProperty("costUsd");
  });

  it("rejects invalid sequence or cost inputs before evaluating Lua", async () => {
    const { SessionManager } = await import("@/lib/session-manager");

    await SessionManager.updateSessionCostFromRequest("session-1", 0, "0.1");
    await SessionManager.updateSessionCostFromRequest("session-1", 1, "NaN");

    expect(redisClientRef.eval).not.toHaveBeenCalled();
  });
});
