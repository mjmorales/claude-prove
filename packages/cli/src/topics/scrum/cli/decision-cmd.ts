/**
 * `claude-prove scrum decision <action> [args] [flags]`
 *
 * Action dispatch:
 *   record <path> [--kind K]   Read, parse, upsert decision row; prints JSON row.
 *                              `--kind` (adr|glossary|pattern) sets the Codex
 *                              subtype (v8) and overrides any kind in the file.
 *                              A GATED kind (adr|glossary|pattern) lands as a
 *                              DRAFT — not durably accepted until approved.
 *   approve <id> --by <responder>
 *                              Approve a gated decision's write-gate, accepting
 *                              it durably (status -> accepted). adr/pattern are a
 *                              human gate (any responder); glossary requires a
 *                              tech_lead review (the responder must currently
 *                              hold a tech_lead slot on some team).
 *   reject <id> --by <responder> [--reason <text>]
 *                              Reject a gated decision's write-gate. The decision
 *                              stays blocked (never accepted). `--reason` is
 *                              recorded on the row.
 *   get <id>                   Prints the decision's stored `content` to stdout.
 *   list                       [--topic T] [--status S] [--kind K] [--human]
 *   recover --from-git         Backfill scrum_decisions from every .prove/decisions/*.md
 *                              version ever committed. Idempotent (upsert semantics).
 *   supersede <id> --by <new-id> --reason <text>
 *                              Append-only retire: flips <id> to status
 *                              'superseded', points it at <new-id>, records
 *                              <text>. Never hard-deletes.
 *   review-stale [--days N] [--human]
 *                              Report decisions whose `recorded_at` is older
 *                              than N days (default 90). Report-only — never
 *                              prunes or mutates.
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
  /** `supersede`: replacement id; `approve`/`reject`: the gate responder (`--by`). */
  by?: string;
  /** `supersede`: retirement rationale; `reject`: optional gate rationale (`--reason`). */
  reason?: string;
  /** `review-stale`: staleness threshold in days (default 90). */
  days?: number | string;
  /** `record`: Codex subtype (v8) — `adr | glossary | pattern`. */
  kind?: string;
}

export type DecisionAction =
  | 'record'
  | 'approve'
  | 'reject'
  | 'get'
  | 'list'
  | 'recover'
  | 'supersede'
  | 'review-stale';

const DECISION_ACTIONS: DecisionAction[] = [
  'record',
  'approve',
  'reject',
  'get',
  'list',
  'recover',
  'supersede',
  'review-stale',
];

/** Default decision-record status. */
const DEFAULT_DECISION_STATUS = 'accepted';

/**
 * Canonical closed Codex subtypes (v8). The CLI enforces this
 * set on `--kind`; the column itself stays free TEXT so a future subtype lands
 * via a schema-version bump, not a CHECK constraint.
 */
const CANONICAL_DECISION_KINDS = ['adr', 'glossary', 'pattern'] as const;

/** Default staleness threshold for `review-stale`. */
const DEFAULT_STALE_DAYS = 90;

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
        return doRecord(store, positional[0], flags);
      case 'approve':
        return doApprove(store, positional[0], flags);
      case 'reject':
        return doReject(store, positional[0], flags);
      case 'get':
        return doGet(store, positional[0]);
      case 'list':
        return doList(store, flags);
      case 'recover':
        return doRecover(store, workspaceRoot, flags);
      case 'supersede':
        return doSupersede(store, positional[0], flags);
      case 'review-stale':
        return doReviewStale(store, flags);
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

function doRecord(store: ScrumStore, path: string | undefined, flags: DecisionCmdFlags): number {
  if (path === undefined || path.length === 0) {
    process.stderr.write('scrum decision record: <path> positional argument required\n');
    return 1;
  }
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    process.stderr.write(`scrum decision record: file not found '${path}'\n`);
    return 1;
  }
  // `--kind` (the curation skill's Journal→Codex promotion) overrides any kind
  // parsed from the file. An unknown subtype is a usage error so a typo never
  // silently persists an off-vocabulary kind.
  const kind = normalizeKind(flags.kind);
  if (kind === INVALID_KIND) return 1;

  const content = readFileSync(abs, 'utf8');
  const input = parseDecisionFile(content, path);
  if (kind !== undefined) input.kind = kind;
  const row = store.recordDecision(input);
  const bytes = Buffer.byteLength(content, 'utf8');
  process.stdout.write(`${JSON.stringify(row)}\n`);
  // A gated-kind record lands as a DRAFT (write_status='draft', not accepted)
  // until approved; surface that on stderr so the operator knows a gate is open.
  const gate = row.write_status === 'draft' ? ' [draft — awaiting approve]' : '';
  process.stderr.write(`scrum decision record: ${row.id} (${bytes} bytes)${gate}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// approve / reject — resolve a gated decision's write-gate
// ---------------------------------------------------------------------------

/**
 * `decision approve <id> --by <responder>`. Delegates to
 * `store.approveDecision`, which accepts the gated draft durably (status ->
 * accepted, write_status -> approved). For a `glossary` decision the store
 * additionally requires the responder to currently hold a `tech_lead` slot on
 * some team; `adr`/`pattern` are a plain human gate. Store-level rejections
 * (unknown id, non-gated decision, already-resolved gate, non-tech_lead
 * glossary responder) surface as exit 1 via the caller's catch.
 */
function doApprove(store: ScrumStore, id: string | undefined, flags: DecisionCmdFlags): number {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum decision approve: <id> positional argument required\n');
    return 1;
  }
  const responder = resolveResponder(flags.by);
  if (responder === null) {
    process.stderr.write('scrum decision approve: --by <responder> is required\n');
    return 1;
  }
  const row = store.approveDecision(id, responder);
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum decision approve: ${row.id} -> accepted (by ${responder})\n`);
  return 0;
}

/**
 * `decision reject <id> --by <responder> [--reason <text>]`. Delegates to
 * `store.rejectDecision`, which blocks the gated draft (write_status ->
 * rejected; status stays 'draft' — never accepted). Store-level rejections
 * (unknown id, non-gated decision, already-resolved gate) surface as exit 1.
 */
function doReject(store: ScrumStore, id: string | undefined, flags: DecisionCmdFlags): number {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum decision reject: <id> positional argument required\n');
    return 1;
  }
  const responder = resolveResponder(flags.by);
  if (responder === null) {
    process.stderr.write('scrum decision reject: --by <responder> is required\n');
    return 1;
  }
  const reason = flags.reason && flags.reason.length > 0 ? flags.reason : null;
  const row = store.rejectDecision(id, responder, reason);
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum decision reject: ${row.id} -> blocked (by ${responder})\n`);
  return 0;
}

/**
 * The gate responder — `--by` wins, else the `PROVE_AGENT` env. Returns null
 * when neither is set so the caller emits a usage error (a gate decision must
 * carry a contributor of record).
 */
function resolveResponder(by: string | undefined): string | null {
  if (by !== undefined && by.length > 0) return by;
  const agent = process.env.PROVE_AGENT;
  return agent !== undefined && agent.length > 0 ? agent : null;
}

/** Sentinel distinguishing "invalid kind given" from "no kind given". */
const INVALID_KIND = Symbol('invalid-kind');

/**
 * Validate `--kind` against the canonical Codex subtypes (case-insensitive,
 * normalized to lowercase). Returns `undefined` when absent, the normalized
 * value when valid, or the `INVALID_KIND` sentinel (after writing a usage
 * error) when off-vocabulary.
 */
function normalizeKind(raw: string | undefined): string | undefined | typeof INVALID_KIND {
  if (raw === undefined || raw.length === 0) return undefined;
  const lower = raw.toLowerCase();
  if (!(CANONICAL_DECISION_KINDS as readonly string[]).includes(lower)) {
    process.stderr.write(
      `scrum decision record: unknown --kind '${raw}'. expected one of: ${CANONICAL_DECISION_KINDS.join(', ')}\n`,
    );
    return INVALID_KIND;
  }
  return lower;
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
  if (flags.kind !== undefined && flags.kind.length > 0) filter.kind = flags.kind;

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
// supersede — append-only retire
// ---------------------------------------------------------------------------

/**
 * `decision supersede <id> --by <new-id> --reason <text>`. Delegates to
 * `store.supersedeDecision`, which flips <id> to status 'superseded',
 * points it at <new-id>, and records <text> — never hard-deleting. Prints
 * the updated old row as JSON. Store-level rejections (unknown id, missing
 * replacement, already terminal) surface as exit 1 via the caller's catch.
 */
function doSupersede(store: ScrumStore, id: string | undefined, flags: DecisionCmdFlags): number {
  if (id === undefined || id.length === 0) {
    process.stderr.write('scrum decision supersede: <id> positional argument required\n');
    return 1;
  }
  if (flags.by === undefined || flags.by.length === 0) {
    process.stderr.write('scrum decision supersede: --by <new-id> is required\n');
    return 1;
  }
  if (flags.reason === undefined || flags.reason.length === 0) {
    process.stderr.write('scrum decision supersede: --reason <text> is required\n');
    return 1;
  }

  const row = store.supersedeDecision(id, flags.by, flags.reason);
  process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(`scrum decision supersede: ${row.id} -> ${flags.by}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// review-stale — report decisions past a staleness threshold
// ---------------------------------------------------------------------------

/** One stale-decision report row: the decision plus its computed age in days. */
interface StaleDecision {
  id: string;
  title: string;
  status: string;
  recorded_at: string;
  age_days: number;
}

/**
 * Report decisions whose `recorded_at` is older than `--days` (default 90).
 * REPORT-ONLY: surfaces hygiene candidates for human review and
 * mutates nothing — no prune, no status flip. Already-superseded decisions are
 * excluded (they are retired, not stale-but-live). Sorted oldest-first so the
 * most overdue review floats to the top. JSON array on stdout, or a table with
 * `--human`. An unparseable `recorded_at` is treated as not-stale (skipped)
 * rather than crashing the report.
 *
 * Default threshold is hard-coded to 90 here; the `memory.stale_threshold_days`
 * config knob that overrides it lands in the phase-1 config-consolidation task.
 */
function doReviewStale(store: ScrumStore, flags: DecisionCmdFlags): number {
  const days = resolveStaleDays(flags.days);
  if (days === null) return 1;

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const stale: StaleDecision[] = [];
  for (const row of store.listDecisions()) {
    if (row.status === 'superseded') continue;
    const recordedMs = Date.parse(row.recorded_at);
    if (Number.isNaN(recordedMs) || recordedMs >= cutoffMs) continue;
    stale.push({
      id: row.id,
      title: row.title,
      status: row.status,
      recorded_at: row.recorded_at,
      age_days: Math.floor((Date.now() - recordedMs) / (24 * 60 * 60 * 1000)),
    });
  }
  stale.sort((a, b) => b.age_days - a.age_days);

  if (flags.human === true) {
    process.stdout.write(renderStaleTable(stale, days));
  } else {
    process.stdout.write(`${JSON.stringify(stale)}\n`);
  }
  process.stderr.write(
    `scrum decision review-stale: ${stale.length} decision(s) older than ${days}d\n`,
  );
  return 0;
}

/**
 * Parse the `--days` flag into a positive integer, defaulting to 90 when
 * absent. Writes a usage error and returns null on a non-numeric or
 * non-positive value so the caller exits 1.
 */
function resolveStaleDays(raw: number | string | undefined): number | null {
  if (raw === undefined) return DEFAULT_STALE_DAYS;
  const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write('scrum decision review-stale: --days must be a positive integer\n');
    return null;
  }
  return Math.floor(n);
}

function renderStaleTable(rows: StaleDecision[], days: number): string {
  if (rows.length === 0) return `No decisions older than ${days} days.\n`;
  const header = ['ID', 'TITLE', 'STATUS', 'AGE(d)', 'RECORDED_AT'];
  const body = rows.map((r) => [r.id, r.title, r.status, String(r.age_days), r.recorded_at]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]?.length ?? 0)),
  );
  const format = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ');
  const lines = [format(header), ...body.map(format)];
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// recover — backfill from git history
// ---------------------------------------------------------------------------

/** Glob used both to enumerate commits and to narrow `diff-tree` output. */
const DECISIONS_GLOB = '.prove/decisions/*.md';

/**
 * Thrown inside the recover transaction to signal a git failure at a specific
 * commit SHA. Using a typed error lets the catch block distinguish this
 * controlled rollback from unexpected store errors that should re-throw.
 */
class GitFailureError extends Error {
  constructor(public readonly sha: string) {
    super(`git diff-tree failed at ${sha}`);
    this.name = 'GitFailureError';
  }
}

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
 *   - Blobs that lack an H1 or are empty are skipped; they cannot be decision records.
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
  // Buffer per-blob messages so we only emit them after the transaction commits —
  // a message claiming a row was recovered must not appear if the transaction rolls back.
  const pendingMessages: string[] = [];

  // Wrap the entire commit walk in a single transaction so a mid-walk git failure
  // leaves scrum_decisions untouched — all-or-nothing matches operator expectations
  // on retry (mirrors the seed-atomically pattern used in init-cmd).
  try {
    store.transaction(() => {
      for (const sha of shas) {
        const paths = listDecisionPathsAtCommit(workspaceRoot, sha);
        if (paths === null) {
          // Throw to roll back every upsert written so far in this walk.
          throw new GitFailureError(sha);
        }
        for (const path of paths) {
          const content = readBlobAtCommit(workspaceRoot, sha, path);
          if (content === null) continue;
          if (!isAdrBlob(content)) continue;

          const input = parseDecisionFile(content, path);
          store.recordDecision(input);
          recoveredIds.add(input.id);
          pendingMessages.push(
            `scrum decision recover: recovered ${input.id} from ${sha.slice(0, 8)}\n`,
          );
        }
      }
    });
  } catch (err) {
    if (err instanceof GitFailureError) {
      process.stderr.write(`scrum decision recover: git diff-tree failed at ${err.sha}\n`);
      return 1;
    }
    throw err;
  }

  // Only flush per-blob messages now that the transaction has committed.
  for (const msg of pendingMessages) process.stderr.write(msg);

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
 * Gate blob content before parsing. A decision record must have at least one
 * `# H1` line; empty or plain-text blobs are skipped.
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
 *                `'accepted'` (the decision-record default)
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
