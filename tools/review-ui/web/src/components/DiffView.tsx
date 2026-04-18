import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection } from "../lib/store";
import { parseUnifiedDiff, type DiffLine } from "../lib/diff";
import { cn } from "../lib/cn";
import { PanelLoading } from "./PanelLoading";

export function DiffView() {
  const slug = useSelection((s) => s.slug);
  const branch = useSelection((s) => s.branch);
  const head = useSelection((s) => s.head);
  const base = useSelection((s) => s.base);
  const filePath = useSelection((s) => s.filePath);
  const pending = useSelection((s) => s.pendingMode);

  const committedEnabled = !pending && !!slug && !!base && !!head && !!filePath;
  const pendingEnabled = pending && !!slug && !!filePath;

  const committed = useQuery({
    queryKey: ["diff-file", slug, base, head, filePath],
    queryFn: () => api.diffFile(slug!, base!, head!, filePath!),
    enabled: committedEnabled,
  });
  const pendingQ = useQuery({
    queryKey: ["pending-file", slug, branch, filePath],
    queryFn: () => api.pending(slug!, filePath!, branch ?? undefined),
    enabled: pendingEnabled,
  });

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center text-fg-dim p-6">
        <div className="text-center max-w-sm">
          <div className="text-[14px] text-fg-bright mb-2">Pick a file</div>
          <div className="text-[13px] text-fg-dim">
            Select a file in the Files panel to view its diff.
          </div>
        </div>
      </div>
    );
  }

  // Hold on spinner until the active query has at least one resolved response.
  // Without this, the "NO DELTA FOR THIS FILE" empty state flashes for every
  // diff switch while the patch is still in flight.
  const activeQuery = pending ? pendingQ : committed;
  const queryEnabled = pending ? pendingEnabled : committedEnabled;
  const loading =
    queryEnabled && (activeQuery.isPending || (activeQuery.isFetching && !activeQuery.data));

  const patch = pending ? (pendingQ.data?.patch ?? "") : (committed.data?.patch ?? "");
  const parsed = parseUnifiedDiff(patch);
  const totalAdd = parsed.hunks.reduce(
    (s, h) => s + h.lines.filter((l) => l.kind === "add").length,
    0,
  );
  const totalDel = parsed.hunks.reduce(
    (s, h) => s + h.lines.filter((l) => l.kind === "del").length,
    0,
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 h-9 px-4 flex items-center gap-3 bg-bg-deep border-b border-bg-line">
        <span className="mono text-[11px] uppercase tracking-wider text-data">Diff</span>
        <span className="font-mono text-[12.5px] text-fg-bright truncate flex-1">{filePath}</span>
        <span className="font-mono text-[11.5px] tabular-nums shrink-0">
          <span className="text-ok">+{totalAdd}</span>
          <span className="text-fg-faint mx-1.5">·</span>
          <span className="text-anom">−{totalDel}</span>
        </span>
        {parsed.isBinary && <span className="text-[11px] text-amber">binary</span>}
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin bg-bg-void">
        {loading ? (
          <PanelLoading label={pending ? "Loading pending diff" : "Loading diff"} />
        ) : parsed.isBinary ? (
          <div className="p-8 text-fg-dim text-[13px]">Binary file — no preview</div>
        ) : parsed.hunks.length === 0 ? (
          <div className="p-8 text-fg-dim text-[13px]">No changes for this file</div>
        ) : (
          parsed.hunks.map((h, i) => (
            <div key={i} className="mb-3">
              <div className="sticky top-0 z-10 px-4 py-1 bg-bg-panel/95 backdrop-blur border-b border-bg-line flex items-center gap-3">
                <span className="mono text-[10.5px] uppercase tracking-wider text-amber">
                  Hunk
                </span>
                <span className="font-mono text-[11px] text-fg-dim">{h.header}</span>
              </div>
              <table className="w-full font-mono text-[12px] leading-[1.55]">
                <tbody>
                  {h.lines.map((ln, j) => (
                    <Row key={j} line={ln} />
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Row({ line }: { line: DiffLine }) {
  const bg =
    line.kind === "add"
      ? "bg-phos/[0.08]"
      : line.kind === "del"
        ? "bg-anom/[0.09]"
        : "bg-transparent";
  const gutter =
    line.kind === "add"
      ? "bg-phos/[0.15] text-phos"
      : line.kind === "del"
        ? "bg-anom/[0.15] text-anom"
        : "text-fg-faint";
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const text =
    line.kind === "ctx" ? "text-fg-base" : line.kind === "add" ? "text-phos/90" : "text-anom/90";

  return (
    <tr className={cn(bg, "group")}>
      <td
        className={cn(
          "select-none text-right px-2 w-[52px] text-[10.5px] tabular-nums border-r border-bg-line/50",
          gutter,
        )}
      >
        {line.oldN ?? ""}
      </td>
      <td
        className={cn(
          "select-none text-right px-2 w-[52px] text-[10.5px] tabular-nums border-r border-bg-line/50",
          gutter,
        )}
      >
        {line.newN ?? ""}
      </td>
      <td className={cn("select-none w-4 text-center", gutter)}>{sign}</td>
      <td className={cn("pl-2 pr-4 whitespace-pre", text)}>{line.text || "\u00a0"}</td>
    </tr>
  );
}
