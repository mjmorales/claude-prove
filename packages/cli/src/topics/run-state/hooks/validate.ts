/**
 * PostToolUse hook — validates `.prove/runs/**` JSON writes against schema.
 *
 * Fires on Write/Edit/MultiEdit. If the written file lives under any
 * `.prove/runs/` ancestor AND matches a known kind (prd/plan/state/report),
 * the file is parsed and validated via `validateFile`. Schema errors are
 * surfaced to Claude as a `decision: "block"` payload so the agent can
 * self-correct.
 *
 * Non-matching writes exit 0 silently.
 *
 * Port of `tools/run_state/hook_validate.py`.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { inferKind } from '../schemas';
import { validateFile } from '../validate';
import { pyJsonDump } from './json-compat';
import { EMPTY_HOOK_RESULT, type HookResult, readFilePathField, readToolName } from './types';

const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function isRunArtifact(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/.prove/runs/');
}

/**
 * Python's hook message lines errors as `  - {path}: {message}`. Our TS
 * validator emits `"  ERROR: <path>: <msg>"` per the shared format; strip
 * the `ERROR: ` prefix before rendering so the user-facing message matches
 * the Python reference byte-for-byte.
 */
function formatFindings(errors: string[]): string[] {
  return errors
    .filter((line) => line.trim().startsWith('ERROR:'))
    .map((line) => {
      const stripped = line.replace(/^\s*ERROR:\s*/, '').trimEnd();
      return `  - ${stripped}`;
    });
}

export function runValidateHook(payload: Record<string, unknown> | null): HookResult {
  if (!payload) return EMPTY_HOOK_RESULT;

  const toolName = readToolName(payload);
  if (!MUTATING_TOOLS.has(toolName)) return EMPTY_HOOK_RESULT;

  const filePath = readFilePathField(payload);
  if (!filePath || !isRunArtifact(filePath)) return EMPTY_HOOK_RESULT;

  const kind = inferKind(filePath);
  if (!kind) return EMPTY_HOOK_RESULT;

  // The file disappeared between the tool call and the hook — nothing to check.
  if (!existsSync(filePath)) return EMPTY_HOOK_RESULT;

  const result = validateFile(filePath, kind);
  if (result.ok) return EMPTY_HOOK_RESULT;

  const lines: string[] = [];
  lines.push(`Schema validation failed for ${basename(filePath)} (${kind}):`);
  lines.push(...formatFindings(result.errors));
  lines.push(
    'Fix the file or revert. state.json must be mutated via ' +
      '`python3 -m tools.run_state step|validator|task ...`.',
  );
  const message = lines.join('\n');

  const body = pyJsonDump({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
    decision: 'block',
    reason: message,
  });

  return { exitCode: 0, stdout: body, stderr: '' };
}
