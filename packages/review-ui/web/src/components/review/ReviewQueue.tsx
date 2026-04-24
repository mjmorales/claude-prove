import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import type { Queue, QueueItem } from "../../lib/queue";
import { tokenOf } from "./verdictTokens";

export function ReviewQueue({
  queue,
  activeId,
  onSelect,
  waiting,
}: {
  queue: Queue;
  activeId: string | null;
  onSelect: (id: string) => void;
  /**
   * How many intents the orchestrator is still expected to produce. When > 0
   * the queue shows a "waiting" tail so the user knows more is coming.
   */
  waiting: number;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filterFn = useMemo(
    () =>
      q === ""
        ? (_: QueueItem) => true
        : (item: QueueItem) =>
            `${item.group.title} ${item.group.id} ${item.group.classification}`
              .toLowerCase()
              .includes(q),
    [q],
  );
  const ready = queue.ready.filter(filterFn);
  const stale = queue.stale.filter(filterFn);
  const reviewed = queue.reviewed.filter(filterFn);

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-panel border-r border-bg-line">
      <div className="shrink-0 border-b border-bg-line bg-bg-deep/60 px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter queue…"
          className="w-full h-7 px-2 rounded border border-bg-line bg-bg-void text-[12.5px] text-fg-base placeholder:text-fg-faint focus:outline-none focus:border-phos"
        />
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <Bucket
          title="Up next"
          count={ready.length}
          accent="phos"
          hint={ready.length === 0 ? "queue drained" : undefined}
        >
          {ready.map((it) => (
            <Row key={it.groupId} item={it} active={it.groupId === activeId} onClick={onSelect} />
          ))}
        </Bucket>

        {(stale.length > 0 || queue.stale.length > 0) && (
          <Bucket title="Stale · re-review" count={stale.length} accent="amber">
            {stale.map((it) => (
              <Row
                key={it.groupId}
                item={it}
                active={it.groupId === activeId}
                onClick={onSelect}
                staleHint={staleHintFor(it)}
              />
            ))}
          </Bucket>
        )}

        <Bucket title="Reviewed" count={reviewed.length} accent="dim" defaultCollapsed>
          {reviewed.map((it) => (
            <Row key={it.groupId} item={it} active={it.groupId === activeId} onClick={onSelect} />
          ))}
        </Bucket>

        {waiting > 0 && (
          <div className="px-3 py-3 text-[12px] text-fg-dim border-t border-bg-line/60">
            <div className="flex items-center gap-2 mb-1">
              <span className="dots" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              <span className="text-fg-base">Waiting · {waiting}</span>
            </div>
            <div className="text-[11.5px] text-fg-faint leading-snug">
              The orchestrator is still working. New intents will auto-queue when saved.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function staleHintFor(item: QueueItem): string {
  if (item.staleCommits.length === 0) return "modified";
  const ins = item.staleCommits.length;
  return `${ins} new commit${ins === 1 ? "" : "s"} since ${verdictShort(item.verdict)}`;
}

function verdictShort(v: QueueItem["verdict"]): string {
  const map: Record<QueueItem["verdict"], string> = {
    accepted: "approval",
    rejected: "rejection",
    needs_discussion: "discuss",
    rework: "rework",
    pending: "verdict",
  };
  return map[v];
}

function Bucket({
  title,
  count,
  accent,
  hint,
  defaultCollapsed,
  children,
}: {
  title: string;
  count: number;
  accent: "phos" | "amber" | "dim";
  hint?: string;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const color =
    accent === "phos" ? "#bd93f9" : accent === "amber" ? "#ffb86c" : "#a9b0c4";
  return (
    <section className="border-b border-bg-line/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 h-8 flex items-center gap-2 bg-bg-deep/40 hover:bg-bg-raised/40 transition-colors"
      >
        <span
          className="text-[10px] transition-transform"
          style={{ color, transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▸
        </span>
        <span className="text-[12px] font-semibold" style={{ color }}>
          {title}
        </span>
        <span className="mono text-[11px] text-fg-faint tabular-nums">{count}</span>
        {hint && <span className="text-[11px] text-fg-faint ml-auto italic">{hint}</span>}
      </button>
      {open && <div>{children}</div>}
    </section>
  );
}

function Row({
  item,
  active,
  onClick,
  staleHint,
}: {
  item: QueueItem;
  active: boolean;
  onClick: (id: string) => void;
  staleHint?: string;
}) {
  const t = tokenOf(item.verdict);
  const g = item.group;
  const primaryFile = g.files[0] ?? "";
  return (
    <button
      onClick={() => onClick(item.groupId)}
      className={cn(
        "row w-full text-left px-3 py-2 flex items-start gap-3 border-b border-bg-line/40",
        active && "is-active",
      )}
    >
      <span className="shrink-0 mt-0.5">
        {item.stale ? (
          <span className="text-[13px] text-amber" title="Stale">
            🔄
          </span>
        ) : t ? (
          <span
            className="text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded"
            style={{
              color: t.color,
              background: `${t.color}20`,
              border: `1px solid ${t.color}55`,
            }}
            title={t.label}
          >
            {t.glyph}
          </span>
        ) : (
          <span className="w-2 h-2 mt-1 inline-block rounded-full bg-fg-faint" title="Pending" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg-bright font-medium truncate">{g.title}</div>
        <div className="text-[11.5px] text-fg-faint truncate mono">{primaryFile}</div>
        {staleHint && (
          <div className="text-[11px] text-amber mt-1">{staleHint}</div>
        )}
      </div>
    </button>
  );
}
