import fs from "node:fs/promises";
import path from "node:path";

export type StewardReport = {
  name: string;
  path: string;
  mtime: string;
  sizeBytes: number;
};

export async function listStewardReports(repoRoot: string): Promise<StewardReport[]> {
  const dir = path.join(repoRoot, ".prove/steward");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: StewardReport[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile() || !name.endsWith(".md")) continue;
    out.push({
      name,
      path: full,
      mtime: st.mtime.toISOString(),
      sizeBytes: st.size,
    });
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}
