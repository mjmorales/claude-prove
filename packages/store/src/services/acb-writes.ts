/**
 * ACB group-verdict write service.
 *
 * Canonical home for the `acb_group_verdicts` APPEND. Takes a
 * `@claude-prove/store` `Store` handle directly so any caller — the CLI's
 * `AcbStore`, the review-ui server, or a future consumer — drives the same
 * append SQL and the same `created_at` stamp through one code path.
 *
 * `acb_group_verdicts` is an append-only revision log: every verdict on a
 * `(slug, group_id)` adds a new ULID-keyed row, and the latest revision per key
 * is read through the `acb_group_verdicts_head` view. Two writers each append a
 * distinct row that both survive whole-transaction sync replay, where an
 * in-place upsert on a UNIQUE key would let one writer clobber the other.
 *
 * `acb_group_verdicts` carries no event-log row, so this service emits none.
 */

import type { Store } from '../connection';
import { ulid } from '../ulid';

/**
 * Canonical verdict vocabulary for `acb_group_verdicts.verdict`.
 *
 * `'rework'` is a review-UI-only state: the group is rejected with a
 * generated fix brief. Legacy values (`'approved'`, `'discuss'`) may still
 * exist in stored rows but are NOT members here — they are coerced to
 * canonical at the DB read boundary, never written.
 *
 * The dependency graph runs `@claude-prove/cli` → `@claude-prove/store`, so
 * this module cannot import the matching `VerdictValue` from the CLI's
 * `acb/schemas.ts` without a cycle. The vocabulary therefore lives here as
 * the canonical copy. Follow-up: the CLI should re-import `VERDICT_VALUES` /
 * `VerdictValue` / `GroupVerdict` / `GroupVerdictRecord` from this module
 * rather than keep a parallel definition, so the two never drift.
 */
export const VERDICT_VALUES = [
  'accepted',
  'rejected',
  'needs_discussion',
  'pending',
  'rework',
] as const;

export type VerdictValue = (typeof VERDICT_VALUES)[number];

/** Review-UI verdict value set — alias for the canonical `VerdictValue`. */
export type GroupVerdict = VerdictValue;

export interface GroupVerdictRecord {
  slug: string;
  groupId: string;
  verdict: GroupVerdict;
  note: string | null;
  fixPrompt: string | null;
  updatedAt: string;
}

/**
 * Append a new verdict revision for `(slug, groupId)`, stamped `created_at` =
 * now() and keyed by a fresh ULID id. A re-verify of the same pair APPENDS a
 * second row rather than updating in place; the `acb_group_verdicts_head` view
 * surfaces the latest revision (max id) per key.
 *
 * The returned `updatedAt` mirrors the new revision's `created_at`, preserving
 * the field name every caller already reads.
 */
export async function appendGroupVerdict(
  store: Store,
  slug: string,
  groupId: string,
  verdict: GroupVerdict,
  note: string | null,
  fixPrompt: string | null,
): Promise<GroupVerdictRecord> {
  const updatedAt = isoNow();
  await store.run(
    `INSERT INTO acb_group_verdicts (id, slug, group_id, verdict, note, fix_prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ulid(), slug, groupId, verdict, note, fixPrompt, updatedAt],
  );
  return { slug, groupId, verdict, note, fixPrompt, updatedAt };
}

function isoNow(): string {
  return new Date().toISOString();
}
