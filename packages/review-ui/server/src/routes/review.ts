import type { FastifyInstance } from "fastify";
import {
  clearVerdict,
  listVerdicts,
  upsertVerdict,
  type GroupVerdict,
  type GroupVerdictRecord,
} from "../acb.js";
import { parseRunKey } from "../parsers.js";

// Canonical `VerdictValue` vocabulary (see `@claude-prove/cli/acb/schemas`).
// Clients are expected to post canonical strings; legacy aliases (`approved`,
// `discuss`) are NOT accepted here — the one-way migration lives at the DB
// read boundary (`coerceLegacyVerdict`), not the HTTP ingress.
const ALLOWED: ReadonlySet<GroupVerdict> = new Set([
  "pending",
  "accepted",
  "rejected",
  "needs_discussion",
  "rework",
]);

type VerdictBody = {
  verdict?: unknown;
  note?: unknown;
};

type FixBody = {
  note?: unknown;
  files?: unknown;
  commits?: unknown;
  title?: unknown;
  classification?: unknown;
};

export function registerReviewRoutes(app: FastifyInstance, repoRoot: string) {
  app.get<{ Params: { slug: string } }>(
    "/api/runs/:slug/review",
    async (req, reply) => {
      const key = parseRunKey(req.params.slug);
      if (!key) return reply.code(400).send({ error: "bad slug" });
      const verdicts = listVerdicts(repoRoot, key.composite);
      return { slug: key.composite, verdicts };
    },
  );

  app.post<{ Params: { slug: string; groupId: string }; Body: VerdictBody }>(
    "/api/runs/:slug/review/:groupId/verdict",
    async (req, reply) => {
      const key = parseRunKey(req.params.slug);
      if (!key) return reply.code(400).send({ error: "bad slug" });
      const groupId = req.params.groupId;
      if (!groupId) return reply.code(400).send({ error: "missing groupId" });

      const verdict = req.body?.verdict;
      if (typeof verdict !== "string" || !ALLOWED.has(verdict as GroupVerdict)) {
        return reply.code(400).send({ error: "bad verdict" });
      }

      const note = typeof req.body?.note === "string" ? req.body.note.trim() : null;

      if (verdict === "pending") {
        clearVerdict(repoRoot, key.composite, groupId);
        return { slug: key.composite, groupId, cleared: true };
      }

      const rec = upsertVerdict(
        repoRoot,
        key.composite,
        groupId,
        verdict as GroupVerdict,
        note && note.length > 0 ? note : null,
        null,
      );
      return { slug: key.composite, record: rec };
    },
  );

  app.post<{ Params: { slug: string; groupId: string }; Body: FixBody }>(
    "/api/runs/:slug/review/:groupId/fix",
    async (req, reply) => {
      const key = parseRunKey(req.params.slug);
      if (!key) return reply.code(400).send({ error: "bad slug" });
      const groupId = req.params.groupId;
      if (!groupId) return reply.code(400).send({ error: "missing groupId" });

      const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
      const files = isStringArray(req.body?.files) ? req.body.files : [];
      const commits = isStringArray(req.body?.commits) ? req.body.commits : [];
      const title = typeof req.body?.title === "string" ? req.body.title : groupId;
      const classification =
        typeof req.body?.classification === "string" ? req.body.classification : "unspecified";

      const prompt = composeFixPrompt({
        slug: key.composite,
        groupId,
        title,
        classification,
        note,
        files,
        commits,
      });

      const rec = upsertVerdict(
        repoRoot,
        key.composite,
        groupId,
        "rework",
        note && note.length > 0 ? note : null,
        prompt,
      );
      return { slug: key.composite, record: rec, prompt };
    },
  );

  app.post<{ Params: { slug: string; groupId: string }; Body: VerdictBody }>(
    "/api/runs/:slug/review/:groupId/discuss",
    async (req, reply) => {
      const key = parseRunKey(req.params.slug);
      if (!key) return reply.code(400).send({ error: "bad slug" });
      const groupId = req.params.groupId;
      if (!groupId) return reply.code(400).send({ error: "missing groupId" });

      const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
      if (note.length === 0) return reply.code(400).send({ error: "note required" });

      const rec = upsertVerdict(
        repoRoot,
        key.composite,
        groupId,
        "needs_discussion",
        note,
        null,
      );
      return { slug: key.composite, record: rec };
    },
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

type FixInput = {
  slug: string;
  groupId: string;
  title: string;
  classification: string;
  note: string;
  files: string[];
  commits: string[];
};

function composeFixPrompt(inp: FixInput): string {
  const lines: string[] = [];
  lines.push(`# REWORK — ${inp.groupId}`);
  lines.push("");
  lines.push(`**Run**: \`${inp.slug}\``);
  lines.push(`**Intent**: ${inp.title}`);
  lines.push(`**Classification**: ${inp.classification}`);
  lines.push("");
  lines.push("## Why this was rejected");
  lines.push("");
  lines.push(inp.note || "(no reviewer note supplied — infer from diff)");
  lines.push("");
  if (inp.commits.length > 0) {
    lines.push("## Commits in scope");
    lines.push("");
    for (const c of inp.commits) lines.push(`- \`${c}\``);
    lines.push("");
  }
  if (inp.files.length > 0) {
    lines.push("## Files touched");
    lines.push("");
    for (const f of inp.files) lines.push(`- \`${f}\``);
    lines.push("");
  }
  lines.push("## Your task");
  lines.push("");
  lines.push(
    "Rework the listed files to address the reviewer note above. Keep the intent scope unchanged — only fix the issues called out. When done, re-stage the commits against the same branch and re-run the validators.",
  );
  return lines.join("\n");
}

export type { GroupVerdictRecord };
