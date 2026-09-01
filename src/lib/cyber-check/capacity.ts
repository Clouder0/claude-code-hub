const FIXED_ENCODING_BYTES = 64 * 1024;
// One body-sized unit for projected/serialized data and two for JS string plus upload/compression
// buffers. This is deliberately coarse working-set admission, not an allocator accounting system.
const BODY_ENCODING_MULTIPLIER = 3;

export interface EncodingCapacityLease {
  readonly bytes: number;
  release(): void;
}

/**
 * Bounds only the extra request projection, JSON, compression, and upload working set introduced
 * by Cyber Check. The original proxy request already exists and is intentionally not counted here.
 */
export class EncodingCapacity {
  private inUseBytes = 0;

  tryAcquire(bodyBytes: number, maxBytes: number): EncodingCapacityLease | null {
    const bytes = encodingCapacityCharge(bodyBytes);
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes > maxBytes ||
      this.inUseBytes > maxBytes - bytes
    ) {
      return null;
    }

    this.inUseBytes += bytes;
    let released = false;
    return {
      bytes,
      release: () => {
        if (released) return;
        released = true;
        this.inUseBytes -= bytes;
      },
    };
  }

  snapshot(): number {
    return this.inUseBytes;
  }
}

export function encodingCapacityCharge(bodyBytes: number): number {
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0) return Number.POSITIVE_INFINITY;
  return FIXED_ENCODING_BYTES + bodyBytes * BODY_ENCODING_MULTIPLIER;
}

export const cyberCheckEncodingCapacity = new EncodingCapacity();
