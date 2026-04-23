import fs from "node:fs/promises";
import path from "node:path";

export type DecisionRef = {
  id: string;
  title: string;
  path: string;
  date: string | null;
};

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
