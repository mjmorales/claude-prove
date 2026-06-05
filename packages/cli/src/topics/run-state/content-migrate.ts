/**
 * Content-migration planner for run artifacts behind the current schema.
 *
 * The deterministic `schema-migrate.ts` chain handles STRUCTURAL moves on an
 * already-JSON artifact: version bumps, a string promoted to `{ text }`, a
 * field renamed or relocated. Those are mechanical — one fixed rule rewrites
 * the shape with no understanding of the content.
 *
 * Some schema bumps instead need CONTENT reshaping: stored prose or structured
 * findings (a reasoning-log entry body, a synthesis outcome, a free-form risk
 * note) must be rewritten to fit a new shape, and only a model can do that
 * faithfully. No column rule can split one prose field into two, re-summarize
 * a body against a tighter contract, or reclassify a finding by reading it.
 *
 * This module is the MECHANICAL half of that flow, true to the founding bet
 * that prove never spawns a model — the operator's session does. It detects
 * which run artifacts sit behind `CURRENT_SCHEMA_VERSION`, decides whether the
 * lag crosses a content-reshaping hop, and EMITS a plan naming the target
 * artifacts plus the instruction file for each hop. It never calls a model and
 * never rewrites content; the `run-migrate` skill consumes the plan and applies
 * the reshaping, gated by the operator on explicit invocation. There is no
 * resident or background migration loop — the plan is produced only when the
 * operator runs the command.
 *
 * Registry shape mirrors `schema-migrate.ts`: one entry per `"<from>_to_<to>"`
 * hop, target version encoded in the key. A hop is frozen-in-time — NEVER
 * reference `CURRENT_SCHEMA_VERSION` inside an entry, so a later version bump
 * cannot retroactively change what an earlier hop reshapes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canAdvanceStructurally } from './schema-migrate';
import { CURRENT_SCHEMA_VERSION } from './schemas';

/** Run-artifact kinds a content hop may touch. Closed set. */
export const CONTENT_ARTIFACT_KINDS = ['prd', 'plan', 'state', 'reasoning-log'] as const;
export type ContentArtifactKind = (typeof CONTENT_ARTIFACT_KINDS)[number];

/**
 * One content-reshaping hop in the registry. `instructions` is a path to a
 * markdown file the skill reads — never inline prose, so the migration prompt
 * stays diffable and reviewable. `kinds` lists which artifact kinds the hop
 * reshapes; an artifact whose kind is absent needs no content work for this
 * hop (the deterministic chain alone covers it).
 */
export interface ContentHop {
  /** Source schema version (the `from` half of the registry key). */
  from: string;
  /** Target schema version (the `to` half of the registry key). */
  to: string;
  /** Artifact kinds this hop reshapes. */
  kinds: readonly ContentArtifactKind[];
  /**
   * Path to the migration-instruction markdown, relative to the plugin root.
   * The skill reads this file to learn how to reshape the artifact's content.
   */
  instructions: string;
  /** One-line description of what content this hop reshapes. */
  summary: string;
}

/**
 * Closed registry of content-reshaping hops, keyed `"<from>_to_<to>"`. Empty
 * when no shipped schema bump has yet required content reshaping — the
 * deterministic chain has covered every bump structurally. Adding a hop is
 * gated behind a schema-version bump and its instruction file, exactly like a
 * deterministic migration entry. Keep the ladder dense and ordered.
 */
export const CONTENT_HOPS: Record<string, ContentHop> = {};

/** A single artifact found behind the current schema, with its hop plan. */
export interface ArtifactMigration {
  /** Absolute path to the artifact file. */
  file: string;
  /** Artifact kind, as classified from its filename. */
  kind: ContentArtifactKind;
  /** Schema version read off the artifact (defaults to v1 when absent). */
  fromVersion: string;
  /** Target version every artifact is brought to. */
  toVersion: string;
  /**
   * Content hops the lag crosses that actually reshape THIS artifact's kind.
   * Empty means the lag is covered structurally by the deterministic chain —
   * the artifact still needs `schema migrate`, but no model-driven reshaping.
   */
  hops: ContentHop[];
}

/** A run directory's full content-migration plan. */
export interface RunMigrationPlan {
  /** Absolute run directory path. */
  runDir: string;
  /** Artifacts in this run that sit behind the current schema. */
  artifacts: ArtifactMigration[];
}

/** Top-level emitted plan: every behind-version run under the scanned root. */
export interface MigrationPlan {
  /** The current schema version every artifact targets. */
  currentVersion: string;
  /** Run directories with at least one behind-version artifact. */
  runs: RunMigrationPlan[];
  /** Total artifacts needing any migration (structural and/or content). */
  artifactsBehind: number;
  /** Subset of `artifactsBehind` that need model-driven content reshaping. */
  artifactsNeedingContent: number;
}

/** Detect an artifact's schema version; absent => v1 (first versioned schema). */
export function detectArtifactVersion(data: Record<string, unknown>): string {
  const v = data.schema_version;
  return typeof v === 'string' ? v : '1';
}

/**
 * The content hops a `from -> to` version lag crosses for `kind`. Walks the
 * registry version by version, collecting only hops that list `kind` in their
 * `kinds`. A lag with no matching hop returns `[]` — covered structurally.
 */
export function contentHopsFor(from: string, to: string, kind: ContentArtifactKind): ContentHop[] {
  const hops: ContentHop[] = [];
  let version = from;
  while (version !== to) {
    const next = String(Number.parseInt(version, 10) + 1);
    const hop = CONTENT_HOPS[`${version}_to_${next}`];
    if (hop?.kinds.includes(kind)) hops.push(hop);
    if (Number.isNaN(Number.parseInt(next, 10)) || next === version) break;
    version = next;
  }
  return hops;
}

/**
 * Plan content migration for a single run directory. Reads each JSON artifact
 * (prd/plan/state) plus the reasoning log, classifies its version lag, and
 * records the content hops that reshape it. Pure read — never writes. A
 * missing or unparseable artifact is skipped (not all kinds exist in every
 * run); the caller surfaces the count, not a hard failure.
 */
export function planRunContentMigration(runDir: string): RunMigrationPlan {
  const artifacts: ArtifactMigration[] = [];
  const jsonArtifacts: ReadonlyArray<[ContentArtifactKind, string]> = [
    ['prd', join(runDir, 'prd.json')],
    ['plan', join(runDir, 'plan.json')],
    ['state', join(runDir, 'state.json')],
  ];

  for (const [kind, file] of jsonArtifacts) {
    const version = readArtifactVersion(file);
    if (version === null || version === CURRENT_SCHEMA_VERSION) continue;
    const hops = contentHopsFor(version, CURRENT_SCHEMA_VERSION, kind);
    // Only report an artifact as behind when SOME migration would actually
    // run: a content hop here, or a structural hop the deterministic `migrate`
    // chain can run from this version. A lag with neither (a genuine registry
    // gap at this version) is not migratable, so listing it would disagree
    // with `migrate`, which processes zero such artifacts.
    if (hops.length === 0 && !canAdvanceStructurally(version)) continue;
    artifacts.push({
      file,
      kind,
      fromVersion: version,
      toVersion: CURRENT_SCHEMA_VERSION,
      hops,
    });
  }

  const reasoning = planReasoningLogMigration(runDir);
  if (reasoning) artifacts.push(reasoning);

  return { runDir, artifacts };
}

/**
 * Read just the `schema_version` off a JSON artifact. Returns `null` when the
 * file is absent or unparseable so the caller can skip it; this is a planner,
 * not a validator, and a malformed artifact is the deterministic migrate's
 * concern, not ours.
 */
function readArtifactVersion(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return detectArtifactVersion(data);
  } catch {
    return null;
  }
}

/**
 * Plan content migration for a run's reasoning log. The log dir holds one
 * JSON entry per file with no aggregate `schema_version`, so its lag is the
 * span from the lowest schema-versioned entry to current; here we treat the
 * presence of any content hop touching `reasoning-log` between v1 and current
 * as the trigger. Returns `null` when no log dir exists or no hop reshapes it.
 */
function planReasoningLogMigration(runDir: string): ArtifactMigration | null {
  const logDir = join(runDir, 'log');
  if (!existsSync(logDir)) return null;
  const hops = contentHopsFor('1', CURRENT_SCHEMA_VERSION, 'reasoning-log');
  if (hops.length === 0) return null;
  return {
    file: logDir,
    kind: 'reasoning-log',
    fromVersion: '1',
    toVersion: CURRENT_SCHEMA_VERSION,
    hops,
  };
}

/**
 * Plan content migration across the given run directories. `runDirs` is
 * injected (rather than re-walking here) to keep this module pure and
 * testable; the CLI handler discovers the run leaves and passes them in.
 */
export function planContentMigration(runDirs: readonly string[]): MigrationPlan {
  const runs: RunMigrationPlan[] = [];
  let artifactsBehind = 0;
  let artifactsNeedingContent = 0;

  for (const runDir of [...runDirs].sort()) {
    const plan = planRunContentMigration(runDir);
    if (plan.artifacts.length === 0) continue;
    runs.push(plan);
    artifactsBehind += plan.artifacts.length;
    artifactsNeedingContent += plan.artifacts.filter((a) => a.hops.length > 0).length;
  }

  return {
    currentVersion: CURRENT_SCHEMA_VERSION,
    runs,
    artifactsBehind,
    artifactsNeedingContent,
  };
}
