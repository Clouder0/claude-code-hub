import { getEnvConfig } from "@/lib/config/env.schema";
import { getCyberState, reinstateClientInstance, reinstatePrincipal } from "./client";
import { resolveCyberCheckConfig } from "./config";
import type { CyberState } from "./types";

export async function getCyberCheckStateIfConfigured(
  principalId: string
): Promise<CyberState | null> {
  const config = resolveCyberCheckConfig(getEnvConfig());
  if (!config) return null;
  return getCyberState(config, principalId);
}

/** Resets Cyber Check's principal strike epoch before CCH makes the user active again. */
export async function reinstateCyberCheckPrincipalIfConfigured(
  principalId: string
): Promise<boolean> {
  const config = resolveCyberCheckConfig(getEnvConfig());
  if (!config) return false;
  await reinstatePrincipal(config, principalId);
  return true;
}

export async function reinstateCyberCheckClientInstanceIfConfigured(
  principalId: string,
  clientInstanceId: string
): Promise<boolean> {
  const config = resolveCyberCheckConfig(getEnvConfig());
  if (!config) return false;
  await reinstateClientInstance(config, principalId, clientInstanceId);
  return true;
}
