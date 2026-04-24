// JSON readers for prove run artifacts.
// Field names mirror packages/cli/src/topics/run-state/schemas.ts in the claude-prove plugin.

import fs from "node:fs/promises";
import path from "node:path";

export type ValidatorStatus = "pending" | "pass" | "fail" | "skipped";
export type ValidatorPhase = "build" | "lint" | "test" | "custom" | "llm";
export type ValidatorSummary = Record<ValidatorPhase, ValidatorStatus>;

export type StepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "skipped"
  | "halted";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "halted";
export type RunStatus = "pending" | "running" | "completed" | "failed" | "halted";
export type ReviewVerdict = "pending" | "approved" | "rejected" | "n/a";

export type PlanStep = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: StepStatus;
  startedAt: string;
  endedAt: string;
  commitSha: string;
  validatorSummary: ValidatorSummary;
  haltReason: string;
};

export type PlanTaskView = {
  id: string;
  title: string;
  wave: number;
  deps: string[];
  description: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  startedAt: string;
  endedAt: string;
  review: {
    verdict: ReviewVerdict;
    notes: string;
    reviewer: string;
    reviewedAt: string;
  };
  steps: PlanStep[];
  worktree: { path: string; branch: string } | null;
};

export type RunProgress = {
  runStatus: RunStatus;
  currentTask: string;
  currentStep: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string;
};

export type StepReport = {
  stepId: string;
  taskId: string;
  status: StepStatus;
  startedAt: string;
  endedAt: string;
  commitSha: string;
  diffStats: { filesChanged: number; insertions: number; deletions: number };
  validators: Array<{
    name: string;
    phase: ValidatorPhase;
    status: ValidatorStatus;
    durationS: number;
    output: string;
  }>;
  artifacts: string[];
  notes: string;
};

export type PlanJson = {
  schema_version?: string;
  kind?: string;
  mode?: "simple" | "full";
  tasks?: Array<{
    id: string;
    title: string;
    wave?: number;
    deps?: string[];
    description?: string;
    acceptance_criteria?: string[];
    worktree?: { path?: string; branch?: string };
    steps?: Array<{
      id: string;
      title: string;
      description?: string;
      acceptance_criteria?: string[];
    }>;
  }>;
};

export type StateJson = {
  schema_version?: string;
  run_status?: RunStatus;
  slug?: string;
  branch?: string;
  current_task?: string;
  current_step?: string;
  started_at?: string;
  updated_at?: string;
  ended_at?: string;
  tasks?: Array<{
    id: string;
    status?: TaskStatus;
    started_at?: string;
    ended_at?: string;
    review?: {
      verdict?: ReviewVerdict;
      notes?: string;
      reviewer?: string;
      reviewed_at?: string;
    };
    steps?: Array<{
      id: string;
      status?: StepStatus;
      started_at?: string;
      ended_at?: string;
      commit_sha?: string;
      validator_summary?: Partial<ValidatorSummary>;
      halt_reason?: string;
    }>;
  }>;
};

export type PrdJson = {
  schema_version?: string;
  kind?: string;
  title?: string;
  context?: string;
  goals?: string[];
  scope?: { in?: string[]; out?: string[] };
  acceptance_criteria?: string[];
  test_strategy?: string;
  body_markdown?: string;
};

const EMPTY_VALIDATOR_SUMMARY: ValidatorSummary = {
  build: "pending",
  lint: "pending",
  test: "pending",
  custom: "pending",
  llm: "pending",
};

export async function readJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

// Defense-in-depth: isSafeSegment is the primary guard, but we also resolve
// the final path and require it to live inside `<repoRoot>/.prove/runs/` so a
// bypass in segment validation cannot escape the runs directory.
export function runDir(repoRoot: string, branch: string, slug: string): string {
  const runsRoot = path.resolve(repoRoot, ".prove/runs");
  const resolved = path.resolve(runsRoot, branch, slug);
  const runsRootPrefix = runsRoot + path.sep;
  if (!resolved.startsWith(runsRootPrefix)) {
    throw new Error(`runDir: refusing path outside ${runsRoot} (got ${resolved})`);
  }
  return resolved;
}

/** Merge plan.json + state.json into the view the UI consumes. */
export function buildTaskViews(plan: PlanJson | null, state: StateJson | null): PlanTaskView[] {
  if (!plan?.tasks) return [];
  const stateTasks = new Map<string, NonNullable<StateJson["tasks"]>[number]>();
  for (const t of state?.tasks ?? []) stateTasks.set(t.id, t);

  return plan.tasks.map((pt) => {
    const st = stateTasks.get(pt.id);
    const stateStepsById = new Map<string, NonNullable<NonNullable<typeof st>["steps"]>[number]>();
    for (const s of st?.steps ?? []) stateStepsById.set(s.id, s);

    const steps: PlanStep[] = (pt.steps ?? []).map((ps) => {
      const ss = stateStepsById.get(ps.id);
      return {
        id: ps.id,
        title: ps.title,
        description: ps.description ?? "",
        acceptanceCriteria: ps.acceptance_criteria ?? [],
        status: ss?.status ?? "pending",
        startedAt: ss?.started_at ?? "",
        endedAt: ss?.ended_at ?? "",
        commitSha: ss?.commit_sha ?? "",
        validatorSummary: { ...EMPTY_VALIDATOR_SUMMARY, ...(ss?.validator_summary ?? {}) },
        haltReason: ss?.halt_reason ?? "",
      };
    });

    return {
      id: pt.id,
      title: pt.title,
      wave: pt.wave ?? 1,
      deps: pt.deps ?? [],
      description: pt.description ?? "",
      acceptanceCriteria: pt.acceptance_criteria ?? [],
      status: st?.status ?? "pending",
      startedAt: st?.started_at ?? "",
      endedAt: st?.ended_at ?? "",
      review: {
        verdict: st?.review?.verdict ?? "pending",
        notes: st?.review?.notes ?? "",
        reviewer: st?.review?.reviewer ?? "",
        reviewedAt: st?.review?.reviewed_at ?? "",
      },
      steps,
      worktree:
        pt.worktree && (pt.worktree.path || pt.worktree.branch)
          ? { path: pt.worktree.path ?? "", branch: pt.worktree.branch ?? "" }
          : null,
    };
  });
}

export function extractRunProgress(state: StateJson | null): RunProgress {
  return {
    runStatus: state?.run_status ?? "pending",
    currentTask: state?.current_task ?? "",
    currentStep: state?.current_step ?? "",
    startedAt: state?.started_at ?? "",
    updatedAt: state?.updated_at ?? "",
    endedAt: state?.ended_at ?? "",
  };
}

export async function readStepReport(
  repoRoot: string,
  branch: string,
  slug: string,
  stepId: string,
): Promise<StepReport | null> {
  const p = path.join(runDir(repoRoot, branch, slug), "reports", `${stepId}.json`);
  type ReportJson = {
    step_id?: string;
    task_id?: string;
    status?: StepStatus;
    started_at?: string;
    ended_at?: string;
    commit_sha?: string;
    diff_stats?: { files_changed?: number; insertions?: number; deletions?: number };
    validators?: Array<{
      name?: string;
      phase?: ValidatorPhase;
      status?: ValidatorStatus;
      duration_s?: number;
      output?: string;
    }>;
    artifacts?: string[];
    notes?: string;
  };
  const j = await readJson<ReportJson>(p);
  if (!j) return null;
  return {
    stepId: j.step_id ?? stepId,
    taskId: j.task_id ?? "",
    status: j.status ?? "pending",
    startedAt: j.started_at ?? "",
    endedAt: j.ended_at ?? "",
    commitSha: j.commit_sha ?? "",
    diffStats: {
      filesChanged: j.diff_stats?.files_changed ?? 0,
      insertions: j.diff_stats?.insertions ?? 0,
      deletions: j.diff_stats?.deletions ?? 0,
    },
    validators: (j.validators ?? []).map((v) => ({
      name: v.name ?? "",
      phase: v.phase ?? "custom",
      status: v.status ?? "pending",
      durationS: v.duration_s ?? 0,
      output: v.output ?? "",
    })),
    artifacts: j.artifacts ?? [],
    notes: j.notes ?? "",
  };
}

// --- Composite slug helpers -------------------------------------------------
// A run is addressed as `<branch>/<slug>` in URLs. Clients URL-encode the
// slash; fastify decodes it back to one string, and we split on the first `/`.

export type RunKey = { branch: string; slug: string; composite: string };

export function parseRunKey(composite: string): RunKey | null {
  const idx = composite.indexOf("/");
  if (idx <= 0 || idx === composite.length - 1) return null;
  const branch = composite.slice(0, idx);
  const slug = composite.slice(idx + 1);
  if (slug.includes("/") || !isSafeSegment(branch) || !isSafeSegment(slug)) return null;
  return { branch, slug, composite: `${branch}/${slug}` };
}

// Rejects path-traversal vectors even though the charset regex would match.
// `..` and `.` pass `^[\w.\-]+$` but resolve to parent/current-dir references
// once joined into a filesystem path; `/` would split the segment entirely.
export function isSafeSegment(s: string): boolean {
  if (s === ".." || s === ".") return false;
  if (s.includes("/") || s.includes("\\")) return false;
  return /^[\w.\-]+$/.test(s);
}
