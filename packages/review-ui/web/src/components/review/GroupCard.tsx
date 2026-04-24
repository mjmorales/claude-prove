import { cn } from "../../lib/cn";
import type { GroupVerdict, IntentGroupView } from "../../lib/api";
import { PALETTE, tokenOf, VERDICTS } from "./verdictTokens";
import { VerdictStamp } from "./VerdictStamp";
import { InlineDiff } from "./InlineDiff";

export type ReviewGroup = IntentGroupView;

const SPECULATIVE: ReadonlySet<string> = new Set(["speculative", "implicit"]);
const INFERRED: ReadonlySet<string> = new Set(["inferred"]);

export function GroupCard({
  group,
  index,
  total,
  verdict,
  note,
  slug,
  diffOpen,
  stampKey,
  endBase,
  endHead,
  onVerdict,
  working,
  focused,
  aboveSlot,
}: {
  group: IntentGroupView;
  index: number;
  total: number;
  verdict: GroupVerdict;
  note: string | null;
  slug: string;
  diffOpen: boolean;
  stampKey: number;
  /**
   * End-state review range (from /api/runs/:slug/intents). Files are
   * diffed as `git diff <endBase>..<endHead> -- <file>` so superseded
   * intermediate-commit code isn't shown.
   */
  endBase: string | null;
  endHead: string | null;
  /** Emit a verdict choice for this intent. */
  onVerdict: (v: Exclude<GroupVerdict, "pending">) => void;
  working: Exclude<GroupVerdict, "pending"> | null;
  /** Visual highlight for Tab-focus. */
  focused: boolean;
  /** Optional content rendered above the card header (composite banner). */
  aboveSlot?: React.ReactNode;
}) {
  const t = tokenOf(verdict);
  const cls = group.classification.toLowerCase();
  const risky = SPECULATIVE.has(cls);
  const inferred = INFERRED.has(cls);

  const judgmentCalls = group.annotations.filter((a) => a.type === "judgment_call");
  const flags = group.annotations.filter((a) => a.type === "flag");
  const notes = group.annotations.filter(
    (a) => a.type !== "judgment_call" && a.type !== "flag",
  );

  const anyAnn = judgmentCalls.length + flags.length + notes.length;

  return (
    <>
      {aboveSlot}
      <article
        tabIndex={-1}
        className={cn(
          "rack-in card-face relative border border-bg-line",
          t ? t.cardClass : null,
          focused && "ring-2 ring-phos/60 ring-offset-0",
        )}
      >
        {/* Hazard rail for speculative / no-manifest groups */}
        <div
          className={cn(
            "absolute left-0 top-0 bottom-0 w-[6px] pointer-events-none",
            risky && "rail-hazard",
          )}
        />

        {/* ──────────────── STICKY intent header ────────────────
           Pins to the top of the scrolling inspector so verdict CTAs
           and group context follow the user as they scroll the diffs. */}
        <div className="sticky top-0 z-20 bg-bg-panel border-b border-bg-line rounded-t-md">
          <div className="px-5 pt-4 pb-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="mono text-[11.5px] tabular-nums text-fg-faint">
                {index} / {total}
              </span>
              <span className="mono text-[11px] text-fg-dim truncate max-w-[260px]">
                {group.id}
              </span>
              <ClassificationBadge classification={group.classification} />
              {group.ambiguityTags.map((tag) => (
                <AmbiguityChip key={tag} tag={tag} />
              ))}
              <span className="mono text-[11px] text-fg-faint tabular-nums flex items-center gap-3">
                <span title="Commits">{group.commits.length}c</span>
                <span title="Files">{group.files.length}f</span>
                <span
                  style={{ color: judgmentCalls.length > 0 ? PALETTE.accent.judgment : undefined }}
                  title="Judgement calls"
                >
                  {judgmentCalls.length}⚖
                </span>
                {flags.length > 0 && (
                  <span className="text-anom" title="Flags">
                    {flags.length}⚑
                  </span>
                )}
              </span>
              <div className="ml-auto">
                {t ? (
                  <VerdictStamp verdict={verdict} size="sm" animateKey={stampKey} />
                ) : (
                  <span className="text-[11px] text-fg-faint">Awaiting verdict</span>
                )}
              </div>
            </div>

            <h2 className="mt-2 font-mono text-[17px] leading-snug text-fg-bright break-words">
              {group.title}
            </h2>

            {/* Compact commit line — "225abea feat(diag): …  task/…" */}
            {group.commits.length > 0 && (
              <div className="mt-2 font-mono text-[12px] text-fg-dim flex items-center gap-2 min-w-0">
                <span className="text-data tabular-nums shrink-0">
                  {group.commits[0].shortSha}
                </span>
                <span className="truncate text-fg-base">{group.commits[0].subject}</span>
                <span className="ml-auto text-[11px] text-fg-faint shrink-0">
                  {group.commits[0].branch}
                  {group.commits.length > 1 && ` · +${group.commits.length - 1} more`}
                </span>
              </div>
            )}

            {note && (
              <div
                className="mt-3 px-3 py-2 text-[12.5px] font-mono border-l-2 rounded-r-md bg-bg-deep/60"
                style={{
                  borderColor: t?.color ?? PALETTE.surface.border,
                  color: t?.color ?? PALETTE.accent.neutral,
                }}
              >
                <span
                  className="mr-2 text-[11px] font-sans"
                  style={{ color: t?.color ?? PALETTE.accent.neutral }}
                >
                  Reviewer note:
                </span>
                {note}
              </div>
            )}
          </div>

          {/* Verdict CTA strip — per-intent, always visible at the top. */}
          <div className="px-5 pb-3 flex items-center gap-2 flex-wrap">
            {(["accepted", "rejected", "needs_discussion", "rework"] as const).map((k) => {
              const spec = VERDICTS[k];
              const active = verdict === k;
              const busy = working === k;
              return (
                <button
                  key={k}
                  onClick={() => onVerdict(k)}
                  disabled={!!working}
                  className={cn(
                    "btn btn-sm",
                    active ? spec.btnClass : "btn-ghost",
                    busy && "is-disabled",
                  )}
                  title={`${spec.label} (${spec.keycap})`}
                >
                  <span className="text-[13px] leading-none">{spec.glyph}</span>
                  <span>{spec.label}</span>
                  <span className={cn("kbd", active && "kbd-on-solid")}>{spec.keycap}</span>
                </button>
              );
            })}
            <RiskBar classification={cls} risky={risky} inferred={inferred} />
            {focused && (
              <span className="ml-auto mono text-[11px] text-phos flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-phos" /> focused · Tab next
              </span>
            )}
          </div>
        </div>

        {/* ──────────────── BODY: task-grounding + annotations + per-file diffs ──────────────── */}
        <div className="px-5 pt-4 pb-6 space-y-4">
          {group.taskGrounding && (
            <blockquote className="pl-3 border-l-2 border-data text-[13px] text-fg-base leading-relaxed whitespace-pre-wrap">
              <div className="mono text-[11px] uppercase tracking-wider text-data mb-1">
                Task grounding
              </div>
              {group.taskGrounding}
            </blockquote>
          )}

          {/* Annotations without file-range anchors — these show above diffs.
              Anchored annotations (body starts with `@L<n>[-<m>]:`) render
              inline within the diff for the file they reference. */}
          {anyAnn > 0 && (
            <AnnotationSummary
              judgmentCalls={judgmentCalls.filter((a) => !isAnchored(a.body))}
              flags={flags.filter((a) => !isAnchored(a.body))}
              notes={notes.filter((a) => !isAnchored(a.body))}
            />
          )}

          {!diffOpen && (
            <div className="text-[12.5px] text-fg-dim italic">
              Diffs hidden — press <span className="kbd">v</span> to show.
            </div>
          )}

          {diffOpen && endBase && endHead && group.fileRefs.length > 0 && (
            <div className="space-y-3">
              {group.fileRefs.map((ref, fileIndex) => (
                <FileSection
                  key={ref.path}
                  ref_={ref}
                  slug={slug}
                  endBase={endBase}
                  endHead={endHead}
                  annotations={group.annotations.filter(
                    (a) =>
                      isAnchored(a.body) &&
                      annotationMatchesFile(a, ref.path, fileIndex === 0),
                  )}
                />
              ))}
            </div>
          )}

          {diffOpen && (!endBase || !endHead) && group.commits[0] && (
            <div className="rounded-md border border-amber/40">
              <div className="h-8 px-4 flex items-center gap-3 bg-bg-deep border-b border-bg-line">
                <span className="mono text-[11px] text-amber uppercase tracking-wider">
                  Fallback · per-commit
                </span>
                <span className="text-[11.5px] text-fg-dim">
                  End-state branch unavailable — showing commit diff.
                </span>
              </div>
              {group.fileRefs.slice(0, 1).map((ref) => (
                <InlineDiff
                  key={ref.path}
                  slug={slug}
                  base={`${group.commits[0].sha}^`}
                  head={group.commits[0].sha}
                  path={ref.path}
                />
              ))}
            </div>
          )}
        </div>
      </article>
    </>
  );
}

/** Detect annotation anchor prefix. Authors write `@L42: ...` or `@L10-20: ...`
 *  to pin an annotation to a specific line range. */
function isAnchored(body: string): boolean {
  return /^@L\d+(-\d+)?:/.test(body.trimStart());
}

/** Match an annotation to a file. We support an optional `@file:<path> @L…:`
 *  prefix; when absent we fall back to rendering the annotation only on the
 *  canonical (first) file of the group so un-prefixed annotations don't get
 *  broadcast to every file section. */
function annotationMatchesFile(
  ann: { id: string; body: string },
  filePath: string,
  isCanonicalFile: boolean,
): boolean {
  const fileMatch = /^@file:(\S+)\s/.exec(ann.body.trimStart());
  if (fileMatch) return filePath.endsWith(fileMatch[1]);
  // Loose heuristic: put annotation on the first file when ids are generic.
  return isCanonicalFile;
}

function FileSection({
  ref_,
  slug,
  endBase,
  endHead,
  annotations,
}: {
  ref_: { path: string; ranges: string[] };
  slug: string;
  endBase: string;
  endHead: string;
  annotations: Array<{ id: string; type: string; body: string }>;
}) {
  return (
    <section
      id={`file-${cssId(ref_.path)}`}
      className="rounded-md border border-bg-line overflow-hidden"
    >
      <header className="h-9 px-3 flex items-center gap-3 bg-bg-deep border-b border-bg-line">
        <span className="font-mono text-[13px] text-fg-bright truncate">{ref_.path}</span>
        {ref_.ranges.length > 0 && (
          <span className="ml-auto font-mono text-[11px] text-fg-faint tabular-nums">
            {ref_.ranges.length === 1 ? `L${ref_.ranges[0]}` : `${ref_.ranges.length} ranges`}
          </span>
        )}
      </header>
      {annotations.length > 0 && (
        <div className="px-3 py-2 space-y-1.5 bg-yellow/5 border-b border-yellow/20">
          {annotations.map((a) => (
            <AnchoredAnnotation key={a.id} annotation={a} />
          ))}
        </div>
      )}
      <InlineDiff slug={slug} base={endBase} head={endHead} path={ref_.path} />
    </section>
  );
}

function AnchoredAnnotation({
  annotation,
}: {
  annotation: { id: string; type: string; body: string };
}) {
  const m = /^(?:@file:\S+\s+)?@L(\d+)(?:-(\d+))?:\s*([\s\S]*)$/.exec(annotation.body.trimStart());
  const startLine = m ? m[1] : null;
  const endLine = m ? m[2] : null;
  const body = m ? m[3] : annotation.body;
  const color =
    annotation.type === "judgment_call"
      ? PALETTE.accent.judgment
      : annotation.type === "flag"
        ? PALETTE.verdict.rejected
        : PALETTE.accent.neutral;
  return (
    <div
      className="flex gap-2.5 text-[12.5px] font-mono"
      style={{ color }}
    >
      <span className="shrink-0 text-[11px] tabular-nums" style={{ color }}>
        L{startLine}
        {endLine ? `-${endLine}` : ""}
      </span>
      <span className="text-fg-base whitespace-pre-wrap">{body}</span>
      <span className="ml-auto shrink-0 text-[10.5px] text-fg-faint uppercase tracking-wider">
        {annotation.id}
      </span>
    </div>
  );
}

function AnnotationSummary({
  judgmentCalls,
  flags,
  notes,
}: {
  judgmentCalls: Array<{ id: string; body: string }>;
  flags: Array<{ id: string; body: string }>;
  notes: Array<{ id: string; body: string }>;
}) {
  if (judgmentCalls.length + flags.length + notes.length === 0) return null;
  return (
    <div className="space-y-3">
      {judgmentCalls.length > 0 && (
        <AnnotationList title="Judgement calls" color={PALETTE.accent.judgment} items={judgmentCalls} />
      )}
      {flags.length > 0 && (
        <AnnotationList title="Flags" color={PALETTE.verdict.rejected} items={flags} />
      )}
      {notes.length > 0 && (
        <AnnotationList title="Notes" color={PALETTE.accent.neutral} items={notes} />
      )}
    </div>
  );
}

function AnnotationList({
  title,
  color,
  items,
}: {
  title: string;
  color: string;
  items: Array<{ id: string; body: string }>;
}) {
  return (
    <div>
      <div
        className="mono text-[11px] uppercase tracking-wider mb-1.5"
        style={{ color }}
      >
        {title} · {items.length}
      </div>
      <ul className="space-y-1.5">
        {items.map((a) => (
          <li
            key={a.id}
            className="rounded-md border-l-2 px-3 py-1.5 text-[12.5px] text-fg-base font-mono whitespace-pre-wrap leading-relaxed"
            style={{ borderColor: color, background: `${color}10` }}
          >
            <span
              className="mono text-[10.5px] mr-2 uppercase tracking-wider"
              style={{ color }}
            >
              {a.id}
            </span>
            {a.body}
          </li>
        ))}
      </ul>
    </div>
  );
}

function cssId(path: string): string {
  return path.replace(/[^a-z0-9]+/gi, "-");
}

function ClassificationBadge({ classification }: { classification: string }) {
  const c = classification.toLowerCase();
  const map: Record<string, { label: string; color: string }> = {
    explicit: { label: "Explicit", color: PALETTE.classification.explicit },
    inferred: { label: "Inferred", color: PALETTE.classification.inferred },
    speculative: { label: "Speculative", color: PALETTE.classification.speculative },
    implicit: { label: "No manifest", color: PALETTE.classification.implicit },
  };
  const spec = map[c] ?? { label: classification, color: PALETTE.accent.bright };
  return (
    <span
      className="px-2 py-[2px] text-[11px] font-medium rounded-md border"
      style={{
        color: spec.color,
        background: `${spec.color}14`,
        borderColor: `${spec.color}55`,
      }}
    >
      {spec.label}
    </span>
  );
}

const AMBIGUITY_LABELS: Record<string, string> = {
  underspecified: "Underspec",
  conflicting_signals: "Conflict",
  assumption: "Assumption",
  scope_creep: "Scope creep",
  convention: "Convention",
};

function AmbiguityChip({ tag }: { tag: string }) {
  const label = AMBIGUITY_LABELS[tag] ?? tag;
  const hot = tag === "scope_creep" || tag === "conflicting_signals";
  const color = hot ? PALETTE.ambiguity.hot : PALETTE.ambiguity.cold;
  return (
    <span
      className="px-2 py-[2px] text-[10.5px] font-medium rounded-md border"
      style={{
        color,
        borderColor: hot ? `${color}55` : PALETTE.surface.border,
        background: hot ? `${color}14` : "transparent",
      }}
    >
      {label}
    </span>
  );
}

function RiskBar({
  classification,
  risky,
  inferred,
}: {
  classification: string;
  risky: boolean;
  inferred: boolean;
}) {
  const level = risky ? 3 : inferred ? 2 : 1;
  const color =
    level === 3
      ? PALETTE.verdict.rework
      : level === 2
        ? PALETTE.verdict.needsDiscussion
        : PALETTE.verdict.accepted;
  const name = classification.charAt(0).toUpperCase() + classification.slice(1);
  return (
    <div>
      <div className="text-[11px] font-medium" style={{ color }}>
        {name}
      </div>
      <div className="flex gap-1 mt-1.5 justify-center">
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className="inline-block h-[4px] w-5 rounded-full"
            style={{ background: i <= level ? color : PALETTE.surface.border }}
          />
        ))}
      </div>
      <div className="text-[10.5px] text-fg-faint mt-1.5">Risk</div>
    </div>
  );
}
