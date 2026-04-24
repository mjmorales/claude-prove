import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type GroupVerdict } from "../lib/api";
import { useSelection } from "../lib/store";
import { useConnection } from "../hooks/useConnection";
import { cn } from "../lib/cn";
import { PALETTE } from "./review/verdictTokens";

type VerdictKey = Exclude<GroupVerdict, "pending">;

// Labels diverge from the canonical verdict tokens ("Approved" past-tense vs
// "Approve" imperative in VERDICTS). Colors are sourced from PALETTE to keep
// the palette single-source.
const VERDICT_META: Record<VerdictKey, { label: string; color: string }> = {
  accepted: { label: "Approved", color: PALETTE.verdict.accepted },
  rejected: { label: "Rejected", color: PALETTE.verdict.rejected },
  needs_discussion: { label: "Discuss", color: PALETTE.verdict.needsDiscussion },
  rework: { label: "Rework", color: PALETTE.verdict.rework },
};

export function StatusHeader({
  onOpenPalette,
}: {
  onOpenPalette: (query?: string) => void;
}) {
  const { state } = useConnection();
  const slug = useSelection((s) => s.slug);
  const branch = useSelection((s) => s.branch);
  const reviewMode = useSelection((s) => s.reviewMode);
  const setReviewMode = useSelection((s) => s.setReviewMode);
  const { data: runs } = useQuery({ queryKey: ["runs"], queryFn: api.runs });
  const { data: tasks } = useQuery({
    queryKey: ["tasks", slug],
    queryFn: () => api.tasks(slug!),
    enabled: !!slug,
    retry: false,
  });
  const { data: intents } = useQuery({
    queryKey: ["intents", slug],
    queryFn: () => api.intents(slug!),
    enabled: !!slug,
    retry: false,
  });
  const { data: review } = useQuery({
    queryKey: ["review", slug],
    queryFn: () => api.reviewState(slug!),
    enabled: !!slug,
    retry: false,
  });

  const run = runs?.runs.find((r) => r.composite === slug);
  const allSteps = (tasks?.tasks ?? []).flatMap((t) => t.steps);
  const done = allSteps.filter((s) => s.status === "completed").length;
  const total = allSteps.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const connTone =
    state === "live" ? "ok" : state === "stale" ? "amber" : state === "down" ? "anom" : "dim";
  const connLabel =
    state === "live" ? "Live" : state === "stale" ? "Stale" : state === "down" ? "Offline" : "Idle";

  const tally = computeTally(intents?.groups.length ?? 0, review?.verdicts ?? []);
  const hasReviewable = (intents?.groups.length ?? 0) > 0;

  return (
    <header className="shrink-0 border-b border-bg-line bg-bg-deep">
      {/* Row 1: brand · run context · connection · review button */}
      <div className="h-12 px-4 flex items-center gap-4">
        <div className="flex items-center gap-2.5 pr-3 border-r border-bg-line h-6">
          <span className="w-2 h-2 rounded-full bg-phos shadow-phos" />
          <span className="font-mono font-bold text-[14px] text-fg-bright">prove</span>
          <span className="mono text-[13px] text-fg-faint">/</span>
          <span className="mono text-[13px] text-fg-dim">review</span>
        </div>

        {slug ? (
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="eyebrow">Run</span>
              <span className="mono text-[13.5px] text-fg-bright truncate max-w-[280px]">
                {run ? `${run.branch}/${run.slug}` : slug}
              </span>
            </div>
            {branch && (
              <div className="flex items-center gap-2 min-w-0">
                <span className="eyebrow">Branch</span>
                <span className="mono text-[13.5px] text-data truncate max-w-[220px]">{branch}</span>
              </div>
            )}
            {total > 0 && (
              <div className="flex items-center gap-2">
                <span className="eyebrow">Steps</span>
                <ProgressChip pct={pct} done={done} total={total} />
              </div>
            )}
          </div>
        ) : (
          <span className="text-fg-dim text-[13.5px]">Select a run to begin</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <SearchBox onOpenPalette={onOpenPalette} />

          <div
            className="flex items-center gap-2 px-3 h-8 rounded-md border border-bg-line bg-bg-panel"
            title={`Connection: ${connLabel}`}
          >
            <span
              className={cn(
                "led",
                connTone === "ok" && "led-ok",
                connTone === "amber" && "led-amber",
                connTone === "anom" && "led-red",
                connTone === "dim" && "led-dim",
              )}
            />
            <span className="mono text-[12px] text-fg-base">{connLabel}</span>
          </div>

          <button
            onClick={() => setReviewMode(!reviewMode)}
            disabled={!slug}
            title={slug ? "Toggle review mode" : "Select a run first"}
            className={cn(
              "btn btn-sm",
              reviewMode ? "btn-primary" : "btn-ghost",
              !slug && "is-disabled",
            )}
          >
            <span className="text-[14px] leading-none">{reviewMode ? "◉" : "▶"}</span>
            <span>{reviewMode ? "Reviewing" : "Review"}</span>
            <span className={cn("kbd", reviewMode && "kbd-on-solid")}>⇧R</span>
          </button>
        </div>
      </div>

      {/* Row 2: verdict summary (only when a run has reviewable groups) */}
      {slug && hasReviewable && (
        <div className="h-9 px-4 flex items-center gap-3 border-t border-bg-line bg-bg-deep/60">
          <span className="eyebrow">Verdicts</span>
          <div className="flex items-center gap-1.5">
            {(Object.keys(VERDICT_META) as VerdictKey[]).map((k) => (
              <VerdictChip
                key={k}
                label={VERDICT_META[k].label}
                color={VERDICT_META[k].color}
                value={tally[k]}
                onClick={() => setReviewMode(true)}
              />
            ))}
            <VerdictChip
              label="Pending"
              color={PALETTE.accent.dim}
              value={tally.pending}
              onClick={() => setReviewMode(true)}
              dim
            />
          </div>
          <div className="ml-auto flex items-center gap-2 text-[12px] text-fg-dim">
            <span>
              <span className="text-fg-bright font-medium">{tally.decided}</span>
              <span className="text-fg-faint">/{intents?.groups.length ?? 0}</span> reviewed
            </span>
          </div>
        </div>
      )}
    </header>
  );
}

function SearchBox({ onOpenPalette }: { onOpenPalette: (q?: string) => void }) {
  const [val, setVal] = useState("");
  return (
    <div className="relative">
      <input
        value={val}
        readOnly
        onFocus={() => {
          onOpenPalette(val);
          setVal("");
        }}
        placeholder="Search runs, files, commits…"
        className="w-[280px] h-8 pl-8 pr-16 rounded-md border border-bg-line bg-bg-panel text-[13px] text-fg-base placeholder:text-fg-faint focus:outline-none focus:border-phos cursor-text"
      />
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint text-[13px]">
        ⌕
      </span>
      <span className="absolute right-2 top-1/2 -translate-y-1/2 kbd pointer-events-none">⌘K</span>
    </div>
  );
}

function ProgressChip({ pct, done, total }: { pct: number; done: number; total: number }) {
  const color =
    pct === 100
      ? PALETTE.verdict.accepted
      : pct >= 50
        ? PALETTE.accent.phos
        : PALETTE.verdict.rework;
  return (
    <div className="flex items-center gap-2">
      <div className="relative w-28 h-1.5 bg-bg-raised rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="mono text-[12px] tabular-nums text-fg-base">
        {done}/{total}
        <span className="text-fg-faint ml-1.5">{pct}%</span>
      </span>
    </div>
  );
}

function VerdictChip({
  label,
  value,
  color,
  onClick,
  dim,
}: {
  label: string;
  value: number;
  color: string;
  onClick?: () => void;
  dim?: boolean;
}) {
  const empty = value === 0;
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2 h-6 rounded-md border transition-colors"
      style={{
        borderColor: empty ? PALETTE.surface.border : color,
        background: empty ? "transparent" : `${color}14`,
      }}
      title={`${label}: ${value}${onClick ? " — click to review" : ""}`}
    >
      <span
        className="font-mono text-[12px] tabular-nums font-semibold"
        style={{ color: empty ? PALETTE.accent.dim : color }}
      >
        {value}
      </span>
      <span className="text-[11.5px]" style={{ color: empty || dim ? PALETTE.accent.dim : color }}>
        {label}
      </span>
    </button>
  );
}

function computeTally(
  totalGroups: number,
  verdicts: Array<{ groupId: string; verdict: GroupVerdict }>,
) {
  const base = {
    accepted: 0,
    rejected: 0,
    needs_discussion: 0,
    rework: 0,
    pending: 0,
    decided: 0,
  };
  for (const v of verdicts) {
    if (v.verdict === "pending") continue;
    base[v.verdict as VerdictKey] += 1;
    base.decided += 1;
  }
  base.pending = Math.max(0, totalGroups - base.decided);
  return base;
}
