/**
 * Cloud database provisioning for the optional Turso sync layer.
 *
 * `provisionDatabase` is the engine half of `claude-prove store provision`: it
 * idempotently creates the project's cloud database `prove-<slug>` in a group,
 * mints a least-privilege db-scoped sync token, and writes that token into the
 * gitignored machine config (`~/.claude-prove/config.json`). It NEVER writes a
 * token into the committed `.prove.json` — only the non-secret
 * `{ enabled, org, group, db_name }` block lives there.
 *
 * Least-privilege boundary:
 *   - The org Platform API token is the ADMIN bootstrap secret. It is read from
 *     the environment (default `TURSO_PLATFORM_TOKEN`), never persisted by prove,
 *     and is the only credential that can create databases or mint tokens.
 *   - The token this command writes to the machine config is scoped to exactly
 *     ONE database (`createToken(dbName, ...)`), so a contributor's machine
 *     holds only its own db-scoped token — never the org admin secret, never
 *     another db's token.
 *
 * Idempotency: provision is safe to re-run. Database creation is skipped when
 * the db already exists (probed via `databases.get`), and a fresh db-scoped
 * token is always minted and written, so a re-run on a machine that lost its
 * token re-establishes access without recreating the database.
 *
 * The `@tursodatabase/api` client is injected through `ProvisionDeps` so the
 * config-write + idempotency behavior is unit-testable with a stubbed client —
 * the live provision is a runtime op gated on a configured org Platform token.
 */

import { createClient } from '@tursodatabase/api';
import { setCloudToken } from './machine-config';

/** Default environment variable holding the org Platform API token. */
export const PLATFORM_TOKEN_ENV_VAR = 'TURSO_PLATFORM_TOKEN';

/** Default group databases are provisioned into. */
export const DEFAULT_GROUP = 'prove';

/**
 * Narrow structural slice of `@tursodatabase/api` that provisioning depends on.
 * Declaring it locally (rather than importing the client class shape) keeps the
 * injection seam minimal and lets tests pass a hand-rolled stub.
 */
export interface TursoApiClient {
  databases: {
    /** Resolve a database by name. Rejects (typically 404) when absent. */
    get(dbName: string): Promise<{ name: string; hostname: string }>;
    /** Create a database in a group. */
    create(dbName: string, options?: { group?: string }): Promise<{ name: string }>;
    /** Mint a token. Scoped to the named db; `full-access` for read+write sync. */
    createToken(
      dbName: string,
      options?: { authorization?: 'read-only' | 'full-access' },
    ): Promise<{ jwt: string }>;
  };
}

/** Factory the engine calls to build a client from org + token. */
export type CreateApiClient = (config: { org: string; token: string }) => TursoApiClient;

/** Injectable dependencies — defaults wire the real `@tursodatabase/api`. */
export interface ProvisionDeps {
  /** Build the Turso API client. Default: `@tursodatabase/api`'s `createClient`. */
  createClient: CreateApiClient;
  /** Read the org Platform API token. Default: from `PLATFORM_TOKEN_ENV_VAR`. */
  readPlatformToken: () => string | null;
  /** Persist the minted db-scoped token. Default: `setCloudToken` (machine config). */
  writeCloudToken: (dbName: string, token: string) => void;
}

/** What the caller must supply to provision a project's cloud database. */
export interface ProvisionInput {
  /** Turso organization slug that owns the database. */
  org: string;
  /** Cloud database name (e.g. `prove-<slug>`). */
  dbName: string;
  /** Group the database lives in. Defaults to `DEFAULT_GROUP`. */
  group?: string;
}

/** Outcome of a provision run — reported on the command's stderr trailer. */
export interface ProvisionResult {
  /** The provisioned database name. */
  dbName: string;
  /** The group it lives in. */
  group: string;
  /** True when this run created the database; false when it already existed. */
  created: boolean;
  /** True — a db-scoped token was minted and written to the machine config. */
  tokenWritten: boolean;
}

/** Thrown for actionable provisioning failures (missing token, API error). */
export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/** Default deps: real API client, env-sourced platform token, machine-config write. */
function defaultDeps(): ProvisionDeps {
  return {
    createClient: (config) => createClient(config) as unknown as TursoApiClient,
    readPlatformToken: () => {
      const token = process.env[PLATFORM_TOKEN_ENV_VAR];
      return token !== undefined && token.length > 0 ? token : null;
    },
    writeCloudToken: (dbName, token) => setCloudToken(dbName, token),
  };
}

/**
 * Provision the project's cloud database and mint its machine-local db-scoped
 * token. Idempotent and least-privilege (see module docstring). Throws
 * `ProvisionError` when the org Platform token is absent or the API rejects.
 *
 * `deps` is partially overridable — any unset field falls back to its real
 * default, so tests inject only the client factory and a tmp-dir token writer.
 */
export async function provisionDatabase(
  input: ProvisionInput,
  deps: Partial<ProvisionDeps> = {},
): Promise<ProvisionResult> {
  const {
    createClient: makeClient,
    readPlatformToken,
    writeCloudToken,
  } = {
    ...defaultDeps(),
    ...deps,
  };

  const org = input.org.trim();
  const dbName = input.dbName.trim();
  const group = (input.group ?? DEFAULT_GROUP).trim();
  if (org.length === 0) throw new ProvisionError('cloud.org is required to provision');
  if (dbName.length === 0) throw new ProvisionError('cloud.db_name is required to provision');

  const platformToken = readPlatformToken();
  if (platformToken === null) {
    throw new ProvisionError(
      `no org Platform API token — set ${PLATFORM_TOKEN_ENV_VAR}. The Platform token is the admin bootstrap secret; it is read from the environment and never written to disk by prove.`,
    );
  }

  const client = makeClient({ org, token: platformToken });

  // Idempotency: skip create when the database already exists. `get` rejects
  // (404) for an absent db; any other rejection (auth, network) is a real
  // failure and must surface, so only a "not found"-class rejection falls
  // through to create.
  const exists = await databaseExists(client, dbName);
  let created = false;
  if (!exists) {
    try {
      await client.databases.create(dbName, { group });
      created = true;
    } catch (err) {
      throw new ProvisionError(
        `failed to create database '${dbName}' in group '${group}': ${errMsg(err)}`,
      );
    }
  }

  // Always mint + persist a fresh db-scoped token: a re-run on a machine that
  // lost its token re-establishes access without recreating the database. The
  // token is scoped to this one db (least-privilege) and written ONLY to the
  // gitignored machine config — never to .prove.json.
  let jwt: string;
  try {
    const token = await client.databases.createToken(dbName, { authorization: 'full-access' });
    jwt = token.jwt;
  } catch (err) {
    throw new ProvisionError(`failed to mint db-scoped token for '${dbName}': ${errMsg(err)}`);
  }
  if (jwt.length === 0) {
    throw new ProvisionError(`minted an empty token for '${dbName}'`);
  }
  writeCloudToken(dbName, jwt);

  return { dbName, group, created, tokenWritten: true };
}

/**
 * Probe whether a database exists via `databases.get`. Resolves true on
 * success, false when the API reports the db is absent (a 404-class
 * rejection). Re-throws non-404 rejections (auth/network) so a transient or
 * permission failure is never mistaken for "absent" and silently recreated.
 */
async function databaseExists(client: TursoApiClient, dbName: string): Promise<boolean> {
  try {
    await client.databases.get(dbName);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw new ProvisionError(`failed to look up database '${dbName}': ${errMsg(err)}`);
  }
}

/**
 * True when an error is a "database not found" signal. `@tursodatabase/api`
 * surfaces a `TursoClientError` carrying an HTTP `status`; a 404 means absent.
 * Falls back to a message-substring match so a stubbed client (tests) or a
 * client that does not set `status` still reads as not-found.
 */
function isNotFound(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    if (status === 404) return true;
    if (typeof status === 'number') return false;
  }
  return /not found|404|does not exist/i.test(errMsg(err));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
