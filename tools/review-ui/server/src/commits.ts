import { gitAt } from "./git.js";

export type Commit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  timestamp: string;
  parents: string[];
};

export async function listCommits(
  repoRoot: string,
  base: string,
  head: string,
  cwd?: string,
): Promise<Commit[]> {
  const git = gitAt(cwd ?? repoRoot);
  const FMT = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%cI%x1f%P";
  let raw: string;
  try {
    raw = await git.raw(["log", `--format=${FMT}`, `${base}..${head}`]);
  } catch {
    // Fall back to head-only if no merge base.
    raw = await git.raw(["log", `--format=${FMT}`, "-n", "50", head]);
  }
  const out: Commit[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [sha, shortSha, subject, author, authorEmail, timestamp, parents] = line.split("\x1f");
    out.push({
      sha,
      shortSha,
      subject,
      author,
      authorEmail,
      timestamp,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
    });
  }
  return out;
}
