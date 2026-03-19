import { createHash } from "node:crypto";
import type { ReviewStateDocument } from "./types.js";

/**
 * Compute a SHA-256 hash of raw ACB content.
 * Returns a lowercase hex string (64 characters).
 */
export function computeAcbHash(acbContent: string): string {
  return createHash("sha256").update(acbContent).digest("hex");
}

/**
 * Returns true when the ACB content has changed since the review was created,
 * i.e. the hash of `acbContent` no longer matches `review.acb_hash`.
 */
export function isReviewStale(
  acbContent: string,
  review: ReviewStateDocument,
): boolean {
  return computeAcbHash(acbContent) !== review.acb_hash;
}
