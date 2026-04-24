/**
 * `claude-prove prompting token-count <patterns...> [--sort ...] [--json] [--no-strip]`
 *
 * Ports `scripts/token-count.py::main`. Output format (both the ranked-text
 * table and the JSON shape) is byte-equal to the Python reference for the
 * same inputs — skills and orchestrator callers depend on the exact layout.
 *
 * Flag surface:
 *   - positional: one or more glob patterns / file paths (default: **\/*.md)
 *   - --sort tokens | name | lines   (default: tokens desc)
 *   - --json                          machine-readable JSON array
 *   - --no-strip                      include YAML frontmatter in counts
 */

import { type MeasureEntry, measureFiles, resolvePaths } from './measure';

export type SortKey = 'tokens' | 'name' | 'lines';

export interface TokenCountFlags {
  patterns: string[];
  sort: SortKey;
  json: boolean;
  noStrip: boolean;
  cwd?: string;
}

export function runTokenCountCmd(flags: TokenCountFlags): number {
  const patterns = flags.patterns.length > 0 ? flags.patterns : ['**/*.md'];
  const paths = resolvePaths(patterns, flags.cwd ?? process.cwd());
  const entries = measureFiles(paths, !flags.noStrip);
  sortEntries(entries, flags.sort);

  if (flags.json) {
    // Python: `json.dump(entries, sys.stdout, indent=2); print()`
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  } else {
    process.stdout.write(formatTable(entries));
  }
  return 0;
}

function sortEntries(entries: MeasureEntry[], key: SortKey): void {
  if (key === 'tokens') {
    entries.sort((a, b) => b.tokens - a.tokens);
  } else if (key === 'name') {
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } else {
    entries.sort((a, b) => b.lines - a.lines);
  }
}

/**
 * Reproduce Python's `print_table` output exactly: fixed-width path column,
 * right-aligned number columns with thousands separators, and a TOTAL row.
 */
export function formatTable(entries: MeasureEntry[]): string {
  if (entries.length === 0) {
    return 'No files found.\n';
  }

  const pathWidth = Math.max(4, ...entries.map((e) => e.path.length));
  const header = `${padEnd('Path', pathWidth)}  ${padStart('Tokens', 7)}  ${padStart('Lines', 6)}  ${padStart('Chars', 7)}`;
  const rule = '-'.repeat(header.length);

  const lines: string[] = [header, rule];
  for (const e of entries) {
    lines.push(
      `${padEnd(e.path, pathWidth)}  ${padStart(formatNum(e.tokens), 7)}  ${padStart(formatNum(e.lines), 6)}  ${padStart(formatNum(e.chars), 7)}`,
    );
  }

  const totals = entries.reduce(
    (acc, e) => ({
      tokens: acc.tokens + e.tokens,
      lines: acc.lines + e.lines,
      chars: acc.chars + e.chars,
    }),
    { tokens: 0, lines: 0, chars: 0 },
  );

  lines.push(rule);
  lines.push(
    `${padEnd('TOTAL', pathWidth)}  ${padStart(formatNum(totals.tokens), 7)}  ${padStart(formatNum(totals.lines), 6)}  ${padStart(formatNum(totals.chars), 7)}  (${entries.length} files)`,
  );

  return `${lines.join('\n')}\n`;
}

function padEnd(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padStart(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** Thousands-separator formatter matching Python's `format(n, ",")`. */
function formatNum(n: number): string {
  return n.toLocaleString('en-US');
}
