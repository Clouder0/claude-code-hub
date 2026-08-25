import { describe, expect, it } from "vitest";
import { submitReview } from "@/lib/cyber-check/client";
import { projectFinalResponsesRequest } from "@/lib/cyber-check/projection";

const serviceUrl = process.env.CYBER_CHECK_E2E_URL;
const gatewayToken = process.env.CYBER_CHECK_E2E_TOKEN;
const runLive = Boolean(serviceUrl && gatewayToken);

describe.runIf(runLive)("CCH to cyber-check live contract", () => {
  it("submits a CCH projection to the real Rust ingress and reuses its idempotent result", async () => {
    const message = {
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Work only in the controlled repository." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Add a bounded parser regression test." }],
        },
      ],
      store: false,
      stream: true,
    };
    const bodyString = JSON.stringify(message);
    const packet = projectFinalResponsesRequest({
      identity: {
        gateway: "cch-live-contract",
        requestId: "1",
        principalId: "7",
        credentialId: "9",
        sessionId: "session-cch-live-contract",
        sequence: 1,
      },
      message,
      bodyString,
    });
    const config = {
      mode: "shadow" as const,
      baseUrl: new URL(serviceUrl as string),
      gatewayToken: gatewayToken as string,
      gatewayId: "cch-live-contract",
    };

    const first = await submitReview(config, packet);
    const repeated = await submitReview(config, packet);

    expect(first).toMatchObject({ status: "completed", decision: "allow" });
    expect(repeated).toEqual(first);
  });
});
