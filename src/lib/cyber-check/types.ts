export type CyberCheckMode = "off" | "shadow" | "enforce";

export type ReviewDecision = "allow" | "deny";

export type ReviewCoveragePosture = "complete" | "partial";

export type ReviewDisposition = "allowed" | "restricted" | "uncertain";

export type RestrictionScope = "session" | "client_instance" | "principal";

export interface ActiveRestriction {
  scope: RestrictionScope;
  subject_id: string;
  reason: string;
  expires_at_ms?: number;
}

export interface ReviewFinalDecision {
  decision: ReviewDecision;
  predicted_decision: ReviewDecision;
  enforcement_mode: "shadow" | "enforce";
  reason:
    | "fast_path"
    | "known_bypass_profile"
    | "active_restriction"
    | "reviewer_assessment"
    | "reviewer_unavailable";
  review_disposition?: ReviewDisposition;
  restriction?: ActiveRestriction;
  coverage: ReviewCoveragePosture;
  policy_version: string;
  reviewer_version: string;
}

export type ReviewSubmission =
  | ({ status: "completed" } & ReviewFinalDecision)
  | {
      status: "pending";
      interim_decision: "allow";
      job_id: string;
      status_url: string;
    };

export type ReviewJob =
  | { status: "pending"; job_id: string }
  | ({ status: "completed"; job_id: string } & ReviewFinalDecision)
  | { status: "failed"; job_id: string; error_code: string };

export interface ProviderEventEnvelope {
  schema_version: "cyber-check.provider-event.v1";
  identity: ReviewRequestEnvelope["identity"];
  enforcement_mode: Exclude<CyberCheckMode, "off">;
  upstream_provider_id: string;
  event: {
    type: "policy_rejection";
    code: "cyber_policy";
  };
}

export interface ProviderContainment {
  principal_strikes: number;
  session_restricted: boolean;
  client_instance_restricted: boolean;
  principal_restricted: boolean;
}

export interface RequestOutcomeEnvelope {
  schema_version: "cyber-check.request-outcome.v1";
  identity: ReviewRequestEnvelope["identity"];
  outcome: "clean";
}

export interface ReviewRequestEnvelope {
  schema_version: "cyber-check.request-review.v1";
  identity: {
    request_id: string;
    principal_id: string;
    client_instance_id?: string;
    session_id: string;
    sequence: number;
  };
  source: {
    protocol: "openai.responses";
    profile: "codex-http-sse";
    model: string;
    context_state:
      | { type: "self_contained" }
      | {
          type: "referenced";
          references: Array<"previous_response" | "conversation" | "prompt_template">;
        };
    body_sha256: string;
    body_bytes: number;
  };
  instructions: ReviewInstruction[];
  items: ReviewContextItem[];
  capabilities: ReviewCapability[];
  coverage: {
    notices: ReviewCoverageNotice[];
  };
}

export interface ReviewInstruction {
  origin: "system" | "developer";
  content: ReviewContentPart[];
}

export type ReviewItemType =
  | "message"
  | "assistant_message"
  | "reasoning"
  | "local_shell_call"
  | "function_call"
  | "function_call_output"
  | "custom_tool_call"
  | "custom_tool_call_output"
  | "mcp_tool_call"
  | "mcp_tool_call_output"
  | "tool_search_call"
  | "tool_search_output"
  | "web_search_call"
  | "image_generation_call"
  | "compaction"
  | "context_compaction"
  | "additional_tools"
  | "unsupported";

export interface ReviewContextItem {
  source_type: ReviewItemType;
  origin: "system" | "developer" | "user" | "assistant" | "tool";
  linkage?: {
    item_id?: string;
    call_id?: string;
    name?: string;
    namespace?: string;
  };
  content: ReviewContentPart[];
  unsupported_source_type?: string;
}

export type ReviewContentPart =
  | { type: "text"; text: string; format: "plain" | "json" }
  | { type: "json"; value: unknown }
  | {
      type: "inline_media";
      modality: "image" | "audio";
      mime_type: string;
      data_base64: string;
      detail?: "auto" | "low" | "high" | "original";
    }
  | {
      type: "unresolved_media";
      modality: "image" | "audio";
      reference_type: "remote_url" | "file_id";
    }
  | {
      type: "opaque";
      kind:
        | "encrypted_reasoning"
        | "encrypted_compaction"
        | "encrypted_agent_content"
        | "encrypted_tool_arguments"
        | "plaintext_reasoning_omitted";
    };

export interface ReviewCapability {
  source: "top_level_tools" | "additional_tools";
  definition: Record<string, unknown>;
}

export interface ReviewCoverageNotice {
  code:
    | "encrypted_reasoning_omitted"
    | "plaintext_reasoning_omitted"
    | "unsupported_top_level_field"
    | "unsupported_item_type"
    | "unsupported_content_type"
    | "capability_truncated"
    | "content_truncated";
  item_index?: number;
}
