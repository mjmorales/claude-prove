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

const FMT = "%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%cI%x1f%P";

function parseCommitLine(line: string): Commit | null {
  if (!line.trim()) return null;
  const [sha, shortSha, subject, author, authorEmail, timestamp, parents] = line.split("\x1f");
  return {
    sha,
    shortSha,
    subject,
    author,
    authorEmail,
    timestamp,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
  };
}

export async function listCommits(
  repoRoot: string,
  base: string,
  head: string,
  cwd?: string,
): Promise<Commit[]> {
  const git = gitAt(cwd ?? repoRoot);
  let raw: string;
  try {
    raw = await git.raw(["log", `--format=${FMT}`, `${base}..${head}`]);
  } catch {
    // Fall back to head-only if no merge base.
    raw = await git.raw(["log", `--format=${FMT}`, "-n", "50", head]);
  }
  const out: Commit[] = [];
  for (const line of raw.split("\n")) {
    const c = parseCommitLine(line);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Resolve a bare SHA to a Commit object. Returns null when the SHA is no
 * longer reachable (e.g. pruned after a rebase). Used to backfill commit
 * metadata for manifest SHAs that are not in any current branch range —
 * typical of merged full-auto runs.
 */
export async function showCommit(repoRoot: string, sha: string): Promise<Commit | null> {
  const git = gitAt(repoRoot);
  try {
    const raw = await git.raw(["show", "-s", `--format=${FMT}`, sha]);
    for (const line of raw.split("\n")) {
      const c = parseCommitLine(line);
      if (c) return c;
    }
  } catch {
    /* unreachable sha */
  }
  return null;
}
