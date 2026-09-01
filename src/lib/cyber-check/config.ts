import type { EnvConfig } from "@/lib/config/env.schema";
import type { CyberCheckMode } from "./types";

export interface CyberCheckConfig {
  mode: Exclude<CyberCheckMode, "off">;
  baseUrl: URL;
  gatewayToken: string;
  zstdMinBytes: number;
  maxEncodingBytes: number;
}

type CyberCheckEnv = Pick<
  EnvConfig,
  | "CYBER_CHECK_MODE"
  | "CYBER_CHECK_URL"
  | "CYBER_CHECK_GATEWAY_TOKEN"
  | "CYBER_CHECK_ZSTD_MIN_BYTES"
  | "CYBER_CHECK_MAX_ENCODING_BYTES"
>;

export class CyberCheckConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyberCheckConfigurationError";
  }
}

export function resolveCyberCheckConfig(env: CyberCheckEnv): CyberCheckConfig | null {
  if (env.CYBER_CHECK_MODE === "off") return null;

  if (!env.CYBER_CHECK_URL) {
    throw new CyberCheckConfigurationError(
      "CYBER_CHECK_URL is required when CYBER_CHECK_MODE is enabled"
    );
  }
  if (!env.CYBER_CHECK_GATEWAY_TOKEN) {
    throw new CyberCheckConfigurationError(
      "CYBER_CHECK_GATEWAY_TOKEN is required when CYBER_CHECK_MODE is enabled"
    );
  }

  const baseUrl = new URL(env.CYBER_CHECK_URL);
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new CyberCheckConfigurationError("CYBER_CHECK_URL must use HTTP or HTTPS");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.hash || baseUrl.search) {
    throw new CyberCheckConfigurationError(
      "CYBER_CHECK_URL cannot contain credentials, a query, or a fragment"
    );
  }
  if (baseUrl.pathname !== "/") {
    throw new CyberCheckConfigurationError("CYBER_CHECK_URL must be an origin URL without a path");
  }
  if (baseUrl.protocol === "http:" && !isLoopbackHost(baseUrl.hostname)) {
    throw new CyberCheckConfigurationError(
      "CYBER_CHECK_URL must use HTTPS unless the service is bound to loopback"
    );
  }

  return {
    mode: env.CYBER_CHECK_MODE,
    baseUrl,
    gatewayToken: env.CYBER_CHECK_GATEWAY_TOKEN,
    zstdMinBytes: env.CYBER_CHECK_ZSTD_MIN_BYTES,
    maxEncodingBytes: env.CYBER_CHECK_MAX_ENCODING_BYTES,
  };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
