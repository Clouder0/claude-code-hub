import type { StoredCostBreakdown } from "@/types/cost-breakdown";
import type { CreateMessageRequestData } from "@/types/message";

export type MessageRequestJsonbPatch = {
  providerChain?: CreateMessageRequestData["provider_chain"];
  specialSettings?: CreateMessageRequestData["special_settings"];
  costBreakdown?: StoredCostBreakdown | null;
};

function sanitizeJsonbString(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code === 0) {
      continue;
    }

    if ((code > 0 && code < 9) || code === 11 || code === 12 || (code > 13 && code < 32)) {
      result += " ";
      continue;
    }

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] ?? "";
        result += value[index + 1] ?? "";
        index += 1;
      } else {
        result += "\uFFFD";
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
      continue;
    }

    result += value[index] ?? "";
  }

  return result;
}

export function sanitizeMessageRequestJsonbValue<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeJsonbString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMessageRequestJsonbValue(item)) as T;
  }

  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      Object.defineProperty(sanitized, sanitizeJsonbString(key), {
        value: sanitizeMessageRequestJsonbValue(nested),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return sanitized as T;
  }

  return value;
}

export function sanitizeMessageRequestJsonbPatch<T extends MessageRequestJsonbPatch>(patch: T): T {
  const sanitized: MessageRequestJsonbPatch = { ...patch };

  if (sanitized.providerChain !== undefined && sanitized.providerChain !== null) {
    sanitized.providerChain = sanitizeMessageRequestJsonbValue(sanitized.providerChain);
  }
  if (sanitized.specialSettings !== undefined && sanitized.specialSettings !== null) {
    sanitized.specialSettings = sanitizeMessageRequestJsonbValue(sanitized.specialSettings);
  }
  if (sanitized.costBreakdown !== undefined && sanitized.costBreakdown !== null) {
    sanitized.costBreakdown = sanitizeMessageRequestJsonbValue(sanitized.costBreakdown);
  }

  return sanitized as T;
}
