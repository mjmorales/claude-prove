/**
 * Register the `schema` topic on the cac instance.
 *
 * Follows the `store.ts` pattern: cac dispatches on the first positional
 * arg, so every sub-action lives under a single `schema <action>` command
 * with an action enum. Users invoke the natural form:
 *   prove schema validate --file <path> [--strict]
 *   prove schema migrate  --file <path> [--dry-run]
 *   prove schema diff     --file <path>
 *   prove schema summary
 *
 * Semantics mirror `tools/schema/__main__.py`:
 *   - validate: default file `.claude/.prove.json`; stdout prints errors
 *     (plus PASS/FAIL summary); exit 1 on errors, 0 otherwise.
 *   - migrate: default file `.claude/.prove.json`; `--dry-run` prints
 *     the plan without touching the file; applied runs log the backup
 *     path and change list.
 *   - diff: prints `configDiff(path)` to stdout.
 *   - summary: prints `summary()` for the two canonical config paths.
 */

import type { CAC } from 'cac';
import { readFileSync } from 'node:fs';
import { configDiff, summary } from './schema/diff';
import {
  applyMigration,
  detectVersion,
  planMigration,
  type ProveConfig,
} from './schema/migrate';
import { CURRENT_SCHEMA_VERSION } from './schema/schemas';
import { validateFile } from './schema/validate';

type SchemaAction = 'validate' | 'migrate' | 'diff' | 'summary';

const SCHEMA_ACTIONS: SchemaAction[] = ['validate', 'migrate', 'diff', 'summary'];

interface SchemaFlags {
  file?: string;
  strict?: boolean;
  dryRun?: boolean;
}

const DEFAULT_PROVE_PATH = '.claude/.prove.json';
const DEFAULT_SETTINGS_PATH = '.claude/settings.json';

export function register(cli: CAC): void {
  cli
    .command(
      'schema <action>',
      'Schema config operations (action: validate | migrate | diff | summary)',
    )
    .option(
      '--file <path>',
      'Target config file (default: .claude/.prove.json for validate/migrate/diff)',
    )
    .option('--strict', 'Promote warnings to errors (validate only)')
    .option('--dry-run', 'Plan migration without writing files (migrate only)')
    .action((action: string, flags: SchemaFlags) => {
      if (!isSchemaAction(action)) {
        console.error(
          `prove schema: unknown action '${action}'. expected one of: ${SCHEMA_ACTIONS.join(', ')}`,
        );
        process.exit(1);
      }
      const code = dispatch(action, flags);
      process.exit(code);
    });
}

function isSchemaAction(value: string): value is SchemaAction {
  return (SCHEMA_ACTIONS as string[]).includes(value);
}

function dispatch(action: SchemaAction, flags: SchemaFlags): number {
  switch (action) {
    case 'validate':
      return cmdValidate(flags);
    case 'migrate':
      return cmdMigrate(flags);
    case 'diff':
      return cmdDiff(flags);
    case 'summary':
      return cmdSummary();
  }
}

function cmdValidate(flags: SchemaFlags): number {
  const path = flags.file ?? DEFAULT_PROVE_PATH;
  const { config, errors } = validateFile(path, undefined, flags.strict ?? false);

  if (config === null) {
    for (const e of errors) {
      console.log(e.toString());
    }
    return 1;
  }

  const errCount = errors.filter((e) => e.severity === 'error').length;
  const warnCount = errors.filter((e) => e.severity === 'warning').length;

  if (errors.length > 0) {
    for (const e of errors) {
      console.log(e.toString());
    }
    console.log('');
  }

  if (errCount > 0) {
    console.log(`FAIL: ${errCount} error(s), ${warnCount} warning(s)`);
    return 1;
  }

  const version = detectVersion(config);
  console.log(`PASS: ${path} is valid (schema v${version}, ${warnCount} warning(s))`);
  return 0;
}

function cmdMigrate(flags: SchemaFlags): number {
  const path = flags.file ?? DEFAULT_PROVE_PATH;

  if (flags.dryRun) {
    let config: ProveConfig;
    try {
      config = JSON.parse(readFileSync(path, 'utf8')) as ProveConfig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`prove schema: ${msg}`);
      return 1;
    }

    const [, changes] = planMigration(config);
    if (changes.length === 0) {
      console.log(`No migration needed — ${path} is at schema v${CURRENT_SCHEMA_VERSION}`);
      return 0;
    }
    console.log(
      `Migration plan for ${path} (v${detectVersion(config)} -> v${CURRENT_SCHEMA_VERSION}):`,
    );
    for (const c of changes) {
      console.log(c.toString());
    }
    return 0;
  }

  let result: ReturnType<typeof applyMigration>;
  try {
    result = applyMigration(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`prove schema: ${msg}`);
    return 1;
  }

  if (result.changes.length === 0) {
    console.log(`No migration needed — ${path} is at schema v${CURRENT_SCHEMA_VERSION}`);
    return 0;
  }

  console.log(`Migrated ${path} (backup: ${result.backupPath}):`);
  for (const c of result.changes) {
    console.log(c.toString());
  }
  return 0;
}

function cmdDiff(flags: SchemaFlags): number {
  const path = flags.file ?? DEFAULT_PROVE_PATH;
  console.log(configDiff(path));
  return 0;
}

function cmdSummary(): number {
  console.log(summary(DEFAULT_PROVE_PATH, DEFAULT_SETTINGS_PATH));
  return 0;
}
