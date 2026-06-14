/**
 * The scrum-domain `transform` hook for the shipped `@tursodatabase/sync` engine.
 *
 * Under whole-transaction sync replay the engine rewrites every local INSERT
 * into a PK-keyed UPSERT (`INSERT ... ON CONFLICT(<pk cols>) DO UPDATE`). The
 * `ON CONFLICT` target is the PRIMARY KEY columns ONLY — a secondary UNIQUE
 * index gets no clause, so a collision on one raises a raw `UNIQUE constraint
 * failed` that propagates out of `pull()`/`push()` and BLOCKS the operator's
 * sync until resolved. The recovery hook is the engine's one-sided `transform`,
 * fired per CDC mutation before push AND during replay: it sees only the LOCAL
 * mutation (never the conflicting remote row), and returns `skip` to drop the
 * mutation, `rewrite` to replace it, or `null` to keep it.
 *
 * Two scrum secondary-UNIQUEs can collide cross-writer:
 *   - `scrum_acceptance_criteria UNIQUE(task_id, criterion_id)` — auto-generated
 *     criterion ids now carry a random suffix, so this only fires on an explicit
 *     same-id add to the same task from two operators (a true duplicate).
 *   - `scrum_contributors.slug` — the DB-level UNIQUE was DROPPED (scrum v2), so
 *     this no longer raises during replay; the app-layer registry guard enforces
 *     same-store uniqueness. A cross-writer duplicate is surfaced by the post-pull
 *     anomaly pass rather than the transform. The slug mapping is kept here so the
 *     hook degrades gracefully on any legacy v1 store still carrying the UNIQUE.
 *
 * This module DEFINES the mapping; it does NOT open a sync connection. The
 * `cloud-sync-s1-lifecycle` task wires `makeScrumSyncTransform(...)` into the
 * sync `connect()` opts, binding `keyExists` to a SYNCHRONOUS current-state
 * lookup against the live connection (the engine's `transform` callback is
 * synchronous, so the predicate cannot be async — lifecycle supplies a sync
 * `db.prepare(...).get(...)` probe or a pre-pull snapshot set). Every `skip` is
 * recorded through `onCollision` so the anomaly pass can surface it: a collision
 * becomes a surfaced anomaly, never a hard `pull()`/`push()` failure and never a
 * silent drop.
 */

import type { DatabaseRowMutation, DatabaseRowTransformResult } from '@claude-prove/store';

/** A surfaced secondary-UNIQUE collision the anomaly pass reports. */
export interface SurfacedCollision {
  /** The colliding table. */
  table: 'scrum_contributors' | 'scrum_acceptance_criteria';
  /** The secondary-UNIQUE key tuple that collided, as `column → value`. */
  key: Record<string, unknown>;
  /** The local row the transform skipped (its post-image). */
  skipped: Record<string, unknown>;
}

/**
 * Synchronous predicate: does a row with the given secondary-UNIQUE key already
 * exist in the current (post-pull) local state? The engine's transform callback
 * is synchronous, so lifecycle binds this to a sync probe of the live connection
 * (or a snapshot). `null`/missing column values never match.
 */
export type KeyExists = (table: string, key: Record<string, unknown>) => boolean;

export interface ScrumSyncTransformOptions {
  /** Current-state existence probe (lifecycle binds it to the live connection). */
  keyExists: KeyExists;
  /** Sink for each surfaced collision, drained by the post-pull anomaly pass. */
  onCollision: (collision: SurfacedCollision) => void;
}

/** The secondary-UNIQUE key columns this hook guards, per table. */
const SECONDARY_UNIQUE_KEYS: Record<string, string[]> = {
  scrum_contributors: ['slug'],
  scrum_acceptance_criteria: ['task_id', 'criterion_id'],
};

/**
 * Build the scrum `transform` hook. The returned function matches the shipped
 * `@tursodatabase/sync` `Transform` signature exactly. For an INSERT carrying a
 * secondary-UNIQUE key that already exists in current state, it records the
 * collision and returns `skip` (the losing writer's row is dropped from the
 * replay, sync proceeds, and the anomaly pass surfaces it for deconfliction).
 * Every other mutation passes through unchanged (`null`).
 *
 * Only INSERTs are guarded: an UPDATE/DELETE targets an existing PK row and
 * cannot introduce a NEW secondary-UNIQUE collision the engine's PK conflict
 * clause does not already absorb.
 */
export function makeScrumSyncTransform(
  opts: ScrumSyncTransformOptions,
): (mutation: DatabaseRowMutation) => DatabaseRowTransformResult {
  return (mutation: DatabaseRowMutation): DatabaseRowTransformResult => {
    if (mutation.changeType !== 'insert') return null;

    const keyColumns = SECONDARY_UNIQUE_KEYS[mutation.tableName];
    if (keyColumns === undefined) return null;

    const after = mutation.after;
    if (after === undefined) return null;

    const key: Record<string, unknown> = {};
    for (const column of keyColumns) {
      const value = after[column];
      // A null/absent key column cannot collide on a UNIQUE (SQLite treats
      // distinct NULLs as non-equal), so keep the mutation as-is.
      if (value === null || value === undefined) return null;
      key[column] = value;
    }

    if (!opts.keyExists(mutation.tableName, key)) return null;

    opts.onCollision({
      table: mutation.tableName as SurfacedCollision['table'],
      key,
      skipped: after,
    });
    return { operation: 'skip' };
  };
}
