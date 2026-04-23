import { useQuery } from "@tanstack/react-query";
import { api, type BranchRef } from "../lib/api";
import { useSelection } from "../lib/store";
import { cn } from "../lib/cn";
import { PanelLoading } from "./PanelLoading";

export function BranchTree() {
  const slug = useSelection((s) => s.slug);
  const selected = useSelection((s) => s.branch);
  const pending = useSelection((s) => s.pendingMode);
  const selectBranch = useSelection((s) => s.selectBranch);
  const togglePending = useSelection((s) => s.togglePending);

  const { data: run, isPending: runPending, isFetching: runFetching } = useQuery({
    queryKey: ["run", slug],
    queryFn: () => api.run(slug!),
    enabled: !!slug,
  });
  const { data: branchesData, isPending: branchesPending, isFetching: branchesFetching } =
    useQuery({
      queryKey: ["branches", slug],
      queryFn: () => api.runBranches(slug!),
      enabled: !!slug,
    });
  const { data: statusData } = useQuery({
    queryKey: ["status", slug],
    queryFn: () => api.runStatus(slug!),
    enabled: !!slug,
    refetchInterval: 4000,
  });

  if (!slug) return <Empty text="Select a run" />;
  // Hold the panel on a spinner until the branches query resolves; otherwise
  // the "ORCH NOT FOUND" warning flashes before data arrives.
  const branchesLoading =
    runPending || branchesPending || (runFetching && !run) || (branchesFetching && !branchesData);
  if (branchesLoading) return <PanelLoading label="LOADING BRANCHES" />;

  const base = run?.baseline?.split("@")[0].trim() ?? "main";
  const branches = branchesData?.branches ?? [];
  const orch = branches.find((b) => b.name === run?.orchestratorBranch);
  const agents = branches.filter((b) => b.name !== run?.orchestratorBranch);
  const orphans = branchesData?.orphanAgents ?? [];
  const hasOrch = branchesData?.hasOrchestrator ?? false;
  const dirty =
    (statusData?.status?.modified.length ?? 0) +
    (statusData?.status?.staged.length ?? 0) +
    (statusData?.status?.untracked.length ?? 0);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 h-10 flex items-center justify-between bg-bg-deep border-b border-bg-line">
        <span className="font-semibold text-fg-bright text-[13px]">Branches</span>
        <span className="mono text-[11px] text-fg-faint">base: {base}</span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {!hasOrch && (
          <div className="mx-3 my-3 rounded-md border border-amber/40 bg-amber/5 px-3 py-2.5 text-[12px]">
            <div className="text-amber font-medium mb-1">Orchestrator branch missing</div>
            <div className="mono text-[11px] text-fg-dim break-all">
              {branchesData?.orchestratorName}
            </div>
            <div className="text-fg-base text-[11.5px] mt-1">
              Run may be merged, archived, or not yet started.
            </div>
          </div>
        )}

        {orch && (
          <Row
            branch={orch}
            role="ORCH"
            active={selected === orch.name && !pending}
            onClick={() => selectBranch(orch.name, base)}
            tone="phos"
          />
        )}

        {orch?.worktreePath && (
          <button
            onClick={() => togglePending(!pending, orch.name)}
            className={cn(
              "w-full text-left px-3 py-2 flex items-center gap-3 border-l-2 border-b border-bg-line/60 transition-colors font-mono text-[12px]",
              pending
                ? "bg-bg-raised border-l-amber text-fg-bright"
                : "border-l-transparent hover:bg-bg-panel text-fg-base",
            )}
          >
            <span className={cn("led", dirty ? "led-amber" : "led-dim")} />
            <span className="label text-amber w-12">PEND</span>
            <span className="flex-1">uncommitted changes</span>
            {dirty > 0 && (
              <span className="font-mono text-[11px] text-amber tabular-nums">+{dirty}</span>
            )}
          </button>
        )}

        {agents.length > 0 && (
          <SectionLabel label="SUB-AGENT WORKTREES" count={agents.length} tone="data" />
        )}
        {agents.map((b) => {
          const prefix = slug ? `task/${slug}/` : "";
          const role = prefix && b.name.startsWith(prefix) ? b.name.slice(prefix.length) : "AGT";
          return (
            <Row
              key={b.name}
              branch={b}
              role={role.length > 6 ? role.slice(0, 6) : role.toUpperCase()}
              active={selected === b.name && !pending}
              onClick={() => selectBranch(b.name, base)}
            />
          );
        })}

        {orphans.length > 0 && (
          <>
            <SectionLabel label="ORPHAN BRANCHES" count={orphans.length} />
            {orphans.map((b) => (
              <Row
                key={b.name}
                branch={b}
                role="ORP"
                active={selected === b.name && !pending}
                onClick={() => selectBranch(b.name, base)}
                dim
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  branch,
  role,
  active,
  onClick,
  tone,
  dim,
}: {
  branch: BranchRef;
  role: string;
  active: boolean;
  onClick: () => void;
  tone?: "phos";
  dim?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-2 flex items-center gap-3 border-l-2 border-b border-bg-line/60 transition-colors font-mono text-[12px]",
        active
          ? "bg-bg-raised border-l-phos text-fg-bright"
          : "border-l-transparent hover:bg-bg-panel",
        dim ? "text-fg-dim" : "text-fg-base",
      )}
    >
      <span className={cn("led", branch.isWorktree ? "" : "led-dim")} />
      <span
        className={cn(
          "label w-10",
          tone === "phos" ? "label-phos" : dim ? "text-fg-faint" : "text-fg-dim",
        )}
      >
        {role}
      </span>
      <span className="flex-1 min-w-0">
        <div className="truncate">{branch.name.replace(/^orchestrator\//, "")}</div>
        <div className="text-[10px] text-fg-dim">{branch.sha.slice(0, 10)}</div>
      </span>
      {branch.isWorktree && <span className="label text-data">WT</span>}
    </button>
  );
}

function SectionLabel({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone?: "data";
}) {
  return (
    <div className="px-3 py-1.5 bg-bg-deep/60 border-b border-bg-line flex items-center gap-2">
      <span className={cn("label", tone === "data" ? "text-data" : "label-bright")}>{label}</span>
      <span className="font-mono text-[10.5px] text-fg-dim">[{count}]</span>
      <span className="flex-1 h-px bg-bg-line ml-1" />
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center text-fg-dim text-[13px]">{text}</div>
  );
}
