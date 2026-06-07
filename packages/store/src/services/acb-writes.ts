/**
 * ACB group-verdict write service.
 *
 * Canonical home for the `acb_group_verdicts` upsert. Takes a
 * `@claude-prove/store` `Store` handle directly so any caller — the CLI's
 * `AcbStore`, the review-ui server, or a future consumer — drives the same
 * SQL and the same `updated_at` stamp through one code path.
 *
 * `acb_group_verdicts` carries no event-log row, so this service emits none.
 */

import type { Store } from '../connection';

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
 * Upsert a verdict on `(slug, groupId)`. Bumps `updated_at` to now().
 *
 * The conflict target `(slug, group_id)` matches the table's composite
 * primary key, so a re-upsert on the same pair updates in place rather than
 * inserting a second row.
 */
export async function upsertGroupVerdict(
  store: Store,
  slug: string,
  groupId: string,
  verdict: GroupVerdict,
  note: string | null,
  fixPrompt: string | null,
): Promise<GroupVerdictRecord> {
  const updatedAt = isoNow();
  await store.run(
    `INSERT INTO acb_group_verdicts (slug, group_id, verdict, note, fix_prompt, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug, group_id) DO UPDATE SET
         verdict    = excluded.verdict,
         note       = excluded.note,
         fix_prompt = excluded.fix_prompt,
         updated_at = excluded.updated_at`,
    [slug, groupId, verdict, note, fixPrompt, updatedAt],
  );
  return { slug, groupId, verdict, note, fixPrompt, updatedAt };
}

function isoNow(): string {
  return new Date().toISOString();
}
