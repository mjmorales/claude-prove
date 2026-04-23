export type DiffLine =
  | { kind: "ctx"; oldN: number; newN: number; text: string }
  | { kind: "add"; oldN: null; newN: number; text: string }
  | { kind: "del"; oldN: number; newN: null; text: string };

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type ParsedDiff = {
  oldPath: string | null;
  newPath: string | null;
  isBinary: boolean;
  hunks: DiffHunk[];
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const lines = patch.split("\n");
  const parsed: ParsedDiff = { oldPath: null, newPath: null, isBinary: false, hunks: [] };
  let i = 0;
  let current: DiffHunk | null = null;
  let oldN = 0;
  let newN = 0;

  while (i < lines.length) {
    const ln = lines[i];
    if (ln.startsWith("diff --git")) {
      current = null;
    } else if (ln.startsWith("Binary files")) {
      parsed.isBinary = true;
    } else if (ln.startsWith("--- ")) {
      parsed.oldPath = stripPrefix(ln.slice(4));
    } else if (ln.startsWith("+++ ")) {
      parsed.newPath = stripPrefix(ln.slice(4));
    } else {
      const hm = ln.match(HUNK_RE);
      if (hm) {
        current = {
          header: ln,
          oldStart: Number(hm[1]),
          oldLines: hm[2] ? Number(hm[2]) : 1,
          newStart: Number(hm[3]),
          newLines: hm[4] ? Number(hm[4]) : 1,
          lines: [],
        };
        oldN = current.oldStart;
        newN = current.newStart;
        parsed.hunks.push(current);
      } else if (current) {
        if (ln.startsWith("+") && !ln.startsWith("+++")) {
          current.lines.push({ kind: "add", oldN: null, newN: newN++, text: ln.slice(1) });
        } else if (ln.startsWith("-") && !ln.startsWith("---")) {
          current.lines.push({ kind: "del", oldN: oldN++, newN: null, text: ln.slice(1) });
        } else if (ln.startsWith(" ")) {
          current.lines.push({ kind: "ctx", oldN: oldN++, newN: newN++, text: ln.slice(1) });
        } else if (ln.startsWith("\\")) {
          // "\ No newline at end of file" — skip.
        }
      }
    }
    i++;
  }
  return parsed;
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^a\//, "").replace(/^b\//, "").trim();
}
