import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type GroupVerdict, type GroupVerdictRecord } from "../../lib/api";
import { useSelection } from "../../lib/store";
import { GroupCard } from "./GroupCard";
import { ReviewContext } from "./ReviewContext";
import { VerdictStrip } from "./VerdictStrip";
import { VerdictBar } from "./VerdictBar";
import { DiscussDrawer } from "./DiscussDrawer";
import { FixDrawer } from "./FixDrawer";
import { HelpOverlay } from "./HelpOverlay";
import { CompletionBanner } from "./CompletionBanner";
import { VERDICTS } from "./verdictTokens";
import { PanelLoading } from "../PanelLoading";

type VerdictKey = Exclude<GroupVerdict, "pending">;

export function ReviewSession() {
  const slug = useSelection((s) => s.slug);
  const setReviewMode = useSelection((s) => s.setReviewMode);
  const qc = useQueryClient();

  const [cursor, setCursor] = useState(0);
  const [diffOpen, setDiffOpen] = useState(true);
  const [stampKey, setStampKey] = useState(0);
  const [flash, setFlash] = useState<GroupVerdict | null>(null);
  const [discussOpen, setDiscussOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [submitting, setSubmitting] = useState<GroupVerdict | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [lastFixPrompt, setLastFixPrompt] = useState<string | null>(null);

  const intentsQ = useQuery({
    queryKey: ["intents", slug],
    queryFn: () => api.intents(slug!),
    enabled: !!slug,
    retry: false,
  });

  const reviewQ = useQuery({
    queryKey: ["review", slug],
    queryFn: () => api.reviewState(slug!),
    enabled: !!slug,
    retry: false,
  });

  const groups = useMemo(
    () => intentsQ.data?.groups ?? [],
    [intentsQ.data],
  );
  const negativeSpace = intentsQ.data?.negativeSpace ?? [];
  const openQuestions = intentsQ.data?.openQuestions ?? [];
  const uncoveredFiles = intentsQ.data?.uncoveredFiles ?? [];
  const orphanCommits = intentsQ.data?.orphanCommits ?? [];

  const verdictMap = useMemo(() => {
    const m = new Map<string, GroupVerdictRecord>();
    for (const v of reviewQ.data?.verdicts ?? []) m.set(v.groupId, v);
    return m;
  }, [reviewQ.data]);

  const verdictsByIndex: GroupVerdict[] = useMemo(
    () => groups.map((g) => verdictMap.get(g.id)?.verdict ?? "pending"),
    [groups, verdictMap],
  );

  const tally = useMemo(() => {
    const base: Record<VerdictKey, number> = {
      approved: 0,
      rejected: 0,
      discuss: 0,
      rework: 0,
    };
    for (const v of verdictsByIndex) {
      if (v !== "pending") base[v as VerdictKey] += 1;
    }
    return base;
  }, [verdictsByIndex]);

  const decided = verdictsByIndex.filter((v) => v !== "pending").length;
  const allDone = groups.length > 0 && decided === groups.length;

  const current = groups[cursor];
  const currentVerdict = current ? (verdictMap.get(current.id)?.verdict ?? "pending") : "pending";
  const currentNote = current ? (verdictMap.get(current.id)?.note ?? null) : null;

  const invalidateReview = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["review", slug] });
  }, [qc, slug]);

  const go = useCallback(
    (delta: number) => {
      if (groups.length === 0) return;
      setCursor((c) => {
        const next = Math.max(0, Math.min(groups.length - 1, c + delta));
        if (next !== c) {
          setStampKey((k) => k + 1);
        }
        return next;
      });
    },
    [groups.length],
  );

  const jump = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= groups.length) return;
      setCursor(idx);
      setStampKey((k) => k + 1);
    },
    [groups.length],
  );

  const advanceAfterVerdict = useCallback(() => {
    if (cursor < groups.length - 1) {
      setTimeout(() => go(1), 160);
    }
  }, [cursor, groups.length, go]);

  const submitVerdict = useCallback(
    async (v: VerdictKey, note?: string) => {
      if (!current || !slug) return;
      setSubmitting(v);
      setFlash(v);
      try {
        await api.submitVerdict(slug, current.id, v, note);
        invalidateReview();
        setStampKey((k) => k + 1);
        advanceAfterVerdict();
      } finally {
        setSubmitting(null);
        setTimeout(() => setFlash(null), 260);
      }
    },
    [current, slug, invalidateReview, advanceAfterVerdict],
  );

  const submitDiscuss = useCallback(
    async (note: string) => {
      if (!current || !slug) return;
      setSubmitting("discuss");
      setFlash("discuss");
      try {
        await api.submitDiscuss(slug, current.id, note);
        invalidateReview();
        setStampKey((k) => k + 1);
        setDiscussOpen(false);
        advanceAfterVerdict();
      } finally {
        setSubmitting(null);
        setTimeout(() => setFlash(null), 260);
      }
    },
    [current, slug, invalidateReview, advanceAfterVerdict],
  );

  const composeFix = useCallback(
    async (note: string) => {
      if (!current || !slug) return;
      setSubmitting("rework");
      try {
        const res = await api.submitFix(slug, current.id, {
          note,
          files: current.files,
          commits: current.commits.map((c) => c.shortSha),
          title: current.title,
          classification: current.classification,
        });
        setLastFixPrompt(res.prompt);
        invalidateReview();
        setStampKey((k) => k + 1);
      } finally {
        setSubmitting(null);
      }
    },
    [current, slug, invalidateReview],
  );

  const undoCurrent = useCallback(async () => {
    if (!current || !slug) return;
    if (currentVerdict === "pending") return;
    await api.submitVerdict(slug, current.id, "pending");
    invalidateReview();
    setStampKey((k) => k + 1);
  }, [current, slug, currentVerdict, invalidateReview]);

  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    if (groups.length === 0 || !reviewQ.data) return;
    bootRef.current = true;
    const firstUndecided = verdictsByIndex.findIndex((v) => v === "pending");
    if (firstUndecided > 0) setCursor(firstUndecided);
  }, [groups.length, reviewQ.data, verdictsByIndex]);

  useEffect(() => {
    if (allDone && !celebrate) setCelebrate(true);
    if (!allDone && celebrate) setCelebrate(false);
  }, [allDone, celebrate]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod) return;
      if (discussOpen || fixOpen) return;

      const key = e.key;
      switch (key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          go(1);
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          go(-1);
          break;
        case "g":
          e.preventDefault();
          jump(0);
          break;
        case "G":
          e.preventDefault();
          jump(groups.length - 1);
          break;
        case "a":
          e.preventDefault();
          if (!submitting) submitVerdict("approved");
          break;
        case "r":
          e.preventDefault();
          if (!submitting) submitVerdict("rejected");
          break;
        case "d":
          e.preventDefault();
          setDiscussOpen(true);
          break;
        case "f":
          e.preventDefault();
          setFixOpen(true);
          setLastFixPrompt(null);
          break;
        case "u":
          e.preventDefault();
          if (!submitting) undoCurrent();
          break;
        case "v":
          e.preventDefault();
          setDiffOpen((x) => !x);
          break;
        case "e":
          e.preventDefault();
          setReviewMode(false);
          break;
        case "?":
          e.preventDefault();
          setHelpOpen(true);
          break;
        case "Escape":
          if (helpOpen) setHelpOpen(false);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    go,
    jump,
    groups.length,
    submitVerdict,
    submitting,
    discussOpen,
    fixOpen,
    helpOpen,
    undoCurrent,
    setReviewMode,
  ]);

  if (!slug) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-[16px] text-fg-bright mb-2">No run selected</div>
          <div className="text-[13px] text-fg-dim">
            Pick a run from the left panel to start reviewing.
          </div>
        </div>
      </div>
    );
  }

  if (intentsQ.isPending || reviewQ.isPending) {
    return <PanelLoading label="LOADING REVIEW SURFACE" />;
  }

  if (groups.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-center p-8">
        <div className="max-w-md">
          <div className="text-[16px] text-fg-bright mb-2">No intent groups</div>
          <div className="text-[13px] text-fg-dim">
            This run has no commits yet, or the ACB store is empty.
          </div>
          <button
            onClick={() => setReviewMode(false)}
            className="btn btn-ghost mt-6 mx-auto"
          >
            <span>Back to inspector</span>
            <span className="kbd">e</span>
          </button>
        </div>
      </div>
    );
  }

  if (celebrate) {
    return (
      <CompletionBanner
        total={groups.length}
        tally={tally}
        onExit={() => setReviewMode(false)}
      />
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 gridbg">
      {/* Progress strip */}
      <div className="shrink-0 h-12 px-5 flex items-center gap-4 border-b border-bg-line bg-bg-deep">
        <span className="font-semibold text-[13px] text-fg-bright">Review</span>
        <span className="mono text-[11.5px] text-fg-faint tabular-nums">
          {decided}/{groups.length}
        </span>
        <div className="mx-2 h-5 w-px bg-bg-line" />
        <VerdictStrip verdicts={verdictsByIndex} cursor={cursor} onJump={jump} />
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-3 pr-2 text-[11.5px]">
            {(Object.keys(VERDICTS) as Array<keyof typeof VERDICTS>).map((k) => (
              <TallyChip
                key={k}
                label={VERDICTS[k].label}
                value={tally[k]}
                color={VERDICTS[k].color}
              />
            ))}
          </div>
          <button
            onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts"
            className="btn btn-subtle btn-sm"
          >
            <span>Help</span>
            <span className="kbd">?</span>
          </button>
          <button
            onClick={() => setReviewMode(false)}
            className="btn btn-ghost btn-sm"
            title="Exit review"
          >
            <span>Exit</span>
            <span className="kbd">e</span>
          </button>
        </div>
      </div>

      {/* Stage */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="max-w-[1040px] mx-auto p-6 pb-[120px] space-y-4">
          <ReviewContext
            negativeSpace={negativeSpace}
            openQuestions={openQuestions}
            uncoveredFiles={uncoveredFiles}
            orphanCommits={orphanCommits}
          />
          {current && (
            <GroupCard
              key={current.id + ":" + stampKey}
              group={current}
              index={cursor}
              total={groups.length}
              verdict={currentVerdict}
              note={currentNote}
              slug={slug}
              diffOpen={diffOpen}
              stampKey={stampKey}
            />
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="shrink-0 h-[72px] border-t border-bg-line bg-bg-deep flex items-center justify-between px-5 gap-4">
        <div className="flex items-center gap-2">
          <button onClick={() => go(-1)} className="btn btn-ghost" title="Previous (k)">
            <span className="text-[14px] leading-none">↑</span>
            <span>Prev</span>
            <span className="kbd">k</span>
          </button>
          <button onClick={() => go(1)} className="btn btn-ghost" title="Next (j)">
            <span className="text-[14px] leading-none">↓</span>
            <span>Next</span>
            <span className="kbd">j</span>
          </button>
          <button
            onClick={() => setDiffOpen((x) => !x)}
            className="btn btn-ghost"
            title="Toggle diff (v)"
          >
            <span className="text-[14px] leading-none">{diffOpen ? "◑" : "◐"}</span>
            <span>{diffOpen ? "Hide diff" : "Show diff"}</span>
            <span className="kbd">v</span>
          </button>
        </div>
        <VerdictBar
          current={currentVerdict}
          flashing={flash}
          onPick={(v) => {
            if (v === "discuss") {
              setDiscussOpen(true);
              return;
            }
            if (v === "rework") {
              setFixOpen(true);
              setLastFixPrompt(null);
              return;
            }
            if (!submitting) submitVerdict(v);
          }}
          onUndo={undoCurrent}
          canUndo={currentVerdict !== "pending"}
        />
      </div>

      {/* Drawers + overlays */}
      <DiscussDrawer
        open={discussOpen}
        groupTitle={current?.title ?? ""}
        initial={currentVerdict === "discuss" ? currentNote ?? "" : ""}
        onCancel={() => setDiscussOpen(false)}
        onSubmit={submitDiscuss}
      />
      <FixDrawer
        open={fixOpen}
        groupTitle={current?.title ?? ""}
        initialNote={currentVerdict === "rework" ? currentNote ?? "" : ""}
        prompt={lastFixPrompt}
        generating={submitting === "rework"}
        onCancel={() => {
          setFixOpen(false);
          setLastFixPrompt(null);
        }}
        onGenerate={composeFix}
      />
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function TallyChip({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  const dim = value === 0;
  return (
    <span
      className="flex items-center gap-1.5 px-2 h-6 rounded-md border"
      style={{
        borderColor: dim ? "#44475a" : color,
        background: dim ? "transparent" : `${color}14`,
      }}
      title={`${label}: ${value}`}
    >
      <span
        className="font-mono text-[12px] tabular-nums font-semibold"
        style={{ color: dim ? "#6272a4" : color }}
      >
        {value}
      </span>
      <span className="text-[11px]" style={{ color: dim ? "#6272a4" : color }}>
        {label}
      </span>
    </span>
  );
}
