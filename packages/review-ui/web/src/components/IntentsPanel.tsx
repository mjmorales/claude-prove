import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection } from "../lib/store";
import { cn } from "../lib/cn";
import { PanelLoading } from "./PanelLoading";
import { Empty } from "./Empty";

export function IntentsPanel() {
  const slug = useSelection((s) => s.slug);
  const selectCommit = useSelection((s) => s.selectCommit);
  const setRightTab = useSelection((s) => s.setRightTab);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

  const { data, isPending, isFetching, isError } = useQuery({
    queryKey: ["intents", slug],
    queryFn: () => api.intents(slug!),
    enabled: !!slug,
    retry: false,
  });

  if (!slug) return <Empty text="Select a run" />;
  if (isPending || (isFetching && !data)) return <PanelLoading label="ASSEMBLING INTENTS" />;
  if (isError) return <Hollow text="INTENT STORE UNREACHABLE" />;

  const groups = data?.groups ?? [];
  const orphans = data?.orphanCommits ?? [];
  const current = selectedGroup ? groups.find((g) => g.id === selectedGroup) : (groups[0] ?? null);
  const currentId = current?.id ?? null;

  if (groups.length === 0 && orphans.length === 0)
    return (
      <Hollow
        text="NO COMMITS IN RUN"
        detail="No branches attached to this run have commits yet."
      />
    );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 h-8 flex items-center gap-3 bg-bg-deep border-b border-bg-line">
        <span className="label label-bright">INTENT GROUPS</span>
        <span className="font-mono text-[10.5px] text-fg-dim tabular-nums">[{groups.length}]</span>
        {orphans.length > 0 && (
          <span className="ml-auto font-mono text-[10.5px] text-amber">
            {orphans.length} orphan{orphans.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="grid grid-rows-[minmax(120px,40%)_minmax(0,1fr)] h-full min-h-0">
        {/* Group list */}
        <div className="overflow-y-auto scrollbar-thin border-b border-bg-line">
          {groups.map((g) => {
            const active = g.id === currentId;
            return (
              <button
                key={g.id}
                onClick={() => setSelectedGroup(g.id)}
                className={cn(
                  "w-full text-left px-3 py-2 flex items-start gap-3 border-l-2 border-b border-bg-line/60 font-mono text-[12px] transition-colors",
                  active
                    ? "bg-bg-raised border-l-phos text-fg-bright"
                    : "border-l-transparent hover:bg-bg-panel text-fg-base",
                )}
              >
                <span className="font-bold text-data shrink-0 mt-0.5">◉</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="label text-fg-dim truncate max-w-[240px]">{g.id}</span>
                    <span
                      className={cn(
                        "px-1.5 py-[1px] text-[9px] tracking-wide2 font-semibold uppercase border shrink-0",
                        g.classification === "explicit"
                          ? "border-phos/40 text-phos bg-phos/10"
                          : "border-amber/40 text-amber bg-amber/10",
                      )}
                    >
                      {g.classification}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-fg-dim tabular-nums shrink-0">
                      {g.commits.length}c · {g.files.length}f
                    </span>
                  </div>
                  <div className="text-[12.5px] leading-snug break-words">{g.title}</div>
                </div>
              </button>
            );
          })}
          {orphans.length > 0 && (
            <div className="px-3 py-2 text-[10.5px] font-mono text-amber border-t border-amber/30 bg-amber/5">
              {orphans.length} commit{orphans.length === 1 ? "" : "s"} without manifest — see below
            </div>
          )}
        </div>

        {/* Detail pane */}
        <div className="overflow-y-auto scrollbar-thin gridbg">
          {current && <GroupDetail group={current} onCommit={(sha) => {
            selectCommit(sha);
            setRightTab("intent");
          }} />}
          {orphans.length > 0 && (
            <section className="border-t border-bg-line">
              <header className="h-7 px-4 flex items-center gap-3 bg-bg-deep">
                <span className="label text-amber">ORPHAN COMMITS</span>
                <span className="font-mono text-[10px] text-fg-dim">[{orphans.length}]</span>
              </header>
              <div>
                {orphans.map((c) => (
                  <button
                    key={c.sha}
                    onClick={() => {
                      selectCommit(c.sha);
                      setRightTab("diff");
                    }}
                    className="w-full text-left px-4 py-1.5 font-mono text-[11.5px] flex items-center gap-3 border-b border-bg-line/60 hover:bg-bg-panel"
                  >
                    <span className="text-fg-dim tabular-nums">{c.shortSha}</span>
                    <span className="truncate text-fg-base">{c.subject}</span>
                    <span className="ml-auto text-[10px] text-fg-dim">{c.branch}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupDetail({
  group,
  onCommit,
}: {
  group: {
    id: string;
    title: string;
    classification: string;
    files: string[];
    commits: Array<{ sha: string; shortSha: string; branch: string; subject: string; timestamp: string }>;
  };
  onCommit: (sha: string) => void;
}) {
  return (
    <div>
      <section className="border-b border-bg-line">
        <header className="h-7 px-4 flex items-center bg-bg-deep">
          <span className="label label-bright">COMMITS</span>
          <span className="ml-2 font-mono text-[10px] text-fg-dim">[{group.commits.length}]</span>
        </header>
        <div>
          {group.commits.map((c) => (
            <button
              key={c.sha}
              onClick={() => onCommit(c.sha)}
              className="w-full text-left px-4 py-1.5 font-mono text-[11.5px] flex items-center gap-3 border-b border-bg-line/60 hover:bg-bg-panel"
            >
              <span className="text-data tabular-nums">{c.shortSha}</span>
              <span className="truncate text-fg-base">{c.subject}</span>
              <span className="ml-auto text-[10px] text-fg-dim max-w-[200px] truncate">{c.branch}</span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <header className="h-7 px-4 flex items-center bg-bg-deep">
          <span className="label label-bright">FILES</span>
          <span className="ml-2 font-mono text-[10px] text-fg-dim">[{group.files.length}]</span>
        </header>
        <ul className="font-mono text-[11.5px]">
          {group.files.map((f) => (
            <li key={f} className="px-4 py-1 border-b border-bg-line/60 text-fg-base truncate">
              {f}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Hollow({ text, detail }: { text: string; detail?: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center text-fg-dim p-8 gap-2">
      <div className="label text-amber">{text}</div>
      {detail && <div className="text-[11px] font-mono max-w-xs">{detail}</div>}
    </div>
  );
}
