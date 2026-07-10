import { afterEach, describe, expect, it, vi } from "vitest";

describe("instrumentation runtime isolation", () => {
  afterEach(() => {
    vi.doUnmock("@/instrumentation-node");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("does not load Node instrumentation in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const registerNode = vi.fn();
    let nodeModuleLoaded = false;

    vi.doMock("@/instrumentation-node", () => {
      nodeModuleLoaded = true;
      return { register: registerNode };
    });

    const { register } = await import("@/instrumentation");
    await register();

    expect(nodeModuleLoaded).toBe(false);
    expect(registerNode).not.toHaveBeenCalled();
  });

  it("loads and runs Node instrumentation in the Node.js runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const registerNode = vi.fn().mockResolvedValue(undefined);
    let nodeModuleLoaded = false;

    vi.doMock("@/instrumentation-node", () => {
      nodeModuleLoaded = true;
      return { register: registerNode };
    });

    const { register } = await import("@/instrumentation");
    await register();

    expect(nodeModuleLoaded).toBe(true);
    expect(registerNode).toHaveBeenCalledOnce();
  });
});
