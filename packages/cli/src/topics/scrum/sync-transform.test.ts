import { describe, expect, test } from 'bun:test';
import type { DatabaseRowMutation } from '@claude-prove/store';
import { type SurfacedCollision, makeScrumSyncTransform } from './sync-transform';

/** Build a minimal CDC mutation for the transform under test. */
function mutation(over: Partial<DatabaseRowMutation>): DatabaseRowMutation {
  return {
    changeTime: 0,
    tableName: 'scrum_contributors',
    id: 1,
    changeType: 'insert' as DatabaseRowMutation['changeType'],
    ...over,
  };
}

describe('makeScrumSyncTransform', () => {
  test('skips a contributor INSERT whose slug already exists, surfacing the collision', () => {
    const surfaced: SurfacedCollision[] = [];
    const transform = makeScrumSyncTransform({
      keyExists: (table, key) => table === 'scrum_contributors' && key.slug === 'dup',
      onCollision: (c) => surfaced.push(c),
    });

    const result = transform(
      mutation({
        tableName: 'scrum_contributors',
        after: { id: 'ct-B', slug: 'dup', status: 'active' },
      }),
    );

    expect(result).toEqual({ operation: 'skip' });
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toEqual({
      table: 'scrum_contributors',
      key: { slug: 'dup' },
      skipped: { id: 'ct-B', slug: 'dup', status: 'active' },
    });
  });

  test('keeps a contributor INSERT whose slug is unique (null result, no surface)', () => {
    const surfaced: SurfacedCollision[] = [];
    const transform = makeScrumSyncTransform({
      keyExists: () => false,
      onCollision: (c) => surfaced.push(c),
    });

    const result = transform(
      mutation({ tableName: 'scrum_contributors', after: { id: 'ct-A', slug: 'unique' } }),
    );

    expect(result).toBeNull();
    expect(surfaced).toHaveLength(0);
  });

  test('skips a criterion INSERT colliding on the composite (task_id, criterion_id)', () => {
    const surfaced: SurfacedCollision[] = [];
    const transform = makeScrumSyncTransform({
      keyExists: (table, key) =>
        table === 'scrum_acceptance_criteria' && key.task_id === 't1' && key.criterion_id === 'c1',
      onCollision: (c) => surfaced.push(c),
    });

    const result = transform(
      mutation({
        tableName: 'scrum_acceptance_criteria',
        after: { id: 'sur-B', task_id: 't1', criterion_id: 'c1', text: 'B' },
      }),
    );

    expect(result).toEqual({ operation: 'skip' });
    expect(surfaced[0]?.key).toEqual({ task_id: 't1', criterion_id: 'c1' });
  });

  test('passes through non-insert mutations and unguarded tables unchanged', () => {
    const transform = makeScrumSyncTransform({
      keyExists: () => true,
      onCollision: () => {
        throw new Error('should not surface on an unguarded mutation');
      },
    });

    expect(
      transform(
        mutation({
          changeType: 'update' as DatabaseRowMutation['changeType'],
          after: { slug: 'dup' },
        }),
      ),
    ).toBeNull();
    expect(
      transform(
        mutation({
          changeType: 'delete' as DatabaseRowMutation['changeType'],
          after: { slug: 'dup' },
        }),
      ),
    ).toBeNull();
    expect(transform(mutation({ tableName: 'scrum_tasks', after: { id: 't1' } }))).toBeNull();
  });

  test('keeps an INSERT with a null key column (a NULL never collides on UNIQUE)', () => {
    const transform = makeScrumSyncTransform({
      keyExists: () => true,
      onCollision: () => {
        throw new Error('should not surface when the key column is null');
      },
    });

    // Missing `after` and a null slug both decline to a passthrough.
    expect(transform(mutation({ tableName: 'scrum_contributors', after: undefined }))).toBeNull();
    expect(
      transform(mutation({ tableName: 'scrum_contributors', after: { id: 'ct', slug: null } })),
    ).toBeNull();
  });
});
