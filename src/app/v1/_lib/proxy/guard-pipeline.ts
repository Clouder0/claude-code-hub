import { findCyberScopeBlock, findSessionBlockPolicy } from "@/lib/security/policy-containment";
import { ProxyAuthenticator } from "./auth-guard";
import { ProxyClientGuard } from "./client-guard";
import type { EndpointPolicy } from "./endpoint-policy";
import { ProxyMessageService } from "./message-service";
import { ProxyModelGuard } from "./model-guard";
import { ProxyProviderRequestFilter } from "./provider-request-filter";
import { ProxyProviderResolver } from "./provider-selector";
import { ProxyRateLimitGuard } from "./rate-limit-guard";
import { ProxyRequestFilter } from "./request-filter";
import { ProxyResponses } from "./responses";
import { ProxySensitiveWordGuard } from "./sensitive-word-guard";
import type { ProxySession } from "./session";
import { ProxySessionGuard } from "./session-guard";
import { ProxyVersionGuard } from "./version-guard";
import { ProxyWarmupGuard } from "./warmup-guard";

// Request type classification for pipeline presets
export enum RequestType {
  CHAT = "CHAT",
  COUNT_TOKENS = "COUNT_TOKENS",
}

// A single guard step that can mutate session or produce an early Response
export interface GuardStep {
  name: string;
  execute(session: ProxySession): Promise<Response | null>;
}

// Pipeline configuration describes an ordered list of step keys
export type GuardStepKey =
  | "auth"
  | "client"
  | "model"
  | "version"
  | "probe"
  | "session"
  | "policyBlock"
  | "cyberScopeBlock"
  | "warmup"
  | "requestFilter"
  | "sensitive"
  | "rateLimit"
  | "provider"
  | "providerRequestFilter"
  | "messageContext";

export interface GuardConfig {
  steps: GuardStepKey[];
}

export interface GuardPipeline {
  run(session: ProxySession): Promise<Response | null>;
}

// Concrete GuardStep implementations (adapters over existing guards)
const Steps: Record<GuardStepKey, GuardStep> = {
  auth: {
    name: "auth",
    async execute(session) {
      return ProxyAuthenticator.ensure(session);
    },
  },
  client: {
    name: "client",
    async execute(session) {
      return ProxyClientGuard.ensure(session);
    },
  },
  model: {
    name: "model",
    async execute(session) {
      return ProxyModelGuard.ensure(session);
    },
  },
  version: {
    name: "version",
    async execute(session) {
      return ProxyVersionGuard.ensure(session);
    },
  },
  probe: {
    name: "probe",
    async execute(session) {
      if (session.isProbeRequest()) {
        return new Response(JSON.stringify({ input_tokens: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return null;
    },
  },
  session: {
    name: "session",
    async execute(session) {
      await ProxySessionGuard.ensure(session);
      return null;
    },
  },
  policyBlock: {
    name: "policyBlock",
    async execute(session) {
      if (!session.sessionId) return null;
      const blockedPolicy = await findSessionBlockPolicy(session.sessionId);
      if (blockedPolicy) {
        return ProxyResponses.buildError(
          400,
          "该会话因触发上游安全策略已被拦截。",
          "invalid_request_error",
          undefined,
          undefined,
          { code: blockedPolicy }
        );
      }
      return null;
    },
  },
  cyberScopeBlock: {
    name: "cyberScopeBlock",
    async execute(session) {
      const context = session.messageContext;
      if (!context) return null;
      const metadata = session.request.message.client_metadata;
      const clientInstanceId =
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? (metadata as Record<string, unknown>)["x-codex-installation-id"]
          : undefined;
      const blocked = await findCyberScopeBlock(
        String(context.user.id),
        typeof clientInstanceId === "string" ? clientInstanceId : undefined
      );
      if (!blocked) return null;
      return ProxyResponses.buildError(
        400,
        blocked === "principal"
          ? "该账户因触发上游安全策略已被拦截。"
          : "该 installation 因触发上游安全策略已被拦截。",
        "invalid_request_error",
        undefined,
        undefined,
        { code: "cyber_policy" }
      );
    },
  },
  warmup: {
    name: "warmup",
    async execute(session) {
      return ProxyWarmupGuard.ensure(session);
    },
  },
  requestFilter: {
    name: "requestFilter",
    async execute(session) {
      await ProxyRequestFilter.ensure(session);
      return null;
    },
  },
  sensitive: {
    name: "sensitive",
    async execute(session) {
      return ProxySensitiveWordGuard.ensure(session);
    },
  },
  rateLimit: {
    name: "rateLimit",
    async execute(session) {
      await ProxyRateLimitGuard.ensure(session);
      return null;
    },
  },
  provider: {
    name: "provider",
    async execute(session) {
      return ProxyProviderResolver.ensure(session);
    },
  },
  providerRequestFilter: {
    name: "providerRequestFilter",
    async execute(session) {
      await ProxyProviderRequestFilter.ensure(session);
      return null;
    },
  },
  messageContext: {
    name: "messageContext",
    async execute(session) {
      await ProxyMessageService.ensureContext(session);
      return null;
    },
  },
};

export class GuardPipelineBuilder {
  // Assemble a pipeline from a configuration
  static build(config: GuardConfig): GuardPipeline {
    const steps: GuardStep[] = config.steps.map((k) => Steps[k]);

    return {
      async run(session: ProxySession): Promise<Response | null> {
        for (const step of steps) {
          const res = await step.execute(session);
          if (res) return res; // early exit
        }
        return null;
      },
    };
  }

  static fromSession(session: Pick<ProxySession, "getEndpointPolicy">): GuardPipeline {
    return GuardPipelineBuilder.fromEndpointPolicy(session.getEndpointPolicy());
  }

  static fromEndpointPolicy(policy: Pick<EndpointPolicy, "guardPreset">): GuardPipeline {
    switch (policy.guardPreset) {
      case "alpha_search":
        return GuardPipelineBuilder.build(ALPHA_SEARCH_PIPELINE);
      case "raw_passthrough":
        // The raw preset keeps its session context and both policy guards
        // unconditionally: managed raw endpoints (remote compaction,
        // count_tokens) must never lose blocking coverage to a system
        // setting. The fallback flag still governs provider reuse and
        // selection behavior, not guard coverage.
        return GuardPipelineBuilder.build(RAW_SAFE_SESSION_PIPELINE);
      default:
        return GuardPipelineBuilder.build(CHAT_PIPELINE);
    }
  }

  // Convenience: build a pipeline from preset request type
  static fromRequestType(type: RequestType): GuardPipeline {
    switch (type) {
      case RequestType.COUNT_TOKENS:
        return GuardPipelineBuilder.build(RAW_SAFE_SESSION_PIPELINE);
      default:
        return GuardPipelineBuilder.build(CHAT_PIPELINE);
    }
  }
}

// Preset configurations
export const CHAT_PIPELINE: GuardConfig = {
  // Full guard chain for normal chat requests
  steps: [
    "auth",
    "sensitive",
    "client",
    "model",
    "version",
    "probe",
    "session",
    "policyBlock",
    "warmup",
    "requestFilter",
    "rateLimit",
    "provider",
    "providerRequestFilter",
    "messageContext",
    "cyberScopeBlock",
  ],
};

export const RAW_SAFE_SESSION_PIPELINE: GuardConfig = {
  steps: [
    "auth",
    "client",
    "model",
    "version",
    "probe",
    "session",
    "policyBlock",
    "provider",
    "messageContext",
    "cyberScopeBlock",
  ],
};

export const ALPHA_SEARCH_PIPELINE: GuardConfig = {
  steps: [
    "auth",
    "client",
    "model",
    "version",
    "session",
    "policyBlock",
    "rateLimit",
    "provider",
    "messageContext",
    "cyberScopeBlock",
  ],
};

export const COUNT_TOKENS_PIPELINE: GuardConfig = RAW_SAFE_SESSION_PIPELINE;
