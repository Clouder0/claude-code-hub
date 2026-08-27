import { getEnvConfig } from "@/lib/config/env.schema";
import { reinstatePrincipal } from "./client";
import { resolveCyberCheckConfig } from "./config";

/** Resets Cyber Check's principal strike epoch before CCH makes the user active again. */
export async function reinstateCyberCheckPrincipalIfConfigured(principalId: string): Promise<void> {
  const config = resolveCyberCheckConfig(getEnvConfig());
  if (!config) return;
  await reinstatePrincipal(config, principalId);
}
