/**
 * `prove install init-config` — write `.claude/.prove.json` with detected validators.
 *
 * Auto-detects stack validators (Go, Rust, Python, Node/TS, Godot,
 * Makefile) via `@claude-prove/cli/schema/detect` and emits a schema-
 * versioned config. Idempotent: no-op when the file already exists,
 * unless `--force` is passed.
 */

import { join, resolve } from 'node:path';
import { bootstrapProveJson } from '@claude-prove/installer';

export interface InitConfigOptions {
  cwd?: string;
  force: boolean;
}

export function runInitConfig(opts: InitConfigOptions): number {
  const cwd = resolve(opts.cwd ?? process.cwd());
  bootstrapProveJson(cwd, { force: opts.force });

  const target = join(cwd, '.claude', '.prove.json');
  console.log(`prove install init-config: bootstrapped ${target}`);
  return 0;
}
