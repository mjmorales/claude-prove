import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { openScrumStore } from "@claude-prove/cli/scrum/store";

export type DecisionRef = {
  id: string;
  title: string;
  path: string;
  date: string | null;
};

/**
 * Resolved decision payload returned by `resolveDecisionById`. `source`
 * tags whether the content came from the scrum_decisions DB row or from
 * the on-disk `.prove/decisions/<id>.md` file — callers can surface the
 * provenance or ignore it.
 */
export interface ResolvedDecision {
  id: string;
  /** Working-tree path: `<repoRoot>/.prove/decisions/<id>.md`. May not exist when `source === 'db'`. */
  path: string;
  content: string;
  source: "db" | "disk";
}

export async function listDecisions(repoRoot: string): Promise<DecisionRef[]> {
  const dir = path.join(repoRoot, ".prove/decisions");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: DecisionRef[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    const text = await fs.readFile(full, "utf8").catch(() => "");
    const titleMatch = text.match(/^#\s+(.+)$/m);
    const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
    out.push({
      id: name.replace(/\.md$/, ""),
      title: titleMatch ? titleMatch[1].trim() : name,
      path: full,
      date: dateMatch ? dateMatch[1] : null,
    });
  }
  out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return out;
}

/** Find decisions referenced by any of the given docs (substring match on id). */
export function filterReferenced(decisions: DecisionRef[], docs: string[]): DecisionRef[] {
  const haystack = docs.join("\n");
  return decisions.filter((d) => haystack.includes(d.id));
}

export async function readDecision(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * DB-first decision resolver: opens the scrum store at
 * `<repoRoot>/.prove/prove.db` and returns the `scrum_decisions` row when
 * present. Falls back to `<repoRoot>/.prove/decisions/<id>.md` on disk when
 * the DB row is absent — preserves compatibility with repos that predate
 * decision persistence (task 3.2). Returns `null` when neither source has
 * content.
 *
 * The store handle is closed before returning so GET handlers don't leak
 * sqlite connections across requests.
 */
export async function resolveDecisionById(
  repoRoot: string,
  id: string,
): Promise<ResolvedDecision | null> {
  const diskPath = path.join(repoRoot, ".prove/decisions", `${id}.md`);

  // DB path: only attempt when the file exists — avoids auto-creating
  // prove.db for repos that never bootstrapped scrum (matches acb.ts +
  // scrum.ts short-circuit policy).
  const dbFile = path.join(repoRoot, ".prove/prove.db");
  if (fsSync.existsSync(dbFile)) {
    const store = openScrumStore({ override: dbFile });
    try {
      const row = store.getDecision(id);
      if (row) {
        return { id, path: diskPath, content: row.content, source: "db" };
      }
    } finally {
      store.close();
    }
  }

  const diskContent = await readDecision(diskPath);
  if (diskContent !== null) {
    return { id, path: diskPath, content: diskContent, source: "disk" };
  }
  return null;
}
