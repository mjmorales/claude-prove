// Client shapes mirror the server JSON-backed types. Run-scoped routes use a
// composite `<branch>/<slug>` slug — the client URL-encodes it.

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

export type GroupVerdict = "pending" | "approved" | "rejected" | "discuss" | "rework";

export type AnnotationType = "judgment_call" | "note" | "flag";
export type IntentAnnotation = {
  id: string;
  type: AnnotationType | string;
  body: string;
};
export type IntentFileRef = { path: string; ranges: string[] };
export type IntentCommitRef = {
  sha: string;
  shortSha: string;
  branch: string;
  subject: string;
  timestamp: string;
};
export type IntentGroupView = {
  id: string;
  title: string;
  classification: string;
  ambiguityTags: string[];
  taskGrounding: string;
  files: string[];
  fileRefs: IntentFileRef[];
  annotations: IntentAnnotation[];
  commits: IntentCommitRef[];
};
export type NegativeSpaceEntry = { path: string; reason: string; note: string };
export type OpenQuestion = { id: string; body: string };
export type IntentsResponse = {
  slug: string;
  branches: string[];
  groups: IntentGroupView[];
  negativeSpace: NegativeSpaceEntry[];
  openQuestions: OpenQuestion[];
  uncoveredFiles: string[];
  orphanCommits: IntentCommitRef[];
  /**
   * End-state diff range. Review diffs should be computed as
   * `git diff <endBase>..<endHead> -- <file>` to avoid surfacing code
   * that's been superseded by later commits in the same run.
   * Null when the orchestrator branch is gone (cleaned-up run).
   */
  endBase: string | null;
  endHead: string | null;
};

export type GroupVerdictRecord = {
  slug: string;
  groupId: string;
  verdict: GroupVerdict;
  note: string | null;
  fixPrompt: string | null;
  updatedAt: string;
};

export type RunProgress = {
  runStatus: RunStatus;
  currentTask: string;
  currentStep: string;
  startedAt: string;
  updatedAt: string;
  endedAt: string;
};

export type RunSummary = {
  branch: string;
  slug: string;
  composite: string;
  orchestratorBranch: string;
  baseline: string | null;
  worktree: string | null;
  hasPlan: boolean;
  hasPrd: boolean;
  hasState: boolean;
  mode: "simple" | "full" | null;
  title: string | null;
  progress: RunProgress;
  lastActivity: string | null;
};

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

export type BranchRef = {
  name: string;
  sha: string;
  isCurrent: boolean;
  isWorktree: boolean;
  worktreePath: string | null;
  upstream: string | null;
};

export type FileChange = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  binary: boolean;
};

export type Commit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  timestamp: string;
  parents: string[];
};

export type DecisionRef = {
  id: string;
  title: string;
  path: string;
  date: string | null;
};

export type IntentManifest = {
  commitSha: string;
  branch: string;
  timestamp: string;
  data: unknown;
  createdAt: string;
};

export type StatusSummary = {
  branch: string | null;
  ahead: number;
  behind: number;
  files: Array<{ path: string; index: string; workingDir: string }>;
  staged: string[];
  modified: string[];
  untracked: string[];
};

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  return r.json() as Promise<T>;
}

function enc(compositeSlug: string): string {
  return encodeURIComponent(compositeSlug);
}

export const api = {
  runs: () => getJSON<{ runs: RunSummary[] }>("/api/runs"),
  run: (slug: string) => getJSON<RunSummary>(`/api/runs/${enc(slug)}`),
  runBranches: (slug: string) =>
    getJSON<{
      orchestratorName: string;
      hasOrchestrator: boolean;
      branches: BranchRef[];
      orphanAgents: BranchRef[];
    }>(`/api/runs/${enc(slug)}/branches`),
  runStatus: (slug: string) =>
    getJSON<{ slug: string; worktree: string | null; status: StatusSummary | null }>(
      `/api/runs/${enc(slug)}/status`,
    ),
  diff: (slug: string, base: string, head: string) =>
    getJSON<{ base: string; head: string; files: FileChange[] }>(
      `/api/diff?slug=${enc(slug)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
    ),
  diffFile: (slug: string, base: string, head: string, path: string) =>
    getJSON<{ base: string; head: string; path: string; patch: string }>(
      `/api/diff/file?slug=${enc(slug)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}&path=${encodeURIComponent(path)}`,
    ),
  pending: (slug: string, path?: string, branch?: string) => {
    const q = new URLSearchParams({ slug });
    if (path) q.set("path", path);
    if (branch) q.set("branch", branch);
    return getJSON<{
      slug: string;
      worktree: string | null;
      branch?: string;
      path: string | null;
      patch: string;
    }>(`/api/diff/pending?${q.toString()}`);
  },
  doc: (slug: string, file: "plan.json" | "prd.json" | "state.json") =>
    getJSON<{ path: string; content: string }>(`/api/runs/${enc(slug)}/doc/${file}`),
  report: (slug: string, stepId: string) =>
    getJSON<{ path: string; content: string }>(`/api/runs/${enc(slug)}/reports/${stepId}`),
  tasks: (slug: string) =>
    getJSON<{ slug: string; mode: "simple" | "full"; tasks: PlanTaskView[] }>(
      `/api/runs/${enc(slug)}/tasks`,
    ),
  commits: (slug: string, base: string, head: string) =>
    getJSON<{ base: string; head: string; commits: Commit[] }>(
      `/api/commits?slug=${enc(slug)}&base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`,
    ),
  intent: (sha: string) =>
    getJSON<{ sha: string; manifest: IntentManifest | null }>(`/api/commits/${sha}/intent`),
  decisions: (slug: string) =>
    getJSON<{
      slug: string;
      referenced: DecisionRef[];
      all: DecisionRef[];
    }>(`/api/runs/${enc(slug)}/decisions`),
  decision: (id: string) =>
    getJSON<{ id: string; path: string; content: string }>(`/api/decisions/${id}`),
  manifest: (slug: string) =>
    getJSON<{
      slug: string;
      base: string;
      groups: Array<{
        id: string;
        kind: "orch-committed" | "orch-pending" | "task-committed" | "task-pending";
        label: string;
        branch: string;
        base: string | null;
        head: string | null;
        cwd: string | null;
        pending: boolean;
        insertions: number;
        deletions: number;
        files: FileChange[];
      }>;
    }>(`/api/runs/${enc(slug)}/manifest`),
  intents: (slug: string) =>
    getJSON<IntentsResponse>(`/api/runs/${enc(slug)}/intents`),
  stewardReports: () =>
    getJSON<{ reports: Array<{ name: string; path: string; mtime: string; sizeBytes: number }> }>(
      `/api/steward/reports`,
    ),
  stewardReport: (name: string) =>
    getJSON<{ name: string; path: string; content: string }>(`/api/steward/reports/${name}`),
  reviewState: (slug: string) =>
    getJSON<{ slug: string; verdicts: GroupVerdictRecord[] }>(`/api/runs/${enc(slug)}/review`),
  submitVerdict: (
    slug: string,
    groupId: string,
    verdict: GroupVerdict,
    note?: string,
  ) =>
    postJSON<{ slug: string; record?: GroupVerdictRecord; cleared?: boolean }>(
      `/api/runs/${enc(slug)}/review/${encodeURIComponent(groupId)}/verdict`,
      { verdict, note },
    ),
  submitDiscuss: (slug: string, groupId: string, note: string) =>
    postJSON<{ slug: string; record: GroupVerdictRecord }>(
      `/api/runs/${enc(slug)}/review/${encodeURIComponent(groupId)}/discuss`,
      { note },
    ),
  submitFix: (
    slug: string,
    groupId: string,
    payload: {
      note?: string;
      files?: string[];
      commits?: string[];
      title?: string;
      classification?: string;
    },
  ) =>
    postJSON<{ slug: string; record: GroupVerdictRecord; prompt: string }>(
      `/api/runs/${enc(slug)}/review/${encodeURIComponent(groupId)}/fix`,
      payload,
    ),
};

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
  return r.json() as Promise<T>;
}
