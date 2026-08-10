/**
 * `claude-prove models set` — declare or amend the `models` block in
 * `.claude/.prove.json`.
 *
 * Only the flags passed are written; omitted flags leave their field
 * untouched, and an explicitly empty value (`--main ""`) clears the field.
 * `--preset <name>` REPLACES the whole block with the named preset's
 * coherent pairing (field flags then override individual fields) — a preset
 * is a tuned whole, so stale leftovers from a prior declaration are not
 * carried into it. The merged document is validated against PROVE_SCHEMA
 * before the write, so an out-of-enum effort or wrong-typed value never
 * lands on disk. This writes the committed recommendation only —
 * materialization into the local settings layer stays a separate
 * `models apply`.
 */

import { renameSync, writeFileSync } from 'node:fs';
import type { ModelsBlock } from '@claude-prove/installer';
import { PROVE_SCHEMA } from '../schema/schemas';
import { validateConfig } from '../schema/validate';
import { readProveJson, resolveModelsContext } from './config';
import { MODEL_PRESETS, PRESET_NAMES } from './presets';

export interface SetOptions {
  cwd?: string;
  preset?: string;
  main?: string;
  advisor?: string;
  /** Comma-separated fallback chain; empty string clears. */
  fallback?: string;
  effort?: string;
}

export function runSet(opts: SetOptions): number {
  if (
    opts.preset === undefined &&
    opts.main === undefined &&
    opts.advisor === undefined &&
    opts.fallback === undefined &&
    opts.effort === undefined
  ) {
    console.error(
      'claude-prove models set: nothing to set — pass --preset or at least one of --main, --advisor, --fallback, --effort',
    );
    return 1;
  }

  let presetBlock: ModelsBlock | undefined;
  if (opts.preset !== undefined) {
    const preset = MODEL_PRESETS[opts.preset];
    if (!preset) {
      console.error(
        `claude-prove models set: unknown preset '${opts.preset}'. expected one of: ${PRESET_NAMES.join(', ')} (see \`claude-prove models presets\`)`,
      );
      return 1;
    }
    presetBlock = preset.block;
  }

  const ctx = resolveModelsContext(opts);
  const { raw, models } = readProveJson(ctx.proveJsonPath);

  const next: ModelsBlock = presetBlock ? { ...presetBlock } : { ...models };
  applyScalar(next, 'main', opts.main);
  applyScalar(next, 'advisor', opts.advisor);
  applyScalar(next, 'effort', opts.effort);
  if (opts.fallback !== undefined) {
    const chain = opts.fallback
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length === 0) {
      Reflect.deleteProperty(next, 'fallback');
    } else {
      next.fallback = chain;
    }
  }

  const nextRaw: Record<string, unknown> = { ...raw };
  if (Object.keys(next).length === 0) {
    Reflect.deleteProperty(nextRaw, 'models');
  } else {
    nextRaw.models = next;
  }

  const errors = validateConfig(nextRaw, PROVE_SCHEMA).filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`claude-prove models set: ${e.path}: ${e.message}`);
    }
    return 1;
  }

  const serialized = `${JSON.stringify(nextRaw, null, 2)}\n`;
  const tmp = `${ctx.proveJsonPath}.tmp.${process.pid}`;
  writeFileSync(tmp, serialized, 'utf8');
  renameSync(tmp, ctx.proveJsonPath);

  if ('models' in nextRaw) {
    const parts = Object.entries(next).map(([k, v]) =>
      Array.isArray(v) ? `${k}=${v.join(',')}` : `${k}=${v}`,
    );
    console.log(`claude-prove models set: ${ctx.proveJsonPath} models { ${parts.join(', ')} }`);
  } else {
    console.log(`claude-prove models set: ${ctx.proveJsonPath} models block cleared`);
  }
  console.log(
    'note: this records the committed recommendation only — run `claude-prove models apply` to materialize it on this machine.',
  );
  return 0;
}

function applyScalar(block: ModelsBlock, key: 'main' | 'advisor' | 'effort', value?: string): void {
  if (value === undefined) return;
  if (value === '') {
    Reflect.deleteProperty(block, key);
    return;
  }
  block[key] = value;
}
