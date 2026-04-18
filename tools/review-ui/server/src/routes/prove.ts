import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildTaskViews,
  parseRunKey,
  readJson,
  runDir,
  type PlanJson,
  type StateJson,
} from "../parsers.js";
import {
  getAcbDocument,
  getManifestForCommit,
  listManifestsForBranch,
  listManifestsForBranches,
  type IntentManifest,
} from "../acb.js";
import { listCommits, type Commit } from "../commits.js";
import { filterReferenced, listDecisions, readDecision } from "../decisions.js";
import { listStewardReports } from "../steward.js";
import { readRunSummary } from "../runs.js";
import { branchesForRun, resolveWorktreePath } from "../git.js";

type FileRef = { path: string; ranges: string[] };
type Annotation = { id: string; type: string; body: string };
type NegativeSpaceEntry = { path: string; reason: string; note: string };
type OpenQuestion = { id: string; body: string };

type IntentGroupAgg = {
  id: string;
  title: string;
  classification: string;
  ambiguityTags: string[];
  taskGrounding: string;
  files: string[]; // flat path list for backwards-compatible UI consumers
  fileRefs: FileRef[];
  annotations: Annotation[];
  commits: Array<{
    sha: string;
    shortSha: string;
    branch: string;
    subject: string;
    timestamp: string;
  }>;
};

type AssembledIntents = {
  slug: string;
  branches: string[];
  groups: IntentGroupAgg[];
  negativeSpace: NegativeSpaceEntry[];
  openQuestions: OpenQuestion[];
  uncoveredFiles: string[];
  orphanCommits: Array<{
    sha: string;
    shortSha: string;
    branch: string;
    subject: string;
    timestamp: string;
  }>;
};

export function registerProveRoutes(app: FastifyInstance, repoRoot: string) {
  // Tasks + steps view derived from plan.json overlaid with state.json.
  app.get<{ Params: { slug: string } }>("/api/runs/:slug/tasks", async (req, reply) => {
    const key = parseRunKey(req.params.slug);
    if (!key) return reply.code(400).send({ error: "bad slug" });
    const plan = await readJson<PlanJson>(path.join(runDir(repoRoot, key.branch, key.slug), "plan.json"));
    if (!plan) return reply.code(404).send({ error: "plan.json not found" });
    const state = await readJson<StateJson>(path.join(runDir(repoRoot, key.branch, key.slug), "state.json"));
    return { slug: key.composite, mode: plan.mode ?? "simple", tasks: buildTaskViews(plan, state) };
  });

  // Commit timeline for a branch (base..head).
  app.get<{
    Querystring: { slug?: string; base?: string; head?: string };
  }>("/api/commits", async (req, reply) => {
    const { slug, base, head } = req.query;
    if (!base || !head) return reply.code(400).send({ error: "base and head required" });
    let cwd: string | undefined;
    if (slug) {
      const key = parseRunKey(slug);
      if (key) {
        const summary = await readRunSummary(repoRoot, key.branch, key.slug);
        const wt = summary ? await resolveWorktreePath(repoRoot, summary.worktree) : null;
        if (wt) cwd = wt;
      }
    }
    const commits = await listCommits(repoRoot, base, head, cwd);
    return { base, head, commits };
  });

  // Intent manifest for a single commit.
  app.get<{ Params: { sha: string } }>("/api/commits/:sha/intent", async (req) => {
    return { sha: req.params.sha, manifest: getManifestForCommit(repoRoot, req.params.sha) };
  });

  // All manifests for a branch.
  app.get<{ Params: { branch: string } }>("/api/branches/:branch/intents", async (req) => {
    return {
      branch: req.params.branch,
      manifests: listManifestsForBranch(repoRoot, req.params.branch),
    };
  });

  // Unified intents for a run: aggregates every manifest on the orchestrator
  // branch + every task/worktree-agent branch attached to the run, groups by
  // intent_groups[].id, and lists commits without a manifest as orphans.
  app.get<{ Params: { slug: string } }>("/api/runs/:slug/intents", async (req, reply) => {
    const key = parseRunKey(req.params.slug);
    if (!key) return reply.code(400).send({ error: "bad slug" });
    const runBranches = await branchesForRun(repoRoot, key.slug);
    if (runBranches.length === 0)
      return { slug: key.composite, branches: [], groups: [], orphanCommits: [] };

    const branchNames = runBranches.map((b) => b.name);
    const manifests = listManifestsForBranches(repoRoot, branchNames);
    const summary = await readRunSummary(repoRoot, key.branch, key.slug);
    const base = summary?.baseline?.split("@")[0].trim() || "main";

    // Collect every commit in any run branch range (base..branch). Dedup by sha.
    const commitByHead = new Map<string, Commit>();
    for (const b of runBranches) {
      const cwd = b.worktreePath ?? undefined;
      const commits = await listCommits(repoRoot, base, b.name, cwd).catch(() => []);
      for (const c of commits) {
        if (!commitByHead.has(c.sha)) commitByHead.set(c.sha, c);
      }
    }

    // commit_sha -> branch (prefer the first branch that stored a manifest for it).
    const manifestByCommit = new Map<string, IntentManifest>();
    for (const m of manifests) {
      if (!manifestByCommit.has(m.commitSha)) manifestByCommit.set(m.commitSha, m);
    }

    const groups = new Map<string, IntentGroupAgg>();
    const orphanCommits: AssembledIntents["orphanCommits"] = [] as AssembledIntents["orphanCommits"];
    const negativeSpace = new Map<string, NegativeSpaceEntry>();
    const openQuestions = new Map<string, OpenQuestion>();

    for (const [sha, commit] of commitByHead) {
      const m = manifestByCommit.get(sha);
      const ref = {
        sha,
        shortSha: commit.shortSha,
        branch: m?.branch ?? commit_branch(runBranches, sha) ?? "",
        subject: commit.subject,
        timestamp: commit.timestamp,
      };
      if (!m) {
        orphanCommits.push(ref);
        continue;
      }
      const parsed = extractManifest(m.data);
      for (const ig of parsed.groups) {
        const agg =
          groups.get(ig.id) ??
          ({
            id: ig.id,
            title: ig.title,
            classification: ig.classification,
            ambiguityTags: [],
            taskGrounding: "",
            files: [],
            fileRefs: [],
            annotations: [],
            commits: [],
          } satisfies IntentGroupAgg);

        agg.commits.push(ref);

        // classification + title: first-writer-wins (already set above); upgrade
        // if we find a richer title later.
        if (!agg.title && ig.title) agg.title = ig.title;

        // ambiguity_tags — union.
        const tagSet = new Set(agg.ambiguityTags);
        for (const t of ig.ambiguityTags) tagSet.add(t);
        agg.ambiguityTags = [...tagSet];

        // task_grounding — concat when distinct.
        if (ig.taskGrounding && !agg.taskGrounding.includes(ig.taskGrounding)) {
          agg.taskGrounding = agg.taskGrounding
            ? `${agg.taskGrounding}\n\n${ig.taskGrounding}`
            : ig.taskGrounding;
        }

        // file_refs — merge by path, unioning ranges.
        const byPath = new Map<string, FileRef>(agg.fileRefs.map((r) => [r.path, r]));
        for (const f of ig.fileRefs) {
          const existing = byPath.get(f.path);
          if (existing) {
            const rs = new Set(existing.ranges);
            for (const r of f.ranges) rs.add(r);
            existing.ranges = [...rs];
          } else {
            byPath.set(f.path, { path: f.path, ranges: [...f.ranges] });
          }
        }
        agg.fileRefs = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
        agg.files = agg.fileRefs.map((r) => r.path);

        // annotations — dedup by id (first wins).
        const annIds = new Set(agg.annotations.map((a) => a.id));
        for (const a of ig.annotations) {
          if (!annIds.has(a.id)) {
            agg.annotations.push(a);
            annIds.add(a.id);
          }
        }

        groups.set(ig.id, agg);
      }

      for (const ns of parsed.negativeSpace) {
        if (!negativeSpace.has(ns.path)) negativeSpace.set(ns.path, ns);
      }
      for (const q of parsed.openQuestions) {
        if (!openQuestions.has(q.id)) openQuestions.set(q.id, q);
      }
    }

    // uncovered_files = intent-group union complement across all runBranches' diff files.
    const coveredPaths = new Set<string>();
    for (const g of groups.values()) for (const p of g.files) coveredPaths.add(p);
    const diffPaths = new Set<string>();
    for (const b of runBranches) {
      const cwd = b.worktreePath ?? undefined;
      const out = await listChangedPaths(repoRoot, base, b.name, cwd);
      for (const p of out) diffPaths.add(p);
    }
    const uncoveredFiles = [...diffPaths].filter((p) => !coveredPaths.has(p)).sort();

    return {
      slug: key.composite,
      branches: branchNames,
      groups: [...groups.values()].sort((a, b) => a.title.localeCompare(b.title)),
      negativeSpace: [...negativeSpace.values()],
      openQuestions: [...openQuestions.values()],
      uncoveredFiles,
      orphanCommits,
    };
  });

  // Assembled ACB document for a branch (if `python3 -m tools.acb assemble` ran).
  app.get<{ Params: { branch: string } }>("/api/branches/:branch/acb", async (req) => {
    return { branch: req.params.branch, doc: getAcbDocument(repoRoot, req.params.branch) };
  });

  // Decisions referenced by this run's docs (prd.json/plan.json body text).
  app.get<{ Params: { slug: string } }>("/api/runs/:slug/decisions", async (req, reply) => {
    const key = parseRunKey(req.params.slug);
    if (!key) return reply.code(400).send({ error: "bad slug" });
    const dir = runDir(repoRoot, key.branch, key.slug);
    const [prdRaw, planRaw, stateRaw] = await Promise.all([
      fs.readFile(path.join(dir, "prd.json"), "utf8").catch(() => null),
      fs.readFile(path.join(dir, "plan.json"), "utf8").catch(() => null),
      fs.readFile(path.join(dir, "state.json"), "utf8").catch(() => null),
    ]);
    const all = await listDecisions(repoRoot);
    const docs = [prdRaw, planRaw, stateRaw].filter((s): s is string => s !== null);
    return {
      slug: key.composite,
      referenced: filterReferenced(all, docs),
      all,
    };
  });

  app.get<{ Params: { id: string } }>("/api/decisions/:id", async (req, reply) => {
    const { id } = req.params;
    if (!/^[\w.\-]+$/.test(id)) return reply.code(400).send({ error: "bad id" });
    const p = path.join(repoRoot, ".prove/decisions", `${id}.md`);
    const content = await readDecision(p);
    if (!content) return reply.code(404).send({ error: "not found" });
    return { id, path: p, content };
  });

  // Steward audit reports.
  app.get("/api/steward/reports", async () => ({ reports: await listStewardReports(repoRoot) }));

  app.get<{ Params: { name: string } }>("/api/steward/reports/:name", async (req, reply) => {
    const { name } = req.params;
    if (!/^[\w.\-]+\.md$/.test(name)) return reply.code(400).send({ error: "bad name" });
    const p = path.join(repoRoot, ".prove/steward", name);
    const content = await fs.readFile(p, "utf8").catch(() => null);
    if (!content) return reply.code(404).send({ error: "not found" });
    return { name, path: p, content };
  });
}

type RawIntentGroup = {
  id: string;
  title: string;
  classification: string;
  ambiguityTags: string[];
  taskGrounding: string;
  fileRefs: FileRef[];
  annotations: Annotation[];
};

type ParsedManifest = {
  groups: RawIntentGroup[];
  negativeSpace: NegativeSpaceEntry[];
  openQuestions: OpenQuestion[];
};

function extractManifest(data: unknown): ParsedManifest {
  const empty: ParsedManifest = { groups: [], negativeSpace: [], openQuestions: [] };
  if (!data || typeof data !== "object") return empty;
  const root = data as {
    intent_groups?: unknown;
    negative_space?: unknown;
    open_questions?: unknown;
  };

  const groups: RawIntentGroup[] = [];
  for (const g of asArray(root.intent_groups)) {
    if (!g || typeof g !== "object") continue;
    const gg = g as {
      id?: unknown;
      title?: unknown;
      classification?: unknown;
      ambiguity_tags?: unknown;
      task_grounding?: unknown;
      file_refs?: unknown;
      annotations?: unknown;
    };
    const id = asString(gg.id);
    const title = asString(gg.title);
    if (!id || !title) continue;

    const fileRefs: FileRef[] = [];
    for (const f of asArray(gg.file_refs)) {
      if (typeof f === "string") {
        fileRefs.push({ path: f, ranges: [] });
      } else if (f && typeof f === "object") {
        const fr = f as { path?: unknown; ranges?: unknown };
        const p = asString(fr.path);
        if (!p) continue;
        const ranges: string[] = [];
        for (const r of asArray(fr.ranges)) {
          if (typeof r === "string" && r.trim()) ranges.push(r);
        }
        fileRefs.push({ path: p, ranges });
      }
    }

    const annotations: Annotation[] = [];
    for (const a of asArray(gg.annotations)) {
      if (!a || typeof a !== "object") continue;
      const aa = a as { id?: unknown; type?: unknown; body?: unknown };
      const aid = asString(aa.id);
      const body = asString(aa.body);
      if (!aid || !body) continue;
      annotations.push({
        id: aid,
        type: asString(aa.type) || "note",
        body,
      });
    }

    groups.push({
      id,
      title,
      classification: asString(gg.classification) || "explicit",
      ambiguityTags: asArray(gg.ambiguity_tags)
        .filter((t): t is string => typeof t === "string")
        .slice(0, 32),
      taskGrounding: asString(gg.task_grounding),
      fileRefs,
      annotations,
    });
  }

  const negativeSpace: NegativeSpaceEntry[] = [];
  for (const n of asArray(root.negative_space)) {
    if (!n || typeof n !== "object") continue;
    const nn = n as { path?: unknown; reason?: unknown; note?: unknown };
    const p = asString(nn.path);
    if (!p) continue;
    negativeSpace.push({
      path: p,
      reason: asString(nn.reason),
      note: asString(nn.note),
    });
  }

  const openQuestions: OpenQuestion[] = [];
  for (const q of asArray(root.open_questions)) {
    if (!q || typeof q !== "object") continue;
    const qq = q as { id?: unknown; body?: unknown };
    const qid = asString(qq.id);
    const body = asString(qq.body);
    if (!qid || !body) continue;
    openQuestions.push({ id: qid, body });
  }

  return { groups, negativeSpace, openQuestions };
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function listChangedPaths(
  repoRoot: string,
  base: string,
  head: string,
  cwd?: string,
): Promise<string[]> {
  try {
    const { diffFiles } = await import("../git.js");
    const files = await diffFiles(repoRoot, base, head, cwd);
    return files.map((f) => f.path);
  } catch {
    return [];
  }
}

/** Best-effort branch label when the commit has no manifest: first run branch
 *  whose tip is an ancestor of the commit, else empty string. */
function commit_branch(
  runBranches: Array<{ name: string }>,
  _sha: string,
): string | undefined {
  // Cheap stand-in: return the first branch name. Caller only uses this when
  // no manifest exists, so the display is advisory.
  return runBranches[0]?.name;
}
