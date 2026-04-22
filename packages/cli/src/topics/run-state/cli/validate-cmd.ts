/**
 * `run-state validate <file>` — validate a JSON artifact against its schema.
 *
 * Mirrors Python `cmd_validate`:
 *   - stringified errors go to stderr, one per line
 *   - exit 2 when any finding has severity=error (Python: `sys.exit(2)`)
 *   - stdout prints `ok: <file>` on success
 *
 * `--strict` promotes warnings to errors at the validator-engine layer.
 */

import { validateFile } from '../validate';

export interface ValidateFlags {
  kind?: string;
  strict?: boolean;
}

export function runValidate(file: string, flags: ValidateFlags): number {
  if (!file) {
    console.error('error: the following arguments are required: file');
    return 1;
  }
  const result = validateFile(file, flags.kind, flags.strict ?? false);
  for (const e of result.errors) {
    console.error(e);
  }
  if (!result.ok) return 2;
  console.log(`ok: ${file}`);
  return 0;
}
