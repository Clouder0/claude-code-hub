/**
 * Next.js Instrumentation Hook
 *
 * Keep this entrypoint runtime-neutral. Next.js compiles it for both Node.js
 * and Edge runtimes, so importing Node-only initialization here would pull
 * database and Redis dependencies into the Edge module graph.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { register: registerNode } = await import("@/instrumentation-node");
  await registerNode();
}
