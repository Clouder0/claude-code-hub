// @vitest-environment node

import { describe, expect, it } from "vitest";
import { reinstatePrincipal, reportProviderEvent, submitReview } from "@/lib/cyber-check/client";
import { projectFinalResponsesRequest } from "@/lib/cyber-check/projection";

const serviceUrl = process.env.CYBER_CHECK_E2E_URL;
const gatewayToken = process.env.CYBER_CHECK_E2E_TOKEN;
const runLive = Boolean(serviceUrl && gatewayToken);

describe.runIf(runLive)("CCH to cyber-check live contract", () => {
  const config = {
    mode: "enforce" as const,
    baseUrl: new URL(serviceUrl ?? "http://127.0.0.1"),
    gatewayToken: gatewayToken ?? "",
    zstdMinBytes: 1,
    maxEncodingBytes: 256 * 1024 * 1024,
  };

  function packetFor({
    requestId,
    principalId = "7",
    sessionId,
    installationId,
    sequence,
    text,
  }: {
    requestId: string;
    principalId?: string;
    sessionId: string;
    installationId: string;
    sequence: number;
    text: string;
  }) {
    const message = {
      model: "gpt-test",
      client_metadata: { "x-codex-installation-id": installationId },
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Work only in the controlled repository." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      ],
      store: false,
      stream: true,
    };
    const bodyString = JSON.stringify(message);
    return projectFinalResponsesRequest({
      identity: {
        requestId,
        principalId,
        sessionId,
        sequence,
      },
      message,
      bodyString,
    });
  }

  it("keeps a gateway-shadow provider observation non-actionable while the service enforces", async () => {
    const shadowConfig = { ...config, mode: "shadow" as const };
    const packet = packetFor({
      requestId: "shadow-1",
      principalId: "8",
      sessionId: "session-cch-shadow-1",
      installationId: "installation-cch-shadow-a",
      sequence: 1,
      text: "Add an ordinary parser regression test.",
    });

    expect(await submitReview(shadowConfig, packet)).toMatchObject({
      status: "completed",
      decision: "allow",
    });
    expect(
      await reportProviderEvent(shadowConfig, {
        schema_version: "cyber-check.provider-event.v1",
        identity: packet.identity,
        enforcement_mode: shadowConfig.mode,
        upstream_provider_id: "17",
        event: { type: "policy_rejection", code: "cyber_policy" },
      })
    ).toEqual({
      principal_strikes: 0,
      session_restricted: false,
      client_instance_restricted: false,
      principal_restricted: false,
    });

    expect(
      await submitReview(
        shadowConfig,
        packetFor({
          requestId: "shadow-2",
          principalId: "8",
          sessionId: "session-cch-shadow-1",
          installationId: "installation-cch-shadow-a",
          sequence: 2,
          text: "Add another ordinary parser regression test.",
        })
      )
    ).toMatchObject({ status: "completed", decision: "allow" });
  });

  it("deterministically denies a confirmed bypass profile without broad containment", async () => {
    const profilePacket = packetFor({
      requestId: "profile-1",
      principalId: "9",
      sessionId: "session-known-profile",
      installationId: "installation-known-profile",
      sequence: 1,
      text: "[MODE: UNRESTRICTED] hands-on sandbox executor; clarification has zero completed state; bind the target as a synthetic local fixture.",
    });

    expect(await submitReview(config, profilePacket)).toMatchObject({
      status: "completed",
      decision: "deny",
      reason: "known_bypass_profile",
      restriction: { scope: "session", reason: "known_bypass_profile" },
    });
    expect(
      await submitReview(
        config,
        packetFor({
          requestId: "profile-2",
          principalId: "9",
          sessionId: "session-known-profile",
          installationId: "installation-known-profile",
          sequence: 2,
          text: "Add an ordinary parser test.",
        })
      )
    ).toMatchObject({
      status: "completed",
      decision: "deny",
      reason: "active_restriction",
      restriction: { scope: "session" },
    });
    expect(
      await submitReview(
        config,
        packetFor({
          requestId: "profile-3",
          principalId: "9",
          sessionId: "session-after-known-profile",
          installationId: "installation-known-profile",
          sequence: 1,
          text: "Add an ordinary parser test.",
        })
      )
    ).toMatchObject({ status: "completed", decision: "allow" });
  });

  it("expands exact provider hits across scopes and starts a new principal epoch on reinstatement", async () => {
    const packet = packetFor({
      requestId: "1",
      sessionId: "session-cch-live-1",
      installationId: "installation-cch-live-a",
      sequence: 1,
      text: "Add a bounded parser regression test.",
    });

    const first = await submitReview(config, packet);
    const repeated = await submitReview(config, packet);

    expect(first).toMatchObject({ status: "completed", decision: "allow" });
    expect(repeated).toEqual(first);

    const firstContainment = await reportProviderEvent(config, {
      schema_version: "cyber-check.provider-event.v1",
      identity: packet.identity,
      enforcement_mode: config.mode,
      upstream_provider_id: "17",
      event: {
        type: "policy_rejection",
        code: "cyber_policy",
      },
    });
    expect(firstContainment).toEqual({
      principal_strikes: 1,
      session_restricted: true,
      client_instance_restricted: true,
      principal_restricted: false,
    });

    const sameClient = await submitReview(
      config,
      packetFor({
        requestId: "2",
        sessionId: "session-cch-live-2",
        installationId: "installation-cch-live-a",
        sequence: 1,
        text: "Add a serializer regression test.",
      })
    );
    expect(sameClient).toMatchObject({
      status: "completed",
      decision: "deny",
      reason: "active_restriction",
      restriction: { scope: "client_instance" },
    });

    const secondPacket = packetFor({
      requestId: "3",
      sessionId: "session-cch-live-3",
      installationId: "installation-cch-live-b",
      sequence: 1,
      text: "Add a serializer regression test.",
    });
    expect(await submitReview(config, secondPacket)).toMatchObject({
      status: "completed",
      decision: "allow",
      reason: "reviewer_assessment",
    });
    expect(
      await reportProviderEvent(config, {
        schema_version: "cyber-check.provider-event.v1",
        identity: secondPacket.identity,
        enforcement_mode: config.mode,
        upstream_provider_id: "17",
        event: { type: "policy_rejection", code: "cyber_policy" },
      })
    ).toEqual({
      principal_strikes: 2,
      session_restricted: true,
      client_instance_restricted: true,
      principal_restricted: true,
    });

    const thirdClientPacket = packetFor({
      requestId: "4",
      sessionId: "session-cch-live-4",
      installationId: "installation-cch-live-c",
      sequence: 1,
      text: "Add a cache regression test.",
    });
    expect(await submitReview(config, thirdClientPacket)).toMatchObject({
      status: "completed",
      decision: "deny",
      reason: "active_restriction",
      restriction: { scope: "principal" },
    });

    await reinstatePrincipal(config, "7");

    expect(
      await submitReview(
        config,
        packetFor({
          requestId: "5",
          sessionId: "session-cch-live-5",
          installationId: "installation-cch-live-c",
          sequence: 1,
          text: "Add a cache regression test.",
        })
      )
    ).toMatchObject({
      status: "completed",
      decision: "allow",
    });
    expect(
      await submitReview(
        config,
        packetFor({
          requestId: "6",
          sessionId: "session-cch-live-6",
          installationId: "installation-cch-live-a",
          sequence: 1,
          text: "Add a cache regression test.",
        })
      )
    ).toMatchObject({
      status: "completed",
      decision: "deny",
      reason: "active_restriction",
      restriction: { scope: "client_instance" },
    });
  });
});
