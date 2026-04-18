import type { GroupVerdict, GroupVerdictRecord, IntentGroupView } from "./api";

export type QueueItem = {
  groupId: string;
  group: IntentGroupView;
  verdict: GroupVerdict;
  /** True when this intent was decided but later commits have touched its
   * files, invalidating the verdict. Needs re-review. */
  stale: boolean;
  /** For stale items: commits that landed on the group's files since the
   * last verdict. Feeds the composite re-review card. */
  staleCommits: StaleCommit[];
  /** Absolute ISO timestamp used for queue ordering. */
  orderKey: string;
};

export type StaleCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  timestamp: string;
};

export type Queue = {
  ready: QueueItem[];
  stale: QueueItem[];
  reviewed: QueueItem[];
  /** Ordered list of ids auto-advance walks through. Stale first, then
   * ready; reviewed is not in this list. */
  activeOrder: string[];
};

/**
 * Compute the review queue from intent groups + stored verdicts. Staleness is
 * derived client-side: a decided intent is stale when any commit listed in
 * the intent's own `commits[]` has a timestamp greater than the verdict's
 * `updatedAt`. That's a conservative rule — it also catches rebases that
 * replace commits in-place.
 *
 * A future iteration could compare against every commit touching any of
 * the group's files, not just the ones that produced the manifest; that
 * requires a broader commit->file reverse index from the server. For now
 * the manifest-commit signal is what we have.
 */
export function computeQueue(
  groups: IntentGroupView[],
  verdicts: GroupVerdictRecord[],
): Queue {
  const verdictById = new Map<string, GroupVerdictRecord>();
  for (const v of verdicts) verdictById.set(v.groupId, v);

  const ready: QueueItem[] = [];
  const stale: QueueItem[] = [];
  const reviewed: QueueItem[] = [];

  for (const g of groups) {
    const rec = verdictById.get(g.id);
    const verdict = rec?.verdict ?? "pending";
    const firstCommitTs = g.commits[0]?.timestamp ?? "";
    const lastCommitTs = g.commits[g.commits.length - 1]?.timestamp ?? firstCommitTs;

    if (verdict === "pending") {
      ready.push({
        groupId: g.id,
        group: g,
        verdict,
        stale: false,
        staleCommits: [],
        orderKey: firstCommitTs,
      });
      continue;
    }

    // Decided: check for commits that arrived after the verdict.
    const decidedAt = rec?.updatedAt ?? "";
    const staleCommits: StaleCommit[] = [];
    if (decidedAt) {
      for (const c of g.commits) {
        if (c.timestamp > decidedAt) {
          staleCommits.push({
            sha: c.sha,
            shortSha: c.shortSha,
            subject: c.subject,
            timestamp: c.timestamp,
          });
        }
      }
    }

    if (staleCommits.length > 0) {
      stale.push({
        groupId: g.id,
        group: g,
        verdict,
        stale: true,
        staleCommits,
        orderKey: staleCommits[0].timestamp,
      });
    } else {
      reviewed.push({
        groupId: g.id,
        group: g,
        verdict,
        stale: false,
        staleCommits: [],
        orderKey: decidedAt || lastCommitTs,
      });
    }
  }

  // Ready: FIFO by first-commit time, so the user works through intents in
  // the order the orchestrator produced them.
  ready.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  // Stale: oldest-stale first (blocks merge-readiness).
  stale.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  // Reviewed: most-recent verdict first.
  reviewed.sort((a, b) => b.orderKey.localeCompare(a.orderKey));

  // Active order: stale first (priority), then ready. Matches auto-advance
  // precedence described in the design.
  const activeOrder = [...stale, ...ready].map((q) => q.groupId);

  return { ready, stale, reviewed, activeOrder };
}

/** Find the next id in `activeOrder` after `currentId`. Wraps to null
 * (not to first) so standby engages when the queue drains. */
export function nextActive(queue: Queue, currentId: string | null): string | null {
  if (queue.activeOrder.length === 0) return null;
  if (!currentId) return queue.activeOrder[0];
  const idx = queue.activeOrder.indexOf(currentId);
  if (idx < 0) return queue.activeOrder[0];
  // Return the next one after current, INCLUDING current's bucket change.
  // After verdict, currentId is moved to reviewed, so activeOrder is
  // recomputed — idx of currentId becomes -1 and we fall to [0].
  return queue.activeOrder[idx + 1] ?? null;
}

export function prevActive(queue: Queue, currentId: string | null): string | null {
  if (queue.activeOrder.length === 0) return null;
  if (!currentId) return queue.activeOrder[queue.activeOrder.length - 1];
  const idx = queue.activeOrder.indexOf(currentId);
  if (idx <= 0) return null;
  return queue.activeOrder[idx - 1];
}

/** Total reviewable intents (ready + stale + reviewed). Excludes orphans. */
export function queueSize(q: Queue): number {
  return q.ready.length + q.stale.length + q.reviewed.length;
}
