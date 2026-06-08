/**
 * Shared-view parity: the CLI store boundary and the review-ui server must
 * return the IDENTICAL derived set for ready-eligible and current-operator,
 * because both read ONE shared SQL view — `scrum_ready_eligible` for the base
 * actionable task set and `scrum_current_operator` for the operator-of-record
 * holder. Neither surface re-derives the base predicate in TS.
 *
 * Each test seeds a tmpdir-rooted store via `ScrumStore`, then compares the
 * value the CLI reader returns (`readyEligibleIds` / `currentOperator`) against
 * the value the review-ui HTTP route returns over the same store. Equal sets
 * prove the single shared definition is consumed by both.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ScrumStore, openScrumStore } from '@claude-prove/cli/scrum/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeProjectResolver } from '../src/projects';
import { registerScrumRoutes } from '../src/scrum';

let repoRoot: string;
let dbFile: string;
let app: FastifyInstance;

beforeAll(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'prove-scrum-parity-'));
  mkdirSync(join(repoRoot, '.prove'), { recursive: true });
  dbFile = join(repoRoot, '.prove/prove.db');

  const store = await openScrumStore({ override: dbFile });
  try {
    // Mixed task statuses so the eligible view does real filtering: two
    // ready/backlog rows survive; an in_progress row and a soft-deleted ready
    // row are excluded.
    await store.createTask({ id: 'ready-1', title: 'R1', status: 'ready' });
    await store.createTask({ id: 'backlog-1', title: 'B1', status: 'backlog' });
    await store.createTask({ id: 'wip-1', title: 'W1', status: 'backlog' });
    await store.updateTaskStatus('wip-1', 'ready');
    await store.updateTaskStatus('wip-1', 'in_progress');
    await store.createTask({ id: 'deleted-ready', title: 'D1', status: 'ready' });
    await store.softDeleteTask('deleted-ready');

    // One operator transfer so the current-operator view excludes the closed
    // jane interval and surfaces only the open bob interval.
    const jane = await store.registerContributor({ slug: 'jane' });
    const bob = await store.registerContributor({ slug: 'bob' });
    await store.setOperatorOfRecord({ contributorId: jane.id, fromTs: '2026-01-01T00:00:00Z' });
    await store.setOperatorOfRecord({ contributorId: bob.id, fromTs: '2026-03-01T00:00:00Z' });
  } finally {
    store.close();
  }

  app = Fastify({ logger: false });
  registerScrumRoutes(app, makeProjectResolver(repoRoot));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(repoRoot, { recursive: true, force: true });
});

async function withCliStore<T>(fn: (store: ScrumStore) => Promise<T>): Promise<T> {
  const store = await openScrumStore({ override: dbFile });
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

describe('shared-view parity — ready-eligible', () => {
  test('CLI readyEligibleIds and the review-ui route return the identical set', async () => {
    const cliIds = (await withCliStore((store) => store.readyEligibleIds())).slice().sort();

    const res = await app.inject({ method: 'GET', url: '/api/scrum/ready-eligible' });
    expect(res.statusCode).toBe(200);
    const routeIds = (res.json() as { ids: string[] }).ids.slice().sort();

    // The shared scrum_ready_eligible view: ready + backlog, non-deleted only.
    expect(routeIds).toEqual(['backlog-1', 'ready-1']);
    expect(routeIds).toEqual(cliIds);
  });
});

describe('shared-view parity — current-operator', () => {
  test('CLI currentOperator and the review-ui route resolve the identical holder', async () => {
    const cliHolder = await withCliStore((store) => store.currentOperator());

    const res = await app.inject({ method: 'GET', url: '/api/scrum/current-operator' });
    expect(res.statusCode).toBe(200);
    const routeHolder = (res.json() as { operator: { id: string; slug: string } | null }).operator;

    // The shared scrum_current_operator view surfaces only the open interval —
    // bob, not the closed jane interval.
    expect(routeHolder?.slug).toBe('bob');
    expect(routeHolder?.id).toBe(cliHolder?.id ?? null);
  });
});
