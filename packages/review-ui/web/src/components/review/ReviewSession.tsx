import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type GroupVerdict, type GroupVerdictRecord } from "../../lib/api";
import { useSelection } from "../../lib/store";
import { computeQueue, nextActive, prevActive } from "../../lib/queue";
import { GroupCard } from "./GroupCard";
import { ReviewQueue } from "./ReviewQueue";
import { ReviewContext } from "./ReviewContext";
import { CompositeBanner } from "./CompositeBanner";
import { StandbyPanel } from "./StandbyPanel";
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
  const activeIntentId = useSelection((s) => s.activeIntentId);
  const setActiveIntentId = useSelection((s) => s.setActiveIntentId);
  const autoAdvance = useSelection((s) => s.reviewAutoAdvance);
  const setAutoAdvance = useSelection((s) => s.setReviewAutoAdvance);
  const qc = useQueryClient();

  const [diffOpen, setDiffOpen] = useState(true);
  const [stampKey, setStampKey] = useState(0);
  const [discussOpen, setDiscussOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [submitting, setSubmitting] = useState<GroupVerdict | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [lastFixPrompt, setLastFixPrompt] = useState<string | null>(null);
  const [showReviewed, setShowReviewed] = useState(false);

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

  const tasksQ = useQuery({
    queryKey: ["tasks", slug],
    queryFn: () => api.tasks(slug!),
    enabled: !!slug,
    retry: false,
  });

  const groups = intentsQ.data?.groups ?? [];
  const verdicts: GroupVerdictRecord[] = reviewQ.data?.verdicts ?? [];
  const negativeSpace = intentsQ.data?.negativeSpace ?? [];
  const openQuestions = intentsQ.data?.openQuestions ?? [];
  const uncoveredFiles = intentsQ.data?.uncoveredFiles ?? [];
  const orphanCommits = intentsQ.data?.orphanCommits ?? [];

  const queue = useMemo(() => computeQueue(groups, verdicts), [groups, verdicts]);

  // Orchestrator still has steps open → more manifests likely coming.
  const openSteps = useMemo(() => {
    const all = (tasksQ.data?.tasks ?? []).flatMap((t) => t.steps);
    return all.filter((s) => s.status !== "completed" && s.status !== "skipped").length;
  }, [tasksQ.data]);
  const waitingCount = Math.max(0, openSteps - queue.ready.length);

  const verdictMap = useMemo(() => {
    const m = new Map<string, GroupVerdictRecord>();
    for (const v of verdicts) m.set(v.groupId, v);
    return m;
  }, [verdicts]);

  const tally = useMemo(() => {
    const base: Record<VerdictKey, number> = {
      accepted: 0,
      rejected: 0,
      needs_discussion: 0,
      rework: 0,
    };
    for (const v of verdicts) {
      if (v.verdict !== "pending") base[v.verdict as VerdictKey] += 1;
    }
    return base;
  }, [verdicts]);

  const decided = verdicts.filter((v) => v.verdict !== "pending").length;
  const allDone =
    groups.length > 0 && queue.ready.length === 0 && queue.stale.length === 0 && waitingCount === 0;

  // Active item: find it in groups by id. Fall back to head of activeOrder.
  const activeItem = useMemo(() => {
    if (activeIntentId) {
      const staleHit = queue.stale.find((q) => q.groupId === activeIntentId);
      if (staleHit) return staleHit;
      const readyHit = queue.ready.find((q) => q.groupId === activeIntentId);
      if (readyHit) return readyHit;
      const revHit = queue.reviewed.find((q) => q.groupId === activeIntentId);
      if (revHit) return revHit;
    }
    return queue.stale[0] ?? queue.ready[0] ?? null;
  }, [activeIntentId, queue]);

  const current = activeItem?.group ?? null;
  const currentVerdict = current
    ? verdictMap.get(current.id)?.verdict ?? "pending"
    : "pending";
  const currentNote = current ? verdictMap.get(current.id)?.note ?? null : null;

  const invalidateReview = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["review", slug] });
  }, [qc, slug]);

  const jumpTo = useCallback(
    (id: string | null) => {
      setActiveIntentId(id);
      setStampKey((k) => k + 1);
    },
    [setActiveIntentId],
  );

  const nextInQueue = useCallback(() => {
    const id = nextActive(queue, activeIntentId);
    jumpTo(id);
  }, [queue, activeIntentId, jumpTo]);

  const prevInQueue = useCallback(() => {
    const id = prevActive(queue, activeIntentId);
    if (id) jumpTo(id);
  }, [queue, activeIntentId, jumpTo]);

  const advanceAfterVerdict = useCallback(() => {
    if (!autoAdvance) return;
    setTimeout(() => {
      // Recompute queue lazily — the verdict write will invalidate and the
      // next render will have the updated queue. Use the current reference
      // to pick head-of-active-order; if empty, null = standby.
      const currentQueue = computeQueue(groups, verdicts);
      const id =
        currentQueue.activeOrder.find((q) => q !== activeIntentId) ??
        currentQueue.activeOrder[0] ??
        null;
      jumpTo(id);
    }, 250);
  }, [autoAdvance, groups, verdicts, activeIntentId, jumpTo]);

  const submitVerdict = useCallback(
    async (v: VerdictKey, note?: string) => {
      if (!current || !slug) return;
      setSubmitting(v);
      try {
        await api.submitVerdict(slug, current.id, v, note);
        invalidateReview();
        setStampKey((k) => k + 1);
        advanceAfterVerdict();
      } finally {
        setSubmitting(null);
      }
    },
    [current, slug, invalidateReview, advanceAfterVerdict],
  );

  const submitDiscuss = useCallback(
    async (note: string) => {
      if (!current || !slug) return;
      setSubmitting("needs_discussion");
      try {
        await api.submitDiscuss(slug, current.id, note);
        invalidateReview();
        setStampKey((k) => k + 1);
        setDiscussOpen(false);
        advanceAfterVerdict();
      } finally {
        setSubmitting(null);
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

  // On first load: pick head of queue if nothing active.
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    if (!reviewQ.data || !intentsQ.data) return;
    bootRef.current = true;
    if (!activeIntentId && queue.activeOrder.length > 0) {
      jumpTo(queue.activeOrder[0]);
    }
  }, [reviewQ.data, intentsQ.data, activeIntentId, queue.activeOrder, jumpTo]);

  // Auto-queue newly arrived intents when user is in standby.
  useEffect(() => {
    if (!autoAdvance) return;
    if (activeIntentId) return;
    if (queue.activeOrder.length === 0) return;
    jumpTo(queue.activeOrder[0]);
  }, [autoAdvance, activeIntentId, queue.activeOrder, jumpTo]);

  useEffect(() => {
    if (allDone && queue.reviewed.length > 0 && !celebrate) setCelebrate(true);
    if (!allDone && celebrate) setCelebrate(false);
  }, [allDone, celebrate, queue.reviewed.length]);

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
        case "Tab":
          e.preventDefault();
          nextInQueue();
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          prevInQueue();
          break;
        case "a":
          e.preventDefault();
          if (!submitting) submitVerdict("accepted");
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
        case " ":
          e.preventDefault();
          setAutoAdvance(!autoAdvance);
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
    nextInQueue,
    prevInQueue,
    submitVerdict,
    submitting,
    discussOpen,
    fixOpen,
    helpOpen,
    undoCurrent,
    setReviewMode,
    autoAdvance,
    setAutoAdvance,
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
    return <PanelLoading label="Loading review" />;
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
      <div className="shrink-0 h-11 px-5 flex items-center gap-4 border-b border-bg-line bg-bg-deep">
        <span className="font-semibold text-[13.5px] text-fg-bright">Review</span>
        <span className="mono text-[12px] text-fg-faint tabular-nums">
          {decided}/{groups.length} reviewed · {queue.stale.length} stale
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5 pr-1">
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
            onClick={() => setAutoAdvance(!autoAdvance)}
            title={autoAdvance ? "Pause queue (space)" : "Resume auto-advance (space)"}
            className={`btn btn-sm ${autoAdvance ? "btn-ghost is-active" : "btn-ghost"}`}
          >
            <span>{autoAdvance ? "Auto · on" : "Auto · off"}</span>
            <span className="kbd">⎵</span>
          </button>
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

      {/* Queue + active */}
      <div className="flex-1 grid grid-cols-[320px_1fr] min-h-0">
        <ReviewQueue
          queue={queue}
          activeId={activeIntentId}
          onSelect={jumpTo}
          waiting={waitingCount}
        />
        <div className="overflow-auto scrollbar-thin min-w-0">
          {activeItem && current ? (
            <div className="max-w-[1180px] mx-auto p-6 pb-[120px] space-y-4">
              <ReviewContext
                negativeSpace={negativeSpace}
                openQuestions={openQuestions}
                uncoveredFiles={uncoveredFiles}
                orphanCommits={orphanCommits}
              />
              <GroupCard
                key={current.id + ":" + stampKey}
                group={current}
                index={queue.activeOrder.indexOf(current.id) + 1 || 1}
                total={queue.ready.length + queue.stale.length + queue.reviewed.length}
                verdict={currentVerdict}
                note={currentNote}
                slug={slug}
                diffOpen={diffOpen}
                stampKey={stampKey}
                endBase={intentsQ.data?.endBase ?? null}
                endHead={intentsQ.data?.endHead ?? null}
                onVerdict={(v) => {
                  if (v === "needs_discussion") {
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
                working={
                  submitting && submitting !== "pending"
                    ? (submitting as VerdictKey)
                    : null
                }
                focused={true}
                aboveSlot={
                  activeItem.stale ? (
                    <CompositeBanner
                      item={activeItem}
                      working={!!submitting}
                      onKeep={() => {
                        if (!submitting && activeItem.verdict !== "pending") {
                          submitVerdict(activeItem.verdict as VerdictKey);
                        }
                      }}
                    />
                  ) : undefined
                }
              />
            </div>
          ) : (
            <StandbyPanel
              reviewedCount={queue.reviewed.length}
              waitingCount={waitingCount}
              onResume={autoAdvance ? undefined : () => setAutoAdvance(true)}
              onRevisit={
                queue.reviewed.length > 0 && !showReviewed
                  ? () => {
                      setShowReviewed(true);
                      jumpTo(queue.reviewed[0]?.groupId ?? null);
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>

      {/* Footer: nav + auto-advance hint (no verdict CTAs — those are per-card now) */}
      <div className="shrink-0 h-[60px] border-t border-bg-line bg-bg-deep flex items-center justify-between px-5 gap-4">
        <div className="flex items-center gap-2">
          <button onClick={prevInQueue} className="btn btn-ghost btn-sm" title="Previous (k)">
            <span className="text-[13px] leading-none">↑</span>
            <span>Prev</span>
            <span className="kbd">k</span>
          </button>
          <button onClick={nextInQueue} className="btn btn-ghost btn-sm" title="Next (j / Tab)">
            <span className="text-[13px] leading-none">↓</span>
            <span>Next</span>
            <span className="kbd">j</span>
          </button>
          <button
            onClick={() => setDiffOpen((x) => !x)}
            className="btn btn-ghost btn-sm"
            title="Toggle diff (v)"
          >
            <span className="text-[13px] leading-none">{diffOpen ? "◑" : "◐"}</span>
            <span>{diffOpen ? "Hide diff" : "Show diff"}</span>
            <span className="kbd">v</span>
          </button>
          <button
            onClick={undoCurrent}
            disabled={currentVerdict === "pending"}
            className={`btn btn-subtle btn-sm ${currentVerdict === "pending" ? "is-disabled" : ""}`}
            title="Undo verdict (u)"
          >
            <span>Undo</span>
            <span className="kbd">u</span>
          </button>
        </div>
        <div className="text-[12px] text-fg-dim">
          Verdict CTAs live on the intent card. {autoAdvance ? "Auto-advance on — pick a verdict, next intent queues up automatically." : "Auto-advance paused."}
        </div>
      </div>

      {/* Drawers + overlays */}
      <DiscussDrawer
        open={discussOpen}
        groupTitle={current?.title ?? ""}
        initial={currentVerdict === "needs_discussion" ? currentNote ?? "" : ""}
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
