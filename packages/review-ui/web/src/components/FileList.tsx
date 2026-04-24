import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FileChange } from "../lib/api";
import { useSelection } from "../lib/store";
import { cn } from "../lib/cn";
import { parseUnifiedDiff } from "../lib/diff";
import { PanelLoading } from "./PanelLoading";
import { FileTree } from "./FileTree";
import { Empty } from "./Empty";
import { PALETTE } from "./review/verdictTokens";

type ChangeFilter = "A" | "M" | "D";
const CHANGE_FILTERS: Array<{ key: ChangeFilter; label: string; color: string }> = [
  { key: "A", label: "Added", color: PALETTE.status.added },
  { key: "M", label: "Modified", color: PALETTE.status.modified },
  { key: "D", label: "Deleted", color: PALETTE.status.deleted },
];

function applyFilters(
  files: FileChange[],
  query: string,
  types: Set<ChangeFilter>,
): FileChange[] {
  const q = query.trim().toLowerCase();
  return files.filter((f) => {
    if (types.size > 0) {
      const key = (f.status[0] ?? "M") as ChangeFilter;
      if (!types.has(key)) return false;
    }
    if (q && !f.path.toLowerCase().includes(q)) return false;
    return true;
  });
}

type Group = {
  id: string;
  kind: "orch-committed" | "orch-pending" | "task-committed" | "task-pending";
  label: string;
  branch: string;
  base: string | null;
  head: string | null;
  cwd: string | null;
  pending: boolean;
  insertions: number;
  deletions: number;
  files: FileChange[];
};

export function FileList() {
  const slug = useSelection((s) => s.slug);
  const branch = useSelection((s) => s.branch);
  const head = useSelection((s) => s.head);
  const base = useSelection((s) => s.base);
  const selectedFile = useSelection((s) => s.filePath);
  const pending = useSelection((s) => s.pendingMode);
  const commitSha = useSelection((s) => s.commitSha);
  const selectFile = useSelection((s) => s.selectFile);
  const selectFileFromGroup = useSelection((s) => s.selectFileFromGroup);

  const { data: run } = useQuery({
    queryKey: ["run", slug],
    queryFn: () => api.run(slug!),
    enabled: !!slug,
  });

  // Aggregated manifest (all groups across orch + sub-agents) — shown when
  // no specific commit/task is focused.
  const showAggregate =
    !!slug && !commitSha && (!branch || branch === run?.orchestratorBranch);

  const manifestQ = useQuery({
    queryKey: ["manifest", slug],
    queryFn: () => api.manifest(slug!),
    enabled: showAggregate,
    refetchInterval: 5000,
  });

  const committedQuery = useQuery({
    queryKey: ["diff", slug, base, head],
    queryFn: () => api.diff(slug!, base!, head!),
    enabled: !showAggregate && !!slug && !!base && !!head && !pending,
  });
  const pendingQuery = useQuery({
    queryKey: ["pending", slug, branch],
    queryFn: () => api.pending(slug!, undefined, branch ?? undefined),
    enabled: !showAggregate && !!slug && pending,
    refetchInterval: 3000,
  });

  const flatFiles: FileChange[] = useMemo(() => {
    if (showAggregate) return [];
    if (pending) {
      const patch = pendingQuery.data?.patch ?? "";
      return patch ? extractPendingFiles(patch) : [];
    }
    return committedQuery.data?.files ?? [];
  }, [showAggregate, pending, committedQuery.data, pendingQuery.data]);

  const groups: Group[] = manifestQ.data?.groups ?? [];
  // `isPending` guards pre-first-data renders; `isFetching && !data` covers
  // refetches triggered by SSE invalidation where the cache was cleared.
  const loading =
    (showAggregate && (manifestQ.isPending || (manifestQ.isFetching && !manifestQ.data))) ||
    (!showAggregate && !pending && (committedQuery.isPending || (committedQuery.isFetching && !committedQuery.data))) ||
    (!showAggregate && pending && (pendingQuery.isPending || (pendingQuery.isFetching && !pendingQuery.data)));

  const totalAdd = showAggregate
    ? groups.reduce((s, g) => s + g.insertions, 0)
    : flatFiles.reduce((s, f) => s + f.insertions, 0);
  const totalDel = showAggregate
    ? groups.reduce((s, g) => s + g.deletions, 0)
    : flatFiles.reduce((s, f) => s + f.deletions, 0);
  const totalFiles = showAggregate
    ? groups.reduce((s, g) => s + g.files.length, 0)
    : flatFiles.length;

  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<Set<ChangeFilter>>(new Set());
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");

  const filteredFlat = useMemo(
    () => applyFilters(flatFiles, query, types),
    [flatFiles, query, types],
  );
  const filteredGroups = useMemo(
    () =>
      groups.map((g) => ({
        ...g,
        files: applyFilters(g.files, query, types),
      })),
    [groups, query, types],
  );

  const toggleType = (k: ChangeFilter) => {
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-bg-panel">
      <div className="shrink-0 border-b border-bg-line">
        {totalFiles > 0 && (
          <div className="px-3 pt-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by path…"
              className="w-full h-7 px-2 rounded border border-bg-line bg-bg-void text-[12.5px] text-fg-base placeholder:text-fg-faint focus:outline-none focus:border-phos"
            />
          </div>
        )}
        <div className="px-3 py-2 flex items-center gap-1.5">
          {CHANGE_FILTERS.map((c) => (
            <FilterChip
              key={c.key}
              label={c.label}
              color={c.color}
              active={types.has(c.key)}
              onClick={() => toggleType(c.key)}
            />
          ))}
          <div className="ml-auto flex items-center gap-2 font-mono text-[11.5px] tabular-nums">
            <span className="text-ok">+{totalAdd}</span>
            <span className="text-anom">−{totalDel}</span>
            <button
              onClick={() => setViewMode((m) => (m === "tree" ? "flat" : "tree"))}
              title={`Switch to ${viewMode === "tree" ? "flat list" : "tree view"}`}
              className="ml-1 text-[11px] text-fg-dim hover:text-fg-bright"
            >
              {viewMode === "tree" ? "tree" : "flat"}
            </button>
          </div>
        </div>
        <div className="h-[2px] w-full bg-bg-line/40 flex overflow-hidden">
          <div
            className="bg-ok h-full"
            style={{ width: `${fractionPct(totalAdd, totalAdd + totalDel)}%` }}
          />
          <div
            className="bg-anom h-full"
            style={{ width: `${fractionPct(totalDel, totalAdd + totalDel)}%` }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!slug && <Empty text="Select a run" />}
        {slug && loading && <PanelLoading label="Loading diff" />}

        {showAggregate && !loading && groups.length === 0 && <Empty text="No changes yet" />}
        {showAggregate &&
          filteredGroups.map((g) => (
            <GroupBlock
              key={g.id}
              group={g}
              selectedFile={selectedFile}
              activeBranch={branch}
              viewMode={viewMode}
              onSelect={(path) =>
                selectFileFromGroup(path, {
                  branch: g.branch,
                  base: g.base,
                  head: g.head,
                  pending: g.pending,
                })
              }
            />
          ))}

        {!showAggregate && !loading && flatFiles.length === 0 && slug && (
          <Empty text="No changes" />
        )}
        {!showAggregate && filteredFlat.length === 0 && flatFiles.length > 0 && (
          <Empty text="No matches" />
        )}
        {!showAggregate &&
          filteredFlat.length > 0 &&
          (viewMode === "tree" ? (
            <FileTree
              files={filteredFlat}
              selectedPath={selectedFile}
              onSelect={selectFile}
            />
          ) : (
            filteredFlat.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                active={f.path === selectedFile}
                onClick={() => selectFile(f.path)}
              />
            ))
          ))}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  color,
  active,
  onClick,
}: {
  label: string;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="h-6 px-2 rounded-md border text-[11.5px] transition-colors"
      style={{
        borderColor: active ? color : PALETTE.surface.border,
        background: active ? `${color}20` : "transparent",
        color: active ? color : PALETTE.accent.neutral,
      }}
    >
      {label}
    </button>
  );
}

function GroupBlock({
  group,
  selectedFile,
  activeBranch,
  viewMode,
  onSelect,
}: {
  group: Group;
  selectedFile: string | null;
  activeBranch: string | null;
  viewMode: "tree" | "flat";
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const tone =
    group.kind === "orch-committed"
      ? "phos"
      : group.kind === "orch-pending"
        ? "amber"
        : group.kind === "task-committed"
          ? "data"
          : "amber";

  return (
    <div className="border-b border-bg-line">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full px-3 py-2 flex items-center gap-3 bg-bg-deep/60 hover:bg-bg-raised transition-colors"
      >
        <span
          className={cn("text-[11px] transition-transform", collapsed ? "-rotate-90" : "")}
          style={{ color: toneHex(tone) }}
        >
          ▾
        </span>
        <span className="text-[12.5px] font-medium" style={{ color: toneHex(tone) }}>
          {group.label}
        </span>
        <span className="font-mono text-[11.5px] text-fg-faint tabular-nums">
          {group.files.length}
        </span>
        {group.pending && <span className="led led-amber !w-[5px] !h-[5px] shrink-0" />}
        <span className="ml-auto flex items-center gap-2 font-mono text-[11.5px] tabular-nums">
          <span className="text-ok">+{group.insertions}</span>
          <span className="text-anom">−{group.deletions}</span>
        </span>
      </button>
      {!collapsed && (
        <div>
          <div className="px-3 py-1 text-[11px] font-mono text-fg-faint truncate">
            {group.pending
              ? `uncommitted @ ${truncMid(group.cwd ?? "", 40)}`
              : `${group.base} → ${truncMid(group.branch, 40)}`}
          </div>
          {group.files.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-fg-dim">empty</div>
          ) : viewMode === "tree" ? (
            <FileTree
              files={group.files}
              selectedPath={activeBranch === group.branch ? selectedFile : null}
              onSelect={onSelect}
            />
          ) : (
            group.files.map((f) => {
              const selected = f.path === selectedFile && activeBranch === group.branch;
              return (
                <FileRow
                  key={f.path}
                  file={f}
                  active={selected}
                  onClick={() => onSelect(f.path)}
                />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({
  file,
  active,
  onClick,
}: {
  file: FileChange;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-1.5 flex items-center gap-3 border-l-2 transition-colors font-mono text-[12px]",
        active
          ? "bg-bg-raised border-l-phos text-fg-bright"
          : "border-l-transparent hover:bg-bg-panel text-fg-base",
      )}
    >
      <Badge status={file.status} />
      <span className="min-w-0 flex-1 truncate">{file.path}</span>
      {file.binary ? (
        <span className="text-[10px] text-fg-dim tracking-wide2">BIN</span>
      ) : (
        <span className="text-[10px] tabular-nums whitespace-nowrap shrink-0">
          <span className="text-phos">+{file.insertions}</span>
          <span className="text-fg-faint mx-0.5">·</span>
          <span className="text-anom">-{file.deletions}</span>
        </span>
      )}
    </button>
  );
}

function Badge({ status }: { status: string }) {
  const key = status[0] ?? "M";
  const map: Record<string, { label: string; cls: string }> = {
    A: { label: "A", cls: "bg-phos/15 text-phos border-phos/40" },
    M: { label: "M", cls: "bg-data/15 text-data border-data/40" },
    D: { label: "D", cls: "bg-anom/15 text-anom border-anom/40" },
    R: { label: "R", cls: "bg-amber/15 text-amber border-amber/40" },
  };
  const m = map[key] ?? { label: key, cls: "bg-bg-line text-fg-dim border-bg-line" };
  return (
    <span
      className={cn(
        "w-5 h-5 shrink-0 border text-[10px] font-bold font-mono flex items-center justify-center",
        m.cls,
      )}
    >
      {m.label}
    </span>
  );
}

function toneHex(t: "phos" | "amber" | "data"): string {
  if (t === "phos") return PALETTE.accent.phos;
  if (t === "amber") return PALETTE.verdict.rework;
  return PALETTE.verdict.needsDiscussion;
}

function fractionPct(num: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (num / total) * 100));
}

function truncMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - half);
}

function extractPendingFiles(patch: string): FileChange[] {
  const files: FileChange[] = [];
  const blocks = patch.split(/^diff --git /m).filter((b) => b.trim());
  for (const block of blocks) {
    const chunk = "diff --git " + block;
    const p = parseUnifiedDiff(chunk);
    const filePath = p.newPath && p.newPath !== "/dev/null" ? p.newPath : p.oldPath;
    if (!filePath) continue;
    let ins = 0;
    let del = 0;
    for (const h of p.hunks) {
      for (const ln of h.lines) {
        if (ln.kind === "add") ins++;
        else if (ln.kind === "del") del++;
      }
    }
    const status = p.isBinary
      ? "M"
      : p.oldPath === "/dev/null"
        ? "A"
        : p.newPath === "/dev/null"
          ? "D"
          : "M";
    files.push({ path: filePath, status, insertions: ins, deletions: del, binary: p.isBinary });
  }
  return files;
}

