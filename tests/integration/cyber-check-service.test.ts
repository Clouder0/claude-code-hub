import { describe, expect, it } from "vitest";
import { reportProviderEvent, submitReview } from "@/lib/cyber-check/client";
import { projectFinalResponsesRequest } from "@/lib/cyber-check/projection";

const serviceUrl = process.env.CYBER_CHECK_E2E_URL;
const gatewayToken = process.env.CYBER_CHECK_E2E_TOKEN;
const runLive = Boolean(serviceUrl && gatewayToken);

describe.runIf(runLive)("CCH to cyber-check live contract", () => {
  it("correlates a provider cyber event and denies the next request in that session", async () => {
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
      zstdMinBytes: 1,
    };

    const first = await submitReview(config, packet);
    const repeated = await submitReview(config, packet);

    expect(first).toMatchObject({ status: "completed", decision: "allow" });
    expect(repeated).toEqual(first);

    await reportProviderEvent(config, {
      schema_version: "cyber-check.provider-event.v1",
      identity: packet.identity,
      upstream_provider_id: "17",
      event: {
        type: "policy_rejection",
        code: "cyber_policy",
      },
    });

    const nextMessage = {
      ...message,
      input: [
        ...message.input,
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Now add a serializer regression test." }],
        },
      ],
    };
    const nextPacket = projectFinalResponsesRequest({
      identity: {
        gateway: "cch-live-contract",
        requestId: "2",
        principalId: "7",
        credentialId: "9",
        sessionId: "session-cch-live-contract",
        sequence: 2,
      },
      message: nextMessage,
      bodyString: JSON.stringify(nextMessage),
    });

    const restricted = await submitReview(config, nextPacket);
    expect(restricted).toMatchObject({
      status: "completed",
      decision: "deny",
      reason: "active_restriction",
    });
  });
});
