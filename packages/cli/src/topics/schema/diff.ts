/**
 * Human-readable diff between current config and schema-compliant target.
 *
 * Ported 1:1 from `tools/schema/diff.py`. Two exports:
 *   - `configDiff(path)` — renders a validation + migration report for a
 *     single config file. Output is a newline-joined string matching the
 *     Python source line-for-line.
 *   - `summary(provePath, settingsPath)` — concatenates `configDiff` for
 *     the prove and settings configs, inserting a placeholder for any
 *     missing file.
 *
 * Auto-detection of schema (prove vs settings) mirrors the Python
 * filename/path rules. Migration section only renders for `.prove.json`
 * files; settings files skip the plan and print a plain "valid" line when
 * there are no errors.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { planMigration } from './migrate';
import { PROVE_SCHEMA, type Schema, SETTINGS_SCHEMA } from './schemas';
import { validateConfig } from './validate';

/**
 * Generate a human-readable diff report for a config file. The output
 * shows validation errors, the migration plan (prove configs only), and a
 * JSON dump of the post-migration target config when changes exist.
 */
export function configDiff(path: string): string {
  if (!existsSync(path)) {
    return `File not found: ${path}`;
  }

  const raw = readFileSync(path, 'utf8');
  const config = JSON.parse(raw) as Record<string, unknown>;

  const detection = detectSchema(path);
  if (detection === null) {
    return `Cannot auto-detect schema for ${path}`;
  }
  const { schema, label, isProve } = detection;

  const lines: string[] = [];
  lines.push(`=== Config Diff: ${label} ===`);
  lines.push('');

  const errors = validateConfig(config, schema);
  if (errors.length > 0) {
    lines.push('Validation Issues:');
    for (const e of errors) {
      lines.push(e.toString());
    }
    lines.push('');
  }

  if (isProve) {
    const [target, changes] = planMigration(config);
    if (changes.length > 0) {
      lines.push('Migration Changes:');
      for (const c of changes) {
        lines.push(c.toString());
      }
      lines.push('');
      lines.push('Target config after migration:');
      lines.push(JSON.stringify(target, null, 2));
    } else {
      lines.push('Config is up to date (no migration needed).');
    }
  } else if (errors.length === 0) {
    lines.push('Config is valid (no issues found).');
  }

  return lines.join('\n');
}

/**
 * Generate a combined summary for both config files. Missing files render
 * a placeholder instead of calling `configDiff`, matching the Python
 * `Path.exists()` flow.
 */
export function summary(
  provePath = '.claude/.prove.json',
  settingsPath = '.claude/settings.json',
): string {
  const parts: string[] = [];
  for (const path of [provePath, settingsPath]) {
    if (existsSync(path)) {
      parts.push(configDiff(path));
    } else {
      parts.push(`=== ${path} ===\nNot found (will be created by /prove:init)`);
    }
  }
  return parts.join('\n\n');
}

// --- internals ---

interface SchemaDetection {
  schema: Schema;
  label: string;
  isProve: boolean;
}

function detectSchema(path: string): SchemaDetection | null {
  const name = basename(path);
  if (name === '.prove.json' || path.endsWith('.claude/.prove.json')) {
    return { schema: PROVE_SCHEMA, label: '.claude/.prove.json', isProve: true };
  }
  if (name === 'settings.json' && path.includes('.claude')) {
    return { schema: SETTINGS_SCHEMA, label: '.claude/settings.json', isProve: false };
  }
  return null;
}
