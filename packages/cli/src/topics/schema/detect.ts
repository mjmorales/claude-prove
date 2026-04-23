/**
 * Stack-aware validator detection for `.claude/.prove.json` bootstrap.
 *
 * Ported from `scripts/init-config.sh`. Each detector inspects `cwd` for
 * known marker files and emits the validator triples the installer would
 * otherwise have to duplicate. Consumers:
 *   - `@claude-prove/installer` — bootstrapProveJson()
 *   - `prove init` (eventual TS port)
 *
 * Detection rules match the bash source byte-for-byte:
 *   - Go       : go.mod                  -> build + lint + test
 *   - Rust     : Cargo.toml              -> check + clippy + test
 *   - Python   : pyproject.toml|setup.py|requirements.txt
 *                                        -> (ruff|mypy if on PATH) + pytest
 *   - Node/TS  : package.json            -> tsc (if tsconfig) + eslint (if cfg) + npm test
 *   - Godot    : project.godot           -> gut (if addons/gut present)
 *   - Makefile : Makefile                -> make test / make lint (if no earlier
 *                                            detector already emitted that phase)
 *
 * Detectors run in the listed order. Phase de-duplication only applies
 * between the upstream detectors and the Makefile fallback, matching the
 * bash script's behavior.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Single entry emitted into `.claude/.prove.json#validators`.
 *
 * `phase` matches `PROVE_SCHEMA.validators.items.fields.phase.enum` — do
 * not widen without updating the schema.
 */
export interface DetectedValidator {
  name: string;
  command: string;
  phase: 'build' | 'lint' | 'test' | 'custom' | 'llm';
}

/**
 * Names every detector in this module could emit. Consumers (installer
 * `--force` reemit) use this set to distinguish auto-detected entries from
 * user-custom validators that must survive a reemit.
 *
 * Keep in sync with the detectors below. A test asserts the invariant.
 */
export const DETECTED_VALIDATOR_NAMES: readonly string[] = [
  'build',
  'lint',
  'tests',
  'check',
  'clippy',
] as const;

/**
 * Scan `cwd` for stack markers and return the validator entries that a
 * fresh `.claude/.prove.json` should ship with. Returns `[]` when no
 * stack is recognized — caller decides whether to still emit an empty
 * validators array.
 */
export function detectValidators(cwd: string): DetectedValidator[] {
  const validators: DetectedValidator[] = [];

  detectGo(cwd, validators);
  detectRust(cwd, validators);
  detectPython(cwd, validators);
  detectNode(cwd, validators);
  detectGodot(cwd, validators);
  detectMakefile(cwd, validators);

  return validators;
}

function detectGo(cwd: string, out: DetectedValidator[]): void {
  if (!existsSync(join(cwd, 'go.mod'))) return;
  out.push({ name: 'build', command: 'go build ./...', phase: 'build' });
  out.push({ name: 'lint', command: 'go vet ./...', phase: 'lint' });
  out.push({ name: 'tests', command: 'go test ./...', phase: 'test' });
}

function detectRust(cwd: string, out: DetectedValidator[]): void {
  if (!existsSync(join(cwd, 'Cargo.toml'))) return;
  out.push({ name: 'check', command: 'cargo check', phase: 'build' });
  out.push({ name: 'clippy', command: 'cargo clippy -- -D warnings', phase: 'lint' });
  out.push({ name: 'tests', command: 'cargo test', phase: 'test' });
}

function detectPython(cwd: string, out: DetectedValidator[]): void {
  const hasPython =
    existsSync(join(cwd, 'pyproject.toml')) ||
    existsSync(join(cwd, 'setup.py')) ||
    existsSync(join(cwd, 'requirements.txt'));
  if (!hasPython) return;

  // Matches bash: prefer ruff over mypy, neither if both absent. Missing
  // binary => skip rather than emit a command that will always fail.
  if (isOnPath('ruff')) {
    out.push({ name: 'lint', command: 'ruff check .', phase: 'lint' });
  } else if (isOnPath('mypy')) {
    out.push({ name: 'lint', command: 'mypy .', phase: 'lint' });
  }
  out.push({ name: 'tests', command: 'pytest', phase: 'test' });
}

function detectNode(cwd: string, out: DetectedValidator[]): void {
  if (!existsSync(join(cwd, 'package.json'))) return;

  if (existsSync(join(cwd, 'tsconfig.json'))) {
    out.push({ name: 'build', command: 'tsc --noEmit', phase: 'build' });
  }
  if (hasEslintConfig(cwd)) {
    out.push({ name: 'lint', command: 'npx eslint .', phase: 'lint' });
  }
  out.push({ name: 'tests', command: 'npm test', phase: 'test' });
}

function detectGodot(cwd: string, out: DetectedValidator[]): void {
  if (!existsSync(join(cwd, 'project.godot'))) return;
  // GUT is the only supported runner. Projects without addons/gut get no
  // test validator — the operator wires one up manually.
  if (existsSync(join(cwd, 'addons', 'gut'))) {
    out.push({
      name: 'tests',
      command: 'godot --headless -s addons/gut/gut_cmdln.gd',
      phase: 'test',
    });
  }
}

function detectMakefile(cwd: string, out: DetectedValidator[]): void {
  const makefile = join(cwd, 'Makefile');
  if (!existsSync(makefile)) return;

  // Makefile is a fallback: only fill phases no upstream detector claimed.
  const contents = readFileSync(makefile, 'utf8');
  const hasTestTarget = /^test:/m.test(contents);
  const hasLintTarget = /^lint:/m.test(contents);

  const phases = new Set(out.map((v) => v.phase));
  if (hasTestTarget && !phases.has('test')) {
    out.push({ name: 'tests', command: 'make test', phase: 'test' });
  }
  if (hasLintTarget && !phases.has('lint')) {
    out.push({ name: 'lint', command: 'make lint', phase: 'lint' });
  }
}

/** ESLint config detection — mirrors the bash script's file list. */
function hasEslintConfig(cwd: string): boolean {
  const candidates = ['.eslintrc.json', '.eslintrc.js', 'eslint.config.js', 'eslint.config.mjs'];
  return candidates.some((name) => existsSync(join(cwd, name)));
}

/**
 * Cheap $PATH lookup. Honors the live `PATH` at call time so tests can
 * shadow the environment without patching the fs.
 */
function isOnPath(binary: string): boolean {
  const path = process.env.PATH;
  if (!path) return false;
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    if (existsSync(join(dir, binary))) return true;
  }
  return false;
}
