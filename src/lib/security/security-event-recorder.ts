import { logger } from "@/lib/logger";
import { insertSecurityEvent } from "@/repository/security-events";
import type { CyberSecurityEventType } from "./cyber-security-signals";

export async function recordSecurityEventBestEffort(
  userId: number | null | undefined,
  messageRequestId: number | null | undefined,
  type: CyberSecurityEventType
): Promise<void> {
  if (userId == null) {
    logger.warn("[SecurityEvent] Cannot attribute event without user", { type });
    return;
  }

  try {
    await insertSecurityEvent(userId, messageRequestId ?? null, type);
  } catch (error) {
    logger.error("[SecurityEvent] Failed to persist event", {
      userId,
      messageRequestId,
      type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
