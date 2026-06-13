/**
 * Verdict tallying for the review surfaces. The StatusHeader summary chips and
 * the ReviewSession progress strip both bucket the same verdict records; this
 * single helper keeps their counts from drifting.
 */
import type { GroupVerdict } from "./api";

type VerdictKey = Exclude<GroupVerdict, "pending">;

export type VerdictTally = {
  accepted: number;
  rejected: number;
  needs_discussion: number;
  rework: number;
  pending: number;
  decided: number;
};

/**
 * Bucket verdict records into per-verdict counts plus `decided` (non-pending
 * total) and `pending` (groups with no decided verdict yet). `pending` is
 * derived from `totalGroups` rather than counted, so groups that have no verdict
 * record at all are still reflected as pending.
 */
export function tallyVerdicts(
  verdicts: Array<{ groupId: string; verdict: GroupVerdict }>,
  totalGroups: number,
): VerdictTally {
  const tally: VerdictTally = {
    accepted: 0,
    rejected: 0,
    needs_discussion: 0,
    rework: 0,
    pending: 0,
    decided: 0,
  };
  for (const v of verdicts) {
    if (v.verdict === "pending") continue;
    tally[v.verdict as VerdictKey] += 1;
    tally.decided += 1;
  }
  tally.pending = Math.max(0, totalGroups - tally.decided);
  return tally;
}
