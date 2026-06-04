/**
 * Pure renderers turning a run's prove JSON artifacts into display markdown.
 * Kept free of React so they unit-test in isolation and the panel stays a thin
 * fetch+render shell. The PRD body is markdown already; plan/state collapse into
 * a readable structured summary rather than dumping raw JSON.
 */

import type { DocView } from "./store";

export type DocFile = "plan.json" | "prd.json" | "state.json";

export const DOCS: Array<{ id: DocView; label: string; file: DocFile }> = [
  { id: "PRD", label: "PRD", file: "prd.json" },
  { id: "PLAN", label: "PLAN", file: "plan.json" },
  { id: "STATE", label: "STATE", file: "state.json" },
];

/** Render a prove JSON artifact as markdown, falling back to a fenced block when
 * the payload doesn't parse. */
export function renderDoc(raw: string, view: DocView): string {
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
  if (p.goals?.length) lines.push("## Goals", "", ...p.goals.map((g) => `- ${g}`), "");
  if (p.scope?.in?.length) lines.push("## In Scope", "", ...p.scope.in.map((s) => `- ${s}`), "");
  if (p.scope?.out?.length)
    lines.push("## Out of Scope", "", ...p.scope.out.map((s) => `- ${s}`), "");
  if (p.acceptance_criteria?.length)
    lines.push("## Acceptance Criteria", "", ...p.acceptance_criteria.map((s) => `- ${s}`), "");
  if (p.test_strategy) lines.push("## Test Strategy", "", p.test_strategy, "");
  if (p.body_markdown) lines.push(p.body_markdown);
  return lines.join("\n");
}

/** A plan-task/step criterion: a v3 structured dict, or a legacy v2 bare string. */
type PlanCrit = string | { text: string; verifies_by?: string; check?: string };

type PlanShape = {
  mode?: string;
  tasks?: Array<{
    id: string;
    title: string;
    wave?: number;
    deps?: string[];
    description?: string;
    acceptance_criteria?: PlanCrit[];
    steps?: Array<{
      id: string;
      title: string;
      description?: string;
      acceptance_criteria?: PlanCrit[];
    }>;
  }>;
};

/** Display text for a criterion — v3 `text` (+ kind), or the legacy string verbatim. */
function critText(c: PlanCrit): string {
  if (typeof c === "string") return c;
  return c.verifies_by ? `${c.text} (${c.verifies_by}${c.check ? `: ${c.check}` : ""})` : c.text;
}

function renderPlan(p: PlanShape): string {
  const lines: string[] = [`# Plan (${p.mode ?? "simple"} mode)`, ""];
  for (const task of p.tasks ?? []) {
    lines.push(`## Task ${task.id}: ${task.title}`, "");
    lines.push(`**Wave:** ${task.wave ?? 1}  `);
    lines.push(`**Deps:** ${task.deps?.length ? task.deps.join(", ") : "none"}`, "");
    if (task.description) lines.push(task.description, "");
    if (task.acceptance_criteria?.length) {
      lines.push("**Acceptance:**", "", ...task.acceptance_criteria.map((c) => `- ${critText(c)}`), "");
    }
    for (const step of task.steps ?? []) {
      lines.push(`### Step ${step.id}: ${step.title}`, "");
      if (step.description) lines.push(step.description, "");
      if (step.acceptance_criteria?.length) {
        lines.push(...step.acceptance_criteria.map((c) => `- ${critText(c)}`), "");
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
      lines.push(
        `Review: ${task.review.verdict}${task.review.notes ? ` — ${task.review.notes}` : ""}`,
        "",
      );
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
