/**
 * Tests for the `store` topic's cloud-replica soft-warning on `store migrate`.
 *
 * The slice ships a SOFT warning (not a hard refuse) when `store migrate` runs
 * against a cloud replica — a project whose `.prove.json` sets `cloud.enabled`
 * AND whose machine holds a db-scoped token. The strict refuse is a later slice.
 *
 * The machine-config token is redirected to a tmp dir via
 * `CLAUDE_PROVE_MACHINE_CONFIG_DIR`, so these tests never touch the real home
 * config and never open a real cloud connection.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_CONFIG_DIR_ENV_VAR, setCloudToken } from '@claude-prove/store';
import { replicaMigrateWarning } from './store';

let dirs: string[] = [];
let savedConfigDir: string | undefined;

beforeEach(() => {
  dirs = [];
  savedConfigDir = process.env[MACHINE_CONFIG_DIR_ENV_VAR];
  const configDir = mkdtempSync(join(tmpdir(), 'store-test-cfg-'));
  dirs.push(configDir);
  process.env[MACHINE_CONFIG_DIR_ENV_VAR] = configDir;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env[MACHINE_CONFIG_DIR_ENV_VAR];
  else process.env[MACHINE_CONFIG_DIR_ENV_VAR] = savedConfigDir;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A project root with a `.prove.json` cloud block and a `.prove/prove.db` path. */
function makeProject(cloud?: Record<string, unknown> | false): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'store-test-proj-'));
  dirs.push(root);
  mkdirSync(join(root, '.claude'), { recursive: true });
  const body: Record<string, unknown> = { schema_version: '12' };
  if (cloud !== false && cloud !== undefined) body.cloud = cloud;
  writeFileSync(join(root, '.claude', '.prove.json'), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return { root, dbPath: join(root, '.prove', 'prove.db') };
}

const CLOUD_ON = { enabled: true, org: 'acme', group: 'prove', db_name: 'prove-acme' };

describe('replicaMigrateWarning', () => {
  test('cloud enabled + token present: returns a soft warning naming the db', () => {
    const { dbPath } = makeProject(CLOUD_ON);
    setCloudToken('prove-acme', 'db-scoped-token');

    const warning = replicaMigrateWarning(dbPath);
    expect(warning).not.toBeNull();
    expect(warning).toContain('prove-acme');
    expect(warning).toContain('warning');
    // SOFT, not a refusal — the migration still proceeds.
    expect(warning).toContain('Proceeding');
  });

  test('cloud enabled but NO token on this machine: no warning (not a replica yet)', () => {
    const { dbPath } = makeProject(CLOUD_ON);
    // No setCloudToken — this machine has not provisioned.
    expect(replicaMigrateWarning(dbPath)).toBeNull();
  });

  test('cloud.enabled false: no warning (local-only project)', () => {
    const { dbPath } = makeProject({ ...CLOUD_ON, enabled: false });
    setCloudToken('prove-acme', 'db-scoped-token');
    expect(replicaMigrateWarning(dbPath)).toBeNull();
  });

  test('no cloud block at all: no warning', () => {
    const { dbPath } = makeProject(false);
    expect(replicaMigrateWarning(dbPath)).toBeNull();
  });
});
