/**
 * `claude-prove scrum decision <action> [args] [flags]`
 *
 * Action dispatch:
 *   record <path>              Read, parse, upsert decision row; prints JSON row.
 *   get <id>                   Prints the decision's stored `content` to stdout.
 *   list                       [--topic T] [--status S] [--human]
 *   recover --from-git         Backfill scrum_decisions from every .prove/decisions/*.md
 *                              version ever committed. Idempotent (upsert semantics).
 *
 * Stdout contract: JSON result per action on stdout; one-line human
 * summary on stderr. `list` returns a JSON array (or a table with `--human`).
 *
 * Exit codes:
 *   0  success
 *   1  usage error, unknown action, missing file, unknown id, git failure
 *
 * The file parser (`parseDecisionFile`) is exported as a pure function so
 * `link-decision` (in task-cmd.ts) can reuse the same extraction rules.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { mainWorktreeRoot } from '@claude-prove/shared';
import type { ListDecisionsFilter, RecordDecisionInput, ScrumStore } from '../store';
import { openScrumStore } from '../store';
import type { DecisionRow } from '../types';

export interface DecisionCmdFlags {
  topic?: string;
  status?: string;
  human?: boolean;
  workspaceRoot?: string;
  /** Required by `recover`; absent triggers a usage error. */
  fromGit?: boolean;
}

export type DecisionAction = 'record' | 'get' | 'list' | 'recover';

const DECISION_ACTIONS: DecisionAction[] = ['record', 'get', 'list', 'recover'];

/** ADR default per `.prove/decisions/` convention. */
const DEFAULT_DECISION_STATUS = 'accepted';

export function runDecisionCmd(
  action: string,
  positional: (string | undefined)[],
  flags: DecisionCmdFlags,
): number {
  if (!isDecisionAction(action)) {
    process.stderr.write(
      `error: unknown decision action '${action}'. expected one of: ${DECISION_ACTIONS.join(', ')}\n`,
    );
    return 1;
  }

  const workspaceRoot =
    flags.workspaceRoot && flags.workspaceRoot.length > 0
      ? flags.workspaceRoot
      : (mainWorktreeRoot() ?? process.cwd());
  const store = openScrumStore({ override: join(workspaceRoot, '.prove', 'prove.db') });
  try {
    switch (action) {
      case 'record':
        return doRecord(store, positional[0]);
      case 'get':
        return doGet(store, positional[0]);
      case 'list':
        return doList(store, flags);
      case 'recover':
        return doRecover(store, workspaceRoot, flags);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scrum decision ${action}: ${msg}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function isDecisionAction(value: string): value is DecisionAction {
  return (DECISION_ACTIONS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

function doRecord(store: ScrumStore, path: string | undefined): number {
  if (path === undefined || path.length === 0) {
    process.stderr.write('scrum decision record: <path> positional argument required\n');
    return 1;
  }
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    process.stderr.write(`scrum decision record: file not found '${path}'\n`);
    return 1;
  }
  const content = readFileSync(abs, 'utf8');
  const input = parseDecisionFile(content, path);
  const row = store.recordDecision(input);
  const bytes = Buffer.byteLength(content, 'utf8');
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum decision record: ${row.id} (${bytes} bytes)\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

function doGet(store: ScrumStore, id: string | undefined): number {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum decision get: <id> positional argument required\n');
    return 1;
  }
  const row = store.getDecision(id);
  if (row === null) {
    process.stderr.write(`scrum decision get: unknown decision '${id}'\n`);
    return 1;
  }
  process.stdout.write(row.content);
  process.stderr.write(`scrum decision get: ${row.id} (${row.content.length} chars)\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function doList(store: ScrumStore, flags: DecisionCmdFlags): number {
  const filter: ListDecisionsFilter = {};
  if (flags.topic !== undefined && flags.topic.length > 0) filter.topic = flags.topic;
  if (flags.status !== undefined && flags.status.length > 0) filter.status = flags.status;

  const rows = store.listDecisions(filter);
  if (flags.human === true) {
    process.stdout.write(renderHumanTable(rows));
  } else {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  }
  process.stderr.write(`scrum decision list: ${rows.length} decisions\n`);
  return 0;
}

function renderHumanTable(rows: DecisionRow[]): string {
  const header = ['ID', 'TITLE', 'TOPIC', 'STATUS', 'RECORDED_AT'];
  const body = rows.map((r) => [r.id, r.title, r.topic ?? '', r.status, r.recorded_at]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');

  const lines: string[] = [];
  lines.push(format(header));
  for (const row of body) lines.push(format(row));
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// recover — backfill from git history
// ---------------------------------------------------------------------------

/** Glob used both to enumerate commits and to narrow `diff-tree` output. */
const DECISIONS_GLOB = '.prove/decisions/*.md';

/**
 * Walk every commit that ever touched `.prove/decisions/*.md` (oldest-first
 * so the newest version wins naturally on upsert) and read each blob at its
 * commit SHA. Each blob is parsed via `parseDecisionFile` and upserted.
 *
 * Idempotent: running twice over the same history yields the same rows. The
 * upsert bumps `recorded_at` on every pass — that is expected, not a bug.
 *
 * Design notes:
 *   - All git calls use `spawnSync` with an explicit args array and no
 *     `shell: true` — paths never touch a shell.
 *   - Non-repo is a usage error (exit 1); empty history is a clean no-op.
 *   - Blobs that lack an H1 or are empty are skipped; they cannot be ADRs.
 */
function doRecover(store: ScrumStore, workspaceRoot: string, flags: DecisionCmdFlags): number {
  if (flags.fromGit !== true) {
    process.stderr.write(
      'scrum decision recover: --from-git flag is required (no other source is implemented)\n',
    );
    return 1;
  }

  const repoCheck = spawnSync('git', ['-C', workspaceRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (repoCheck.status !== 0) {
    const stderr = (repoCheck.stderr ?? '').trim();
    process.stderr.write(
      `scrum decision recover: not a git repository at '${workspaceRoot}'${stderr ? ` (${stderr})` : ''}\n`,
    );
    return 1;
  }

  const shas = listDecisionCommits(workspaceRoot);
  if (shas === null) {
    process.stderr.write('scrum decision recover: git log failed\n');
    return 1;
  }

  const recoveredIds = new Set<string>();
  for (const sha of shas) {
    const paths = listDecisionPathsAtCommit(workspaceRoot, sha);
    if (paths === null) {
      process.stderr.write(`scrum decision recover: git diff-tree failed at ${sha}\n`);
      return 1;
    }
    for (const path of paths) {
      const content = readBlobAtCommit(workspaceRoot, sha, path);
      if (content === null) continue;
      if (!isAdrBlob(content)) continue;

      const input = parseDecisionFile(content, path);
      store.recordDecision(input);
      recoveredIds.add(input.id);
      process.stderr.write(
        `scrum decision recover: recovered ${input.id} from ${sha.slice(0, 8)}\n`,
      );
    }
  }

  const ids = Array.from(recoveredIds).sort();
  process.stdout.write(`${JSON.stringify({ recovered: ids.length, ids })}\n`);
  process.stderr.write(
    `scrum decision recover: recovered ${ids.length} decisions from git history\n`,
  );
  return 0;
}

/**
 * Enumerate every commit SHA (all refs) whose diff adds/modifies/renames a
 * `.prove/decisions/*.md` file, oldest-first. Returns `null` on git failure.
 */
function listDecisionCommits(workspaceRoot: string): string[] | null {
  const res = spawnSync(
    'git',
    [
      '-C',
      workspaceRoot,
      'log',
      '--all',
      '--reverse',
      '--diff-filter=AMR',
      '--format=%H',
      '--',
      DECISIONS_GLOB,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return null;
  const out = (res.stdout ?? '').trim();
  if (out.length === 0) return [];
  return out.split('\n').filter((line) => line.length > 0);
}

/**
 * List `.prove/decisions/*.md` paths changed in a single commit. Uses
 * `diff-tree` (single-commit view) rather than `log` to avoid walking
 * history again.
 */
function listDecisionPathsAtCommit(workspaceRoot: string, sha: string): string[] | null {
  const res = spawnSync(
    'git',
    [
      '-C',
      workspaceRoot,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      sha,
      '--',
      DECISIONS_GLOB,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return null;
  const out = (res.stdout ?? '').trim();
  if (out.length === 0) return [];
  return out.split('\n').filter((line) => line.length > 0);
}

/**
 * Read the blob at `<sha>:<path>`. Returns `null` if git fails (e.g. the
 * path was deleted in this commit — delete events do not carry blobs).
 */
function readBlobAtCommit(workspaceRoot: string, sha: string, path: string): string | null {
  const res = spawnSync('git', ['-C', workspaceRoot, 'show', `${sha}:${path}`], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return null;
  return res.stdout ?? '';
}

/**
 * Gate blob content before parsing. An ADR must have at least one `# H1`
 * line; empty or plain-text blobs are skipped.
 */
function isAdrBlob(content: string): boolean {
  if (content.length === 0) return false;
  for (const line of content.split('\n')) {
    if (/^#\s+.+/.test(line)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// parseDecisionFile — pure extractor (exported for link-decision reuse)
// ---------------------------------------------------------------------------

/**
 * Parse a decision markdown file into a `RecordDecisionInput` ready for
 * `store.recordDecision`. Pure — no I/O, no store dependency. Rules:
 *
 *   - `id`     = basename without `.md` extension
 *   - `title`  = text of the first H1 (`# ...`) in the body; falls back
 *                to `id` if no H1 is found
 *   - `topic`  = value of `**Topic**: X` or `Topic: X` line if present;
 *                otherwise `null`
 *   - `status` = value of `**Status**: X` if present; otherwise
 *                `'accepted'` (the ADR default)
 *   - `content`           = raw file content (not trimmed)
 *   - `sourcePath`        = the input `path` (as given, not resolved)
 *   - `recordedByAgent`   = `PROVE_AGENT` env var if set, else `null`
 */
export function parseDecisionFile(content: string, path: string): RecordDecisionInput {
  const id = basename(path).replace(/\.md$/, '');
  const title = extractTitle(content) ?? id;
  const topic = extractField(content, 'Topic');
  const status = extractField(content, 'Status') ?? DEFAULT_DECISION_STATUS;
  const recordedByAgent = process.env.PROVE_AGENT ?? null;

  return {
    id,
    title,
    topic,
    status,
    content,
    sourcePath: path,
    recordedByAgent,
  };
}

function extractTitle(content: string): string | null {
  for (const line of content.split('\n')) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * Extract a labeled field in either `**Label**: value` or `Label: value`
 * form. Returns the trimmed value or `null` if no match is found.
 */
function extractField(content: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(?:\\*\\*${escaped}\\*\\*|${escaped})\\s*:\\s*(.+?)\\s*$`, 'mi');
  const match = content.match(pattern);
  return match ? (match[1] ?? null) : null;
}
