import { useEffect } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSelection, type DocView } from "../lib/store";
import { cn } from "../lib/cn";
import { Markdown } from "./Markdown";
import { PanelLoading } from "./PanelLoading";

type DocFile = "plan.json" | "prd.json" | "state.json";

const DOCS: Array<{ id: DocView; label: string; file: DocFile }> = [
  { id: "PRD", label: "PRD", file: "prd.json" },
  { id: "PLAN", label: "PLAN", file: "plan.json" },
  { id: "STATE", label: "STATE", file: "state.json" },
];

export function DocsPanel() {
  const slug = useSelection((s) => s.slug);
  const view = useSelection((s) => s.docView);
  const setView = useSelection((s) => s.setDocView);

  const probes = useQueries({
    queries: DOCS.map((d) => ({
      queryKey: ["doc", slug, d.file],
      queryFn: () => api.doc(slug!, d.file),
      enabled: !!slug,
      retry: false,
      staleTime: 10_000,
    })),
  });
  const availability = DOCS.map((d, i) => ({
    id: d.id,
    available: probes[i].status === "success",
    pending: probes[i].status === "pending",
  }));

  useEffect(() => {
    if (!slug) return;
    const currentIdx = DOCS.findIndex((d) => d.id === view);
    if (availability[currentIdx]?.available) return;
    if (availability.some((a) => a.pending)) return;
    const firstAvail = availability.find((a) => a.available);
    if (firstAvail) setView(firstAvail.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, view, availability.map((a) => a.available + "|" + a.pending).join(",")]);

  const doc = DOCS.find((d) => d.id === view)!;
  const currentProbe = probes[DOCS.findIndex((d) => d.id === view)];
  const raw = (currentProbe?.data as { content?: string } | undefined)?.content ?? "";
  const rendered = raw ? renderJson(raw, doc.id) : "";

  useQuery({
    queryKey: ["doc", slug, doc.file],
    queryFn: () => api.doc(slug!, doc.file),
    enabled: !!slug,
    retry: false,
  });

  if (!slug) return <Empty text="Select a run" />;

  const anyAvailable = availability.some((a) => a.available);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-stretch border-b border-bg-line bg-bg-deep">
        {DOCS.map((d, i) => {
          const avail = availability[i];
          const active = view === d.id;
          return (
            <button
              key={d.id}
              onClick={() => setView(d.id)}
              className={cn(
                "px-3 h-8 text-[10.5px] font-mono tracking-wide2 font-semibold transition-colors border-r border-bg-line flex items-center gap-1.5",
                active
                  ? "text-phos bg-bg-panel"
                  : avail.available
                    ? "text-fg-dim hover:text-fg-base hover:bg-bg-panel/60"
                    : "text-fg-faint",
              )}
              title={avail.available ? d.file : `${d.file} — not available`}
            >
              <span
                className={cn(
                  "w-[5px] h-[5px] rounded-full",
                  avail.available ? "bg-phos shadow-phos" : "bg-fg-faint",
                )}
              />
              {d.label}
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
        {!anyAvailable && probes.every((p) => p.status !== "pending") ? (
          <div className="flex h-full flex-col items-center justify-center text-center gap-3">
            <div className="label text-amber">NO DOCS YET</div>
            <div className="text-[12px] font-mono text-fg-dim max-w-sm">
              Run in-flight. prd.json / plan.json / state.json will populate as the orchestrator
              writes them to{" "}
              <code className="text-phos bg-bg-panel px-1 border border-bg-line">
                .prove/runs/{slug}/
              </code>
              .
            </div>
          </div>
        ) : currentProbe?.status === "pending" ? (
          <PanelLoading label={`LOADING ${doc.file}`} />
        ) : currentProbe?.status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center text-center gap-2">
            <div className="label text-amber">{doc.file} — NOT AVAILABLE</div>
            <div className="text-[11px] font-mono text-fg-dim">
              switch to a doc with a pulsing indicator
            </div>
          </div>
        ) : (
          <Markdown source={rendered} />
        )}
      </div>
    </div>
  );
}

/** Render a prove JSON artifact as markdown. The PRD body is markdown already;
 *  for plan/state we emit a readable structured summary instead of raw JSON. */
function renderJson(raw: string, view: DocView): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "```\n" + raw + "\n```";
  }
  if (view === "PRD") return renderPrd(parsed as PrdShape);
  if (view === "PLAN") return renderPlan(parsed as PlanShape);
  return renderState(parsed as StateShape);
}

type PrdShape = {
  title?: string;
  context?: string;
  goals?: string[];
  scope?: { in?: string[]; out?: string[] };
  acceptance_criteria?: string[];
  test_strategy?: string;
  body_markdown?: string;
};

function renderPrd(p: PrdShape): string {
  const lines: string[] = [];
  if (p.title) lines.push(`# ${p.title}`, "");
  if (p.context) lines.push("## Context", "", p.context, "");
  if (p.goals?.length) {
    lines.push("## Goals", "", ...p.goals.map((g) => `- ${g}`), "");
  }
  if (p.scope?.in?.length) lines.push("## In Scope", "", ...p.scope.in.map((s) => `- ${s}`), "");
  if (p.scope?.out?.length)
    lines.push("## Out of Scope", "", ...p.scope.out.map((s) => `- ${s}`), "");
  if (p.acceptance_criteria?.length)
    lines.push("## Acceptance Criteria", "", ...p.acceptance_criteria.map((s) => `- ${s}`), "");
  if (p.test_strategy) lines.push("## Test Strategy", "", p.test_strategy, "");
  if (p.body_markdown) lines.push(p.body_markdown);
  return lines.join("\n");
}

type PlanShape = {
  mode?: string;
  tasks?: Array<{
    id: string;
    title: string;
    wave?: number;
    deps?: string[];
    description?: string;
    acceptance_criteria?: string[];
    steps?: Array<{
      id: string;
      title: string;
      description?: string;
      acceptance_criteria?: string[];
    }>;
  }>;
};

function renderPlan(p: PlanShape): string {
  const lines: string[] = [`# Plan (${p.mode ?? "simple"} mode)`, ""];
  for (const task of p.tasks ?? []) {
    lines.push(`## Task ${task.id}: ${task.title}`, "");
    lines.push(`**Wave:** ${task.wave ?? 1}  `);
    lines.push(`**Deps:** ${task.deps?.length ? task.deps.join(", ") : "none"}`, "");
    if (task.description) lines.push(task.description, "");
    if (task.acceptance_criteria?.length) {
      lines.push("**Acceptance:**", "", ...task.acceptance_criteria.map((c) => `- ${c}`), "");
    }
    for (const step of task.steps ?? []) {
      lines.push(`### Step ${step.id}: ${step.title}`, "");
      if (step.description) lines.push(step.description, "");
      if (step.acceptance_criteria?.length) {
        lines.push(...step.acceptance_criteria.map((c) => `- ${c}`), "");
      }
    }
  }
  return lines.join("\n");
}

type StateShape = {
  run_status?: string;
  slug?: string;
  branch?: string;
  current_task?: string;
  current_step?: string;
  started_at?: string;
  updated_at?: string;
  ended_at?: string;
  tasks?: Array<{
    id: string;
    status?: string;
    review?: { verdict?: string; notes?: string };
    steps?: Array<{
      id: string;
      status?: string;
      commit_sha?: string;
      validator_summary?: Record<string, string>;
      halt_reason?: string;
    }>;
  }>;
};

function renderState(s: StateShape): string {
  const lines: string[] = [
    `# Run ${s.branch ?? ""}/${s.slug ?? ""}`,
    "",
    `**Status:** ${s.run_status ?? "pending"}  `,
    `**Current:** ${s.current_task || "—"} / ${s.current_step || "—"}  `,
    `**Started:** ${s.started_at || "—"}  `,
    `**Updated:** ${s.updated_at || "—"}  `,
    `**Ended:** ${s.ended_at || "—"}`,
    "",
  ];
  for (const task of s.tasks ?? []) {
    lines.push(`## Task ${task.id} — ${task.status ?? "pending"}`, "");
    if (task.review?.verdict && task.review.verdict !== "pending") {
      lines.push(`Review: ${task.review.verdict}${task.review.notes ? ` — ${task.review.notes}` : ""}`, "");
    }
    for (const step of task.steps ?? []) {
      const validators = Object.entries(step.validator_summary ?? {})
        .filter(([, v]) => v !== "pending")
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      const extra = [
        step.commit_sha ? `commit ${step.commit_sha.slice(0, 9)}` : "",
        validators,
        step.halt_reason ? `halt: ${step.halt_reason}` : "",
      ]
        .filter(Boolean)
        .join(" — ");
      lines.push(`- **${step.id}** ${step.status ?? "pending"}${extra ? ` — ${extra}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-fg-dim text-[13px]">{text}</div>;
}
