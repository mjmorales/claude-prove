import type { QueueItem } from "../../lib/queue";
import { tokenOf } from "./verdictTokens";

/**
 * Banner shown at the top of the active group card when the intent is stale:
 * previously decided, but later commits have touched its files. Presents the
 * prior verdict as historical context and offers a one-click "Keep prior
 * verdict" CTA that dismisses the stale flag without changing the value.
 */
export function CompositeBanner({
  item,
  onKeep,
  working,
}: {
  item: QueueItem;
  onKeep: () => void;
  working: boolean;
}) {
  const t = tokenOf(item.verdict);
  return (
    <section
      className="rounded-md border px-4 py-3"
      style={{
        borderColor: "#ffb86c55",
        background: "rgba(255, 184, 108, 0.06)",
      }}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <span className="eyebrow text-amber">Re-review</span>
        <span className="mono text-[12px] text-fg-bright">{item.group.id}</span>
        {t && (
          <span
            className="text-[10.5px] font-bold tracking-wider px-1.5 py-0.5 rounded"
            style={{
              color: t.color,
              background: `${t.color}20`,
              border: `1px solid ${t.color}55`,
            }}
          >
            prior {t.label.toLowerCase()}
          </span>
        )}
        {item.staleCommits.length > 0 && (
          <span className="text-[11.5px] text-fg-faint ml-auto">
            {item.staleCommits.length} new commit
            {item.staleCommits.length === 1 ? "" : "s"} since your verdict
          </span>
        )}
      </div>
      <p className="text-[13px] text-fg-base mt-2">
        This intent&rsquo;s files have been modified after your prior verdict. The diff
        below shows the delta &mdash; re-decide, or keep the prior verdict to dismiss
        the stale flag.
      </p>
      {item.staleCommits.length > 0 && (
        <ul className="mt-2 space-y-1 font-mono text-[12px]">
          {item.staleCommits.map((c) => (
            <li key={c.sha} className="flex gap-3">
              <span className="text-data shrink-0">{c.shortSha}</span>
              <span className="truncate text-fg-base">{c.subject}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onKeep}
          disabled={working}
          className="btn btn-ghost btn-sm"
          title="Re-record the same verdict — dismisses the stale flag"
        >
          <span>Keep prior verdict</span>
          {t && <span aria-hidden>{t.glyph}</span>}
        </button>
        <span className="text-[11.5px] text-fg-faint">
          or choose Approve / Reject / Discuss / Rework below to replace it.
        </span>
      </div>
    </section>
  );
}
