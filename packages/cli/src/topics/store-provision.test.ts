import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProvisionDeps, TursoApiClient } from '@claude-prove/store';
import { readCloudConfig, runProvision } from './store-provision';

/** Fresh tmp dir standing in for a project root. */
function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'store-provision-test-'));
}

/** Write a `.claude/.prove.json` carrying `body` under `root`. */
function writeProveJson(root: string, body: unknown): string {
  const dir = join(root, '.claude');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '.prove.json');
  writeFileSync(path, JSON.stringify(body, null, 2), 'utf8');
  return path;
}

/** Stub deps that count every would-be network touch (client build, token read). */
interface NetworkProbe {
  clientBuilds: number;
  platformTokenReads: number;
  tokenWrites: { dbName: string; token: string }[];
  deps: Partial<ProvisionDeps>;
}

function makeNetworkProbe(): NetworkProbe {
  const probe: NetworkProbe = {
    clientBuilds: 0,
    platformTokenReads: 0,
    tokenWrites: [],
    deps: {},
  };
  const client: TursoApiClient = {
    databases: {
      async get() {
        const err = new Error('database not found') as Error & { status: number };
        err.status = 404;
        throw err;
      },
      async create(dbName) {
        return { name: dbName };
      },
      async createToken() {
        return { jwt: 'jwt-db-scoped' };
      },
    },
  };
  probe.deps = {
    createClient: () => {
      probe.clientBuilds += 1;
      return client;
    },
    readPlatformToken: () => {
      probe.platformTokenReads += 1;
      return 'platform-admin-token';
    },
    writeCloudToken: (dbName, token) => {
      probe.tokenWrites.push({ dbName, token });
    },
  };
  return probe;
}

describe('runProvision — default-off zero-network invariant', () => {
  test('cloud block absent: returns error WITHOUT touching the network', async () => {
    const root = makeWorkspace();
    try {
      writeProveJson(root, { schema_version: '12', tools: {} });
      const probe = makeNetworkProbe();

      const code = await runProvision({ workspaceRoot: root }, probe.deps);

      expect(code).toBe(1);
      // The sync path is dead code: no client built, no platform token read,
      // no token written.
      expect(probe.clientBuilds).toBe(0);
      expect(probe.platformTokenReads).toBe(0);
      expect(probe.tokenWrites).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cloud.enabled false: returns error WITHOUT touching the network', async () => {
    const root = makeWorkspace();
    try {
      writeProveJson(root, {
        schema_version: '12',
        cloud: { enabled: false, org: 'acme', group: 'prove', db_name: 'prove-acme' },
      });
      const probe = makeNetworkProbe();

      const code = await runProvision({ workspaceRoot: root }, probe.deps);

      expect(code).toBe(1);
      expect(probe.clientBuilds).toBe(0);
      expect(probe.platformTokenReads).toBe(0);
      expect(probe.tokenWrites).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('no .prove.json at all: returns error WITHOUT touching the network', async () => {
    const root = makeWorkspace();
    try {
      const probe = makeNetworkProbe();

      const code = await runProvision({ workspaceRoot: root }, probe.deps);

      expect(code).toBe(1);
      expect(probe.clientBuilds).toBe(0);
      expect(probe.platformTokenReads).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runProvision — cloud enabled', () => {
  test('cloud.enabled true: dispatches provision and reports success', async () => {
    const root = makeWorkspace();
    try {
      writeProveJson(root, {
        schema_version: '12',
        cloud: { enabled: true, org: 'acme', group: 'prove', db_name: 'prove-acme' },
      });
      const probe = makeNetworkProbe();

      const code = await runProvision({ workspaceRoot: root }, probe.deps);

      expect(code).toBe(0);
      // Now the network path IS exercised (client built, token written).
      expect(probe.clientBuilds).toBe(1);
      expect(probe.tokenWrites).toEqual([{ dbName: 'prove-acme', token: 'jwt-db-scoped' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the minted token is NEVER written back into .prove.json', async () => {
    const root = makeWorkspace();
    try {
      const provePath = writeProveJson(root, {
        schema_version: '12',
        cloud: { enabled: true, org: 'acme', group: 'prove', db_name: 'prove-acme' },
      });
      const before = readFileSync(provePath, 'utf8');
      const probe = makeNetworkProbe();

      await runProvision({ workspaceRoot: root }, probe.deps);

      // The committed config is byte-identical — the secret went to the machine
      // config (captured in probe.tokenWrites), not here.
      const after = readFileSync(provePath, 'utf8');
      expect(after).toBe(before);
      expect(after).not.toContain('jwt-db-scoped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cloud.enabled true but org missing: ProvisionError -> exit 1', async () => {
    const root = makeWorkspace();
    try {
      writeProveJson(root, {
        schema_version: '12',
        cloud: { enabled: true, group: 'prove', db_name: 'prove-acme' },
      });
      const probe = makeNetworkProbe();

      const code = await runProvision({ workspaceRoot: root }, probe.deps);

      expect(code).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readCloudConfig', () => {
  test('fills group default and reads enabled/org/db_name', () => {
    const root = makeWorkspace();
    try {
      writeProveJson(root, {
        schema_version: '12',
        cloud: { enabled: true, org: 'acme', db_name: 'prove-acme' },
      });
      expect(readCloudConfig(root)).toEqual({
        enabled: true,
        org: 'acme',
        group: 'prove',
        dbName: 'prove-acme',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns null when there is no cloud block', () => {
    const root = makeWorkspace();
    try {
      writeProveJson(root, { schema_version: '12' });
      expect(readCloudConfig(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
