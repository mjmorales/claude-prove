import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_CONFIG_DIR_ENV_VAR, readMachineConfig, resolveCloudToken } from './machine-config';
import {
  type ProvisionDeps,
  ProvisionError,
  type TursoApiClient,
  provisionDatabase,
} from './provision';

/** Fresh tmp dir standing in for `~/.claude-prove` (the machine-config base seam). */
function makeBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'provision-test-'));
}

/** Records every API + token-write interaction so a test can assert the call graph. */
interface CallLog {
  getCalls: string[];
  createCalls: { dbName: string; group?: string }[];
  tokenCalls: { dbName: string; authorization?: string }[];
  tokenWrites: { dbName: string; token: string }[];
  clientConfigs: { org: string; token: string }[];
}

interface StubOptions {
  /** db names the API reports as already existing (idempotency probe). */
  existing?: string[];
  /** jwt the stub mints for createToken. */
  mintedJwt?: string;
  /** Make `get` throw a non-404 error (auth/network) to test re-throw. */
  getThrowsNon404?: boolean;
}

/**
 * Build a stub `@tursodatabase/api` client plus the matching `ProvisionDeps`
 * overrides (env token present, token writes captured into the log). No real
 * network, no real machine config.
 */
function makeStub(opts: StubOptions = {}): { deps: Partial<ProvisionDeps>; log: CallLog } {
  const existing = new Set(opts.existing ?? []);
  const mintedJwt = opts.mintedJwt ?? 'jwt-db-scoped-xyz';
  const log: CallLog = {
    getCalls: [],
    createCalls: [],
    tokenCalls: [],
    tokenWrites: [],
    clientConfigs: [],
  };

  const client: TursoApiClient = {
    databases: {
      async get(dbName) {
        log.getCalls.push(dbName);
        if (opts.getThrowsNon404) {
          const err = new Error('unauthorized') as Error & { status: number };
          err.status = 401;
          throw err;
        }
        if (!existing.has(dbName)) {
          const err = new Error('database not found') as Error & { status: number };
          err.status = 404;
          throw err;
        }
        return { name: dbName, hostname: `${dbName}.turso.io` };
      },
      async create(dbName, options) {
        log.createCalls.push({ dbName, group: options?.group });
        existing.add(dbName);
        return { name: dbName };
      },
      async createToken(dbName, options) {
        log.tokenCalls.push({ dbName, authorization: options?.authorization });
        return { jwt: mintedJwt };
      },
    },
  };

  const deps: Partial<ProvisionDeps> = {
    createClient: (config) => {
      log.clientConfigs.push(config);
      return client;
    },
    readPlatformToken: () => 'platform-admin-token',
    writeCloudToken: (dbName, token) => {
      log.tokenWrites.push({ dbName, token });
    },
  };

  return { deps, log };
}

describe('provisionDatabase — creation + idempotency', () => {
  test('creates a missing database, mints a db-scoped token, and writes it', async () => {
    const { deps, log } = makeStub({ existing: [] });

    const result = await provisionDatabase(
      { org: 'acme', dbName: 'prove-acme', group: 'prove' },
      deps,
    );

    expect(result).toEqual({
      dbName: 'prove-acme',
      group: 'prove',
      created: true,
      tokenWritten: true,
    });
    // Probed for existence, then created in the right group.
    expect(log.getCalls).toEqual(['prove-acme']);
    expect(log.createCalls).toEqual([{ dbName: 'prove-acme', group: 'prove' }]);
    // Token minted scoped to exactly this db, full-access for read+write sync.
    expect(log.tokenCalls).toEqual([{ dbName: 'prove-acme', authorization: 'full-access' }]);
    expect(log.tokenWrites).toEqual([{ dbName: 'prove-acme', token: 'jwt-db-scoped-xyz' }]);
  });

  test('is idempotent — re-run on an existing db skips create but re-mints the token', async () => {
    const { deps, log } = makeStub({ existing: ['prove-acme'] });

    const result = await provisionDatabase({ org: 'acme', dbName: 'prove-acme' }, deps);

    expect(result.created).toBe(false);
    expect(result.tokenWritten).toBe(true);
    // No create call — the db already exists.
    expect(log.createCalls).toEqual([]);
    // Token is still minted + written so a machine that lost its token recovers.
    expect(log.tokenCalls.length).toBe(1);
    expect(log.tokenWrites.length).toBe(1);
  });

  test('two runs against the same project converge (no second create)', async () => {
    const { deps, log } = makeStub({ existing: [] });

    await provisionDatabase({ org: 'acme', dbName: 'prove-acme' }, deps);
    await provisionDatabase({ org: 'acme', dbName: 'prove-acme' }, deps);

    // Created exactly once across both runs; the stub flips it to existing.
    expect(log.createCalls).toEqual([{ dbName: 'prove-acme', group: 'prove' }]);
    // Token re-minted + re-written each run.
    expect(log.tokenWrites.length).toBe(2);
  });
});

describe('provisionDatabase — least-privilege', () => {
  test('builds the client with the org Platform token, never persists it', async () => {
    const { deps, log } = makeStub({ existing: [] });

    await provisionDatabase({ org: 'acme', dbName: 'prove-acme' }, deps);

    // The admin Platform token is used to build the client...
    expect(log.clientConfigs).toEqual([{ org: 'acme', token: 'platform-admin-token' }]);
    // ...but is NEVER what gets written to the machine config — only the
    // db-scoped jwt is.
    for (const write of log.tokenWrites) {
      expect(write.token).not.toBe('platform-admin-token');
      expect(write.token).toBe('jwt-db-scoped-xyz');
    }
  });

  test('writes the minted token into ~/.claude-prove/config.json keyed by db', async () => {
    const base = makeBaseDir();
    try {
      // Real machine-config write redirected to a tmp base dir; only the
      // client + platform-token reads are stubbed.
      const { deps } = makeStub({ existing: [] });
      const realWriteDeps: Partial<ProvisionDeps> = {
        createClient: deps.createClient,
        readPlatformToken: deps.readPlatformToken,
        // omit writeCloudToken → falls back to the real setCloudToken
      };
      // Point the real machine-config writer at the tmp base via the env seam.
      const prev = process.env[MACHINE_CONFIG_DIR_ENV_VAR];
      process.env[MACHINE_CONFIG_DIR_ENV_VAR] = base;
      try {
        await provisionDatabase({ org: 'acme', dbName: 'prove-acme' }, realWriteDeps);

        // The db-scoped token landed in the machine config under the db key.
        expect(resolveCloudToken('prove-acme', base)).toBe('jwt-db-scoped-xyz');
        // Other top-level keys (default_contributors) are preserved/initialized.
        expect(readMachineConfig(base).cloud_tokens).toEqual({ 'prove-acme': 'jwt-db-scoped-xyz' });
      } finally {
        if (prev === undefined) delete process.env[MACHINE_CONFIG_DIR_ENV_VAR];
        else process.env[MACHINE_CONFIG_DIR_ENV_VAR] = prev;
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('provisionDatabase — failure modes', () => {
  test('throws ProvisionError when the org Platform token is absent', async () => {
    const { deps } = makeStub({ existing: [] });
    const noToken: Partial<ProvisionDeps> = { ...deps, readPlatformToken: () => null };

    await expect(provisionDatabase({ org: 'acme', dbName: 'prove-acme' }, noToken)).rejects.toThrow(
      ProvisionError,
    );
  });

  test('throws when org or db_name is empty (no client built)', async () => {
    const { deps, log } = makeStub({ existing: [] });

    await expect(provisionDatabase({ org: '', dbName: 'prove-acme' }, deps)).rejects.toThrow(
      ProvisionError,
    );
    await expect(provisionDatabase({ org: 'acme', dbName: '' }, deps)).rejects.toThrow(
      ProvisionError,
    );
    // Never reached the API or a token write.
    expect(log.clientConfigs).toEqual([]);
    expect(log.tokenWrites).toEqual([]);
  });

  test('re-throws a non-404 get failure as a ProvisionError (never treats it as absent)', async () => {
    const { deps, log } = makeStub({ existing: [], getThrowsNon404: true });

    await expect(provisionDatabase({ org: 'acme', dbName: 'prove-acme' }, deps)).rejects.toThrow(
      ProvisionError,
    );
    // An auth failure on the existence probe must NOT silently recreate the db.
    expect(log.createCalls).toEqual([]);
    expect(log.tokenWrites).toEqual([]);
  });

  test('defaults the group to "prove" when unset', async () => {
    const { deps, log } = makeStub({ existing: [] });

    const result = await provisionDatabase({ org: 'acme', dbName: 'prove-acme' }, deps);

    expect(result.group).toBe('prove');
    expect(log.createCalls).toEqual([{ dbName: 'prove-acme', group: 'prove' }]);
  });
});
