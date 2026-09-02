import { getEnvConfig } from "@/lib/config/env.schema";
import {
  getCyberState,
  reinstateClientInstance,
  reinstatePrincipal,
  releaseBioRestriction,
  setManualClientInstanceRestriction,
} from "./client";
import { resolveCyberCheckConfig } from "./config";
import type { CyberState, ManualClientRestrictionOperation } from "./types";

export async function getCyberCheckStateIfConfigured(
  principalId: string
): Promise<CyberState | null> {
  const config = resolveCyberCheckConfig(getEnvConfig());
  if (!config) return null;
  return getCyberState(config, principalId);
}

export async function releaseCyberCheckBioRestrictionIfConfigured(
  principalId: string,
  scope: "session" | "client_instance" | "principal",
  subjectId: string,
  operation: ManualClientRestrictionOperation
): Promise<boolean> {
  const config = resolveCyberCheckConfig(getEnvConfig());
  if (!config) return false;
  await releaseBioRestriction(config, principalId, scope, subjectId, operation);
  return true;
}

export async function setCyberCheckManualClientRestrictionIfConfigured(
  principalId: string,
  clientInstanceId: string,
  operation: ManualClientRestrictionOperation,
  restricted: boolean
): Promise<boolean> {
  const config = resolveCyberCheckConfig(getEnvConfig());
  if (!config) return false;
  await setManualClientInstanceRestriction(
    config,
    principalId,
    clientInstanceId,
    operation,
    restricted
  );
  return true;
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
