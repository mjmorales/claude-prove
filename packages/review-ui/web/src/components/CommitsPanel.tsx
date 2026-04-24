import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection } from "../lib/store";
import { cn } from "../lib/cn";
import { PanelLoading } from "./PanelLoading";
import { Empty } from "./Empty";

export function CommitsPanel() {
  const slug = useSelection((s) => s.slug);
  const branch = useSelection((s) => s.branch);
  const selectedSha = useSelection((s) => s.commitSha);
  const selectCommit = useSelection((s) => s.selectCommit);
  const setRightTab = useSelection((s) => s.setRightTab);

  const { data: run } = useQuery({
    queryKey: ["run", slug],
    queryFn: () => api.run(slug!),
    enabled: !!slug,
  });

  // The commit log always displays the full branch range (baseline..branch).
  // Selecting a commit narrows the right-pane diff but must not collapse the
  // list itself, so we derive the range base from the run rather than the
  // store's shifting `base`/`head`.
  const rangeBase = run?.baseline?.split("@")[0].trim() || "main";

  const { data, isPending, isFetching } = useQuery({
    queryKey: ["commits", slug, rangeBase, branch],
    queryFn: () => api.commits(slug!, rangeBase, branch!),
    enabled: !!slug && !!branch,
  });

  if (!slug || !branch) return <Empty text="Pick a branch to see commits" />;
  if (isPending || (isFetching && !data)) return <PanelLoading label="Loading commits" />;

  const commits = data?.commits ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 h-8 flex items-center gap-3 bg-bg-deep border-b border-bg-line">
        <span className="label label-bright">COMMIT LOG</span>
        <span className="font-mono text-[10.5px] text-fg-dim">
          {rangeBase.slice(0, 16)} → {branch.slice(0, 22)}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-fg-dim tabular-nums">
          [{commits.length}]
        </span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {commits.length === 0 && <Empty text="NO COMMITS IN RANGE" />}
        {commits.map((c, i) => {
          const active = c.sha === selectedSha;
          const type = conventionalType(c.subject);
          return (
            <button
              key={c.sha}
              onClick={() => {
                selectCommit(c.sha);
                setRightTab("diff");
              }}
              className={cn(
                "w-full text-left px-3 py-2 flex items-start gap-3 border-l-2 border-b border-bg-line/60 transition-colors font-mono text-[12px]",
                active
                  ? "bg-bg-raised border-l-phos text-fg-bright"
                  : "border-l-transparent hover:bg-bg-panel text-fg-base",
              )}
            >
              <span className="text-fg-dim tabular-nums w-6 text-[10.5px] mt-0.5">
                {String(commits.length - i).padStart(2, "0")}
              </span>
              <span className="label w-12 text-[10px] shrink-0 mt-0.5" style={{ color: typeColor(type) }}>
                {type || "•••"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-phos text-[10.5px]">{c.shortSha}</span>
                  <span className="text-fg-dim text-[10px]">{relTime(c.timestamp)}</span>
                </div>
                <div className="truncate text-[12px] mt-0.5">{stripType(c.subject)}</div>
                <div className="text-[10px] text-fg-dim truncate">{c.author}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const TYPE_RE = /^(feat|fix|refactor|test|docs|chore|perf|ci|build|style|revert|merge)(\([^)]*\))?!?:\s*/i;

function conventionalType(s: string): string {
  const m = s.match(TYPE_RE);
  return m ? m[1].toUpperCase() : "";
}
function stripType(s: string): string {
  return s.replace(TYPE_RE, "");
}
function typeColor(t: string): string {
  // Warm-biased palette — keeps semantic hue separation while keeping blue-light load low.
  switch (t) {
    case "FEAT":
      return "#8cc474"; // soft moss (still reads as "new/good")
    case "FIX":
      return "#e67466"; // warm coral
    case "REFACTOR":
      return "#8ac4b5"; // soft teal
    case "TEST":
      return "#ff9a66"; // peach
    case "PERF":
      return "#e8b465"; // amber
    case "DOCS":
    case "CHORE":
      return "#857d6c";
    case "MERGE":
      return "#e8ddc9";
    default:
      return "#857d6c";
  }
}

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `T-${Math.round(s)}s`;
  if (s < 3600) return `T-${Math.round(s / 60)}m`;
  if (s < 86400) return `T-${Math.round(s / 3600)}h`;
  return `T-${Math.round(s / 86400)}d`;
}

