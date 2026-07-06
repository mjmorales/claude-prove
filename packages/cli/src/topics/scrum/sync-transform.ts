/**
 * A push replays this writer's own CDC log, so an existence-only duplicate probe
 * matches the mutation's own committed row and silently drops every guarded
 * INSERT from replication — the guard must compare row identity, skipping only
 * a key owned by a different row: the true cross-writer duplicate.
 */

import type { DatabaseRowMutation, DatabaseRowTransformResult } from '@claude-prove/store';

export interface SurfacedCollision {
  table: 'scrum_contributors' | 'scrum_acceptance_criteria';
  key: Record<string, unknown>;
  skipped: Record<string, unknown>;
  existingId: string;
}

export type KeyOwner = (table: string, key: Record<string, unknown>) => string | null;

export interface ScrumSyncTransformOptions {
  keyOwner: KeyOwner;
  onCollision: (collision: SurfacedCollision) => void;
}

const SECONDARY_UNIQUE_KEYS: Record<string, string[]> = {
  scrum_contributors: ['slug'],
  scrum_acceptance_criteria: ['task_id', 'criterion_id'],
};

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
      if (value === null || value === undefined) return null;
      key[column] = value;
    }

    const existingId = opts.keyOwner(mutation.tableName, key);
    if (existingId === null) return null;

    const selfId = after.id;
    if (selfId !== null && selfId !== undefined && String(selfId) === existingId) return null;

    opts.onCollision({
      table: mutation.tableName as SurfacedCollision['table'],
      key,
      skipped: after,
      existingId,
    });
    return { operation: 'skip' };
  };
}
