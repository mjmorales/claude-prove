import { useState } from "react";
import { cn } from "../../lib/cn";
import type { GroupVerdict, IntentGroupView } from "../../lib/api";
import { tokenOf } from "./verdictTokens";
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
}: {
  group: IntentGroupView;
  index: number;
  total: number;
  verdict: GroupVerdict;
  note: string | null;
  slug: string;
  diffOpen: boolean;
  stampKey: number;
}) {
  const [filePick, setFilePick] = useState<string | null>(group.files[0] ?? null);
  const t = tokenOf(verdict);
  const cls = group.classification.toLowerCase();
  const risky = SPECULATIVE.has(cls);
  const inferred = INFERRED.has(cls);
  const headCommit = group.commits[0];
  const diffHead = headCommit?.sha ?? null;

  const judgmentCalls = group.annotations.filter((a) => a.type === "judgment_call");
  const flags = group.annotations.filter((a) => a.type === "flag");
  const notes = group.annotations.filter(
    (a) => a.type !== "judgment_call" && a.type !== "flag",
  );

  const currentRanges =
    filePick != null
      ? group.fileRefs.find((r) => r.path === filePick)?.ranges ?? []
      : [];

  return (
    <article
      className={cn(
        "rack-in card-face relative border border-bg-line",
        t ? t.cardClass : null,
      )}
    >
      {/* Hazard rail for speculative / no-manifest groups */}
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-[6px] pointer-events-none",
          risky && "rail-hazard",
        )}
      />

      {/* Head strip */}
      <header className="h-11 pl-5 pr-4 flex items-center gap-4 border-b border-bg-line bg-bg-deep/60 rounded-t-md">
        <span className="font-mono text-[11.5px] tabular-nums text-fg-faint">
          {index + 1} / {total}
        </span>
        <span className="font-mono text-[11px] text-fg-dim truncate max-w-[320px]">
          {group.id}
        </span>
        <ClassificationBadge classification={group.classification} />
        {group.ambiguityTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {group.ambiguityTags.map((tag) => (
              <AmbiguityChip key={tag} tag={tag} />
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-4 text-[11px] font-mono text-fg-dim">
          <span className="flex items-center gap-3">
            <span title="Commits">{group.commits.length}c</span>
            <span title="Files">{group.files.length}f</span>
            <span
              style={{ color: judgmentCalls.length > 0 ? "#f1fa8c" : undefined }}
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
          {t && (
            <span className="font-semibold" style={{ color: t.color }}>
              {t.label}
            </span>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="p-6 grid grid-cols-[1fr_auto] gap-6">
        <div className="min-w-0">
          <h2 className="font-mono text-[20px] leading-snug text-fg-bright break-words">
            {group.title}
          </h2>

          {note && (
            <div
              className="mt-3 px-3 py-2 text-[12.5px] font-mono border-l-2 rounded-r-md bg-bg-deep/60"
              style={{ borderColor: t?.color ?? "#44475a", color: t?.color ?? "#a9b0c4" }}
            >
              <span
                className="label mr-2 normal-case tracking-normal text-[11px] font-sans"
                style={{ color: t?.color ?? "#a9b0c4" }}
              >
                Reviewer note
              </span>
              {note}
            </div>
          )}

          {/* Task grounding — what the user actually asked for. */}
          {group.taskGrounding && (
            <blockquote className="mt-4 pl-3 border-l-2 border-data text-[13px] text-fg-base leading-relaxed whitespace-pre-wrap">
              <div className="mono text-[11px] uppercase tracking-wider text-data mb-1">
                Task grounding
              </div>
              {group.taskGrounding}
            </blockquote>
          )}

          {/* Judgment calls — the reviewer's primary signal. */}
          {judgmentCalls.length > 0 && (
            <section className="mt-5">
              <SectionLabel tone="yellow">
                Judgement calls · {judgmentCalls.length}
              </SectionLabel>
              <ul className="space-y-2">
                {judgmentCalls.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-md border-l-2 border-yellow bg-yellow/5 px-3 py-2 text-[12.5px] text-fg-bright font-mono whitespace-pre-wrap leading-relaxed"
                  >
                    <span className="mono text-[10px] text-yellow mr-2 uppercase tracking-wider">
                      {a.id}
                    </span>
                    {a.body}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {flags.length > 0 && (
            <section className="mt-5">
              <SectionLabel tone="anom">Flags · {flags.length}</SectionLabel>
              <ul className="space-y-2">
                {flags.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-md border-l-2 border-anom bg-anom/10 px-3 py-2 text-[12.5px] text-fg-bright font-mono whitespace-pre-wrap leading-relaxed"
                  >
                    <span className="mono text-[10px] text-anom mr-2 uppercase tracking-wider">
                      {a.id}
                    </span>
                    {a.body}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {notes.length > 0 && (
            <section className="mt-5">
              <SectionLabel tone="dim">Notes · {notes.length}</SectionLabel>
              <ul className="space-y-2">
                {notes.map((a) => (
                  <li
                    key={a.id}
                    className="border-l border-bg-line px-3 py-1.5 text-[12px] text-fg-base font-mono whitespace-pre-wrap leading-relaxed"
                  >
                    <span className="mono text-[10px] text-fg-faint mr-2 uppercase tracking-wider">
                      {a.id}
                    </span>
                    {a.body}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {judgmentCalls.length === 0 && flags.length === 0 && notes.length === 0 && (
            <div className="mt-5 text-[12px] text-fg-dim italic">
              No author annotations — the change claims to be self-evident.
            </div>
          )}

          {/* Commits */}
          <section className="mt-6">
            <SectionLabel>
              Commits · <span className="tabular-nums">{group.commits.length}</span>
            </SectionLabel>
            <ul className="font-mono text-[12px] space-y-1.5">
              {group.commits.map((c) => (
                <li key={c.sha} className="flex gap-3">
                  <span className="text-data tabular-nums shrink-0">{c.shortSha}</span>
                  <span className="truncate text-fg-base">{c.subject}</span>
                  <span className="ml-auto text-[10.5px] text-fg-faint shrink-0">{c.branch}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* File refs with ranges */}
          <section className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <SectionLabel asSpan>
                Files · <span className="tabular-nums">{group.fileRefs.length}</span>
                <span className="text-fg-faint normal-case tracking-normal ml-2">
                  pick to preview
                </span>
              </SectionLabel>
              <span className="flex items-center gap-1.5 text-[11px] text-fg-faint">
                <span className="kbd">v</span> {diffOpen ? "hide diff" : "show diff"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {group.fileRefs.map((ref) => {
                const active = filePick === ref.path;
                return (
                  <button
                    key={ref.path}
                    onClick={() => setFilePick(ref.path)}
                    className={cn(
                      "px-2.5 py-1 rounded-md font-mono text-[11.5px] border transition-colors flex items-center gap-1.5",
                      active
                        ? "border-phos bg-phos/15 text-phos"
                        : "border-bg-line text-fg-base hover:bg-bg-raised hover:border-fg-faint",
                    )}
                  >
                    <span>{shortenPath(ref.path)}</span>
                    {ref.ranges.length > 0 && (
                      <span
                        className="text-[10.5px] text-fg-faint tabular-nums"
                        title={`Lines: ${ref.ranges.join(", ")}`}
                      >
                        {ref.ranges.length === 1 ? `L${ref.ranges[0]}` : `${ref.ranges.length} ranges`}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {currentRanges.length > 0 && (
              <div className="mt-2 text-[11px] font-mono text-fg-dim flex flex-wrap items-center gap-1.5">
                <span className="text-fg-faint">Ranges:</span>
                {currentRanges.map((r) => (
                  <span
                    key={r}
                    className="inline-block px-1.5 py-[1px] rounded border border-bg-line bg-bg-deep text-phos tabular-nums"
                  >
                    L{r}
                  </span>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Verdict + risk lane */}
        <div className="w-[172px] flex flex-col items-center justify-start pt-1 gap-3">
          {t ? (
            <VerdictStamp verdict={verdict} size="lg" animateKey={stampKey} />
          ) : (
            <div className="text-center">
              <div
                className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-dashed border-fg-faint text-fg-faint text-[22px]"
                aria-hidden
              >
                ◌
              </div>
              <div className="text-[11.5px] text-fg-dim mt-2">Awaiting verdict</div>
            </div>
          )}
          <div className="w-full text-center mt-2">
            <RiskBar classification={cls} risky={risky} inferred={inferred} />
          </div>
        </div>
      </div>

      {/* Inline diff */}
      {diffOpen && filePick && diffHead && (
        <div className="border-t border-bg-line">
          <div className="h-8 px-4 flex items-center gap-3 bg-bg-deep border-b border-bg-line">
            <span className="mono text-[11px] text-data uppercase tracking-wider">Diff</span>
            <span className="font-mono text-[11.5px] text-fg-base truncate">{filePick}</span>
            <span className="ml-auto font-mono text-[10.5px] text-fg-faint tabular-nums">
              {headCommit.shortSha}
            </span>
          </div>
          <InlineDiff
            slug={slug}
            base={`${diffHead}^`}
            head={diffHead}
            path={filePick}
            height={320}
          />
        </div>
      )}
    </article>
  );
}

function shortenPath(p: string): string {
  if (p.length <= 48) return p;
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

function SectionLabel({
  children,
  tone = "base",
  asSpan,
}: {
  children: React.ReactNode;
  tone?: "base" | "yellow" | "anom" | "dim";
  asSpan?: boolean;
}) {
  const color =
    tone === "yellow"
      ? "text-yellow"
      : tone === "anom"
        ? "text-anom"
        : tone === "dim"
          ? "text-fg-faint"
          : "text-fg-dim";
  const Cmp = asSpan ? "span" : "div";
  return (
    <Cmp
      className={`mono text-[11px] uppercase tracking-wider ${color} ${asSpan ? "" : "mb-2 block"}`}
    >
      {children}
    </Cmp>
  );
}

function ClassificationBadge({ classification }: { classification: string }) {
  const c = classification.toLowerCase();
  const map: Record<string, { label: string; color: string }> = {
    explicit: { label: "Explicit", color: "#bd93f9" },
    inferred: { label: "Inferred", color: "#8be9fd" },
    speculative: { label: "Speculative", color: "#ffb86c" },
    implicit: { label: "No manifest", color: "#ff5555" },
  };
  const spec = map[c] ?? { label: classification, color: "#e2e2e6" };
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
  const color = hot ? "#ffb86c" : "#a9b0c4";
  return (
    <span
      className="px-2 py-[2px] text-[10.5px] font-medium rounded-md border"
      style={{
        color,
        borderColor: hot ? `${color}55` : "#44475a",
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
  const color = level === 3 ? "#ffb86c" : level === 2 ? "#8be9fd" : "#50fa7b";
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
            style={{ background: i <= level ? color : "#44475a" }}
          />
        ))}
      </div>
      <div className="text-[10.5px] text-fg-faint mt-1.5">Risk</div>
    </div>
  );
}
