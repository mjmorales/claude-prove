import { useState } from "react";
import type {
  IntentCommitRef,
  NegativeSpaceEntry,
  OpenQuestion,
} from "../../lib/api";
import { cn } from "../../lib/cn";

export function ReviewContext({
  negativeSpace,
  openQuestions,
  uncoveredFiles,
  orphanCommits,
}: {
  negativeSpace: NegativeSpaceEntry[];
  openQuestions: OpenQuestion[];
  uncoveredFiles: string[];
  orphanCommits: IntentCommitRef[];
}) {
  const hasAny =
    negativeSpace.length > 0 ||
    openQuestions.length > 0 ||
    uncoveredFiles.length > 0 ||
    orphanCommits.length > 0;
  const [open, setOpen] = useState(
    uncoveredFiles.length > 0 || openQuestions.length > 0 || orphanCommits.length > 0,
  );

  if (!hasAny) return null;

  return (
    <section className="border border-bg-line bg-bg-panel/70">
      <button
        onClick={() => setOpen(!open)}
        className="w-full h-9 px-4 flex items-center gap-4 bg-bg-deep/70 border-b border-bg-line hover:bg-bg-deep transition-colors"
      >
        <span className="label label-phos">REVIEW CONTEXT</span>
        <span className="font-mono text-[10.5px] text-fg-dim tabular-nums">
          {openQuestions.length}? · {negativeSpace.length}∅ ·{" "}
          <span className={uncoveredFiles.length > 0 ? "text-anom" : undefined}>
            {uncoveredFiles.length} uncovered
          </span>
          {orphanCommits.length > 0 && (
            <>
              {" · "}
              <span className="text-anom">{orphanCommits.length} orphan</span>
            </>
          )}
        </span>
        <span className="ml-auto text-[10.5px] text-fg-dim font-mono">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Block title="Open questions" tone="phos" count={openQuestions.length}>
            {openQuestions.length === 0 ? (
              <Empty>No unresolved questions</Empty>
            ) : (
              <ul className="space-y-2">
                {openQuestions.map((q) => (
                  <li
                    key={q.id}
                    className="border-l-2 border-phos/70 pl-2 text-[12px] font-mono text-fg-bright whitespace-pre-wrap leading-relaxed"
                  >
                    <span className="text-[10px] text-phos uppercase tracking-wide2 mr-2">
                      {q.id}
                    </span>
                    {q.body}
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block title="Negative space" tone="data" count={negativeSpace.length}>
            {negativeSpace.length === 0 ? (
              <Empty>No intentional omissions declared</Empty>
            ) : (
              <ul className="space-y-2">
                {negativeSpace.map((n) => (
                  <li
                    key={n.path}
                    className="border-l-2 border-data/70 pl-2 text-[12px] font-mono text-fg-base leading-relaxed"
                  >
                    <div className="text-data truncate">{n.path}</div>
                    {n.reason && (
                      <div className="text-[10.5px] text-fg-dim uppercase tracking-wide2 mt-0.5">
                        {n.reason.replace(/_/g, " ")}
                      </div>
                    )}
                    {n.note && (
                      <div className="text-fg-base whitespace-pre-wrap mt-1">{n.note}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Block>

          <Block
            title="Uncovered files"
            tone={uncoveredFiles.length > 0 ? "anom" : "dim"}
            count={uncoveredFiles.length}
          >
            {uncoveredFiles.length === 0 ? (
              <Empty>All changed files are claimed by an intent group</Empty>
            ) : (
              <>
                <p className="text-[10.5px] text-fg-dim font-mono mb-2">
                  These files changed but no intent group explains why.
                </p>
                <ul className="space-y-1">
                  {uncoveredFiles.slice(0, 20).map((p) => (
                    <li
                      key={p}
                      className="font-mono text-[11.5px] text-anom border-l-2 border-anom/60 pl-2 truncate"
                    >
                      {p}
                    </li>
                  ))}
                  {uncoveredFiles.length > 20 && (
                    <li className="text-[10.5px] text-fg-dim font-mono">
                      + {uncoveredFiles.length - 20} more
                    </li>
                  )}
                </ul>
              </>
            )}
          </Block>

          <Block
            title="Orphan commits"
            tone={orphanCommits.length > 0 ? "anom" : "dim"}
            count={orphanCommits.length}
          >
            {orphanCommits.length === 0 ? (
              <Empty>Every commit declared an intent manifest</Empty>
            ) : (
              <>
                <p className="text-[10.5px] text-fg-dim font-mono mb-2">
                  Commits that did not record any intent manifest.
                </p>
                <ul className="space-y-1.5">
                  {orphanCommits.slice(0, 12).map((c) => (
                    <li
                      key={c.sha}
                      className="font-mono text-[11.5px] border-l-2 border-anom/60 pl-2 flex gap-2"
                    >
                      <span className="text-anom tabular-nums shrink-0">{c.shortSha}</span>
                      <span className="truncate text-fg-base">{c.subject}</span>
                    </li>
                  ))}
                  {orphanCommits.length > 12 && (
                    <li className="text-[10.5px] text-fg-dim font-mono">
                      + {orphanCommits.length - 12} more
                    </li>
                  )}
                </ul>
              </>
            )}
          </Block>
        </div>
      )}
    </section>
  );
}

function Block({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone: "phos" | "data" | "anom" | "dim";
  children: React.ReactNode;
}) {
  const colorMap = {
    phos: "#e8b465",
    data: "#8ac4b5",
    anom: "#e67466",
    dim: "#857d6c",
  } as const;
  const color = colorMap[tone];
  return (
    <div className="border border-bg-line bg-bg-deep/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className={cn("label")} style={{ color }}>
          {title}
        </span>
        <span
          className="font-mono text-[11px] tabular-nums"
          style={{ color: count > 0 ? color : "#564f45" }}
        >
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[11.5px] font-mono text-fg-dim italic">{children}</div>;
}
