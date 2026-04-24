/**
 * `claude-prove orchestrator review-prompt` — emit the principal-architect review
 * prompt for a completed task worktree.
 *
 * Replaces `skills/orchestrator/scripts/generate-review-prompt.sh`. Reads
 * plan/prd JSON, runs `git diff <base>...HEAD` in the worktree, renders the
 * full review prompt in one pass (no sentinel+awk indirection).
 *
 * Diff resolution matches the retired shell script:
 *   1. `git -C <worktree> diff <base>...HEAD -- .`
 *   2. fallback: `git diff HEAD~1 -- .`
 *   3. fallback: literal `ERROR: Could not generate diff`
 * Each is tried in order; the first that produces non-empty output is used.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ReviewPromptOpts {
  worktreePath: string;
  taskId: string;
  runDir: string;
  baseBranch: string;
}

interface PlanTask {
  id: string;
  title?: string;
  description?: string;
  acceptance_criteria?: string[];
}

interface PlanShape {
  tasks?: PlanTask[];
}

interface PrdShape {
  acceptance_criteria?: string[];
}

export function runReviewPrompt(opts: ReviewPromptOpts): number {
  const plan = readJson<PlanShape>(join(opts.runDir, 'plan.json'));
  const prd = readJson<PrdShape>(join(opts.runDir, 'prd.json'));

  if (!plan || !prd) {
    process.stderr.write(`ERROR: plan.json/prd.json missing under ${opts.runDir}\n`);
    return 1;
  }

  const taskIdStr = String(opts.taskId);
  const task = (plan.tasks ?? []).find((t) => String(t.id) === taskIdStr);
  if (!task) {
    process.stderr.write(`ERROR: task ${taskIdStr} not found\n`);
    return 1;
  }

  const diff = resolveDiff(opts.worktreePath, opts.baseBranch);
  const filesChanged = resolveFilesChanged(opts.worktreePath, opts.baseBranch);

  process.stdout.write(renderReviewPrompt(taskIdStr, task, prd, diff, filesChanged));
  return 0;
}

function resolveDiff(worktree: string, base: string): string {
  const tryDiff = (args: string[]): string => {
    const res = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' });
    if (res.status === 0 && (res.stdout ?? '') !== '') return res.stdout ?? '';
    return '';
  };

  const primary = tryDiff(['diff', `${base}...HEAD`, '--', '.']);
  if (primary) return primary;

  const secondary = tryDiff(['diff', 'HEAD~1', '--', '.']);
  if (secondary) return secondary;

  return 'ERROR: Could not generate diff';
}

function resolveFilesChanged(worktree: string, base: string): string {
  const tryList = (args: string[]): string => {
    const res = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' });
    if (res.status === 0 && (res.stdout ?? '') !== '') return (res.stdout ?? '').trimEnd();
    return '';
  };

  const primary = tryList(['diff', '--name-only', `${base}...HEAD`]);
  if (primary) return primary;

  const secondary = tryList(['diff', '--name-only', 'HEAD~1']);
  if (secondary) return secondary;

  return 'unknown';
}

function renderReviewPrompt(
  taskId: string,
  task: PlanTask,
  prd: PrdShape,
  diff: string,
  filesChanged: string,
): string {
  const ac = task.acceptance_criteria ?? [];
  const prdAc = prd.acceptance_criteria ?? [];

  const sections: string[] = [];
  sections.push(`# Architectural Review: Task ${taskId} — ${task.title ?? ''}`);
  sections.push('');
  sections.push(
    'You are reviewing code produced by an implementation agent. Your job is to ensure',
  );
  sections.push('the code meets quality standards BEFORE it can be merged.');
  sections.push('');
  sections.push('## Review Protocol');
  sections.push('');
  sections.push('Evaluate every item below. For each item, mark PASS or FAIL with a brief reason.');
  sections.push('The task CANNOT be approved if ANY item is FAIL.');
  sections.push('');
  sections.push('### Checklist');
  sections.push('');
  sections.push(
    [
      '1. **Scope Compliance** — Does the diff ONLY touch files specified in the task?',
      `   Files actually changed: ${filesChanged}`,
      '',
      '2. **Correctness** — Does the implementation match the task description and acceptance criteria?',
      '',
      '3. **Code Quality**',
      '   - No unused imports, variables, or dead code',
      '   - No hardcoded values that should be constants/config',
      '   - Follows existing naming conventions in the codebase',
      '   - No unnecessary abstractions or over-engineering',
      '   - DRY — reuses existing utilities where appropriate',
      '',
      '4. **Error Handling** — Appropriate error handling for edge cases (but no over-defensive code)',
      '',
      '5. **Tests**',
      '   - Tests exist as specified in the task',
      '   - Tests cover happy path AND at least one error/edge case',
      '   - Tests are deterministic (no flaky timing, no test-order dependencies)',
      '',
      '6. **Consistency** — Matches patterns and conventions used elsewhere in the codebase',
      '',
      "7. **No Regressions** — Changes don't break existing functionality (check imports, exports, interfaces)",
    ].join('\n'),
  );
  sections.push('');
  sections.push('## Task Specification');
  sections.push('');
  sections.push(task.description ?? '');
  sections.push('');
  if (ac.length > 0) {
    sections.push('### Task Acceptance Criteria');
    sections.push('');
    sections.push(ac.map((c) => `- ${c}`).join('\n'));
    sections.push('');
  }
  sections.push('## PRD Acceptance Criteria');
  sections.push('');
  sections.push(prdAc.map((c) => `- ${c}`).join('\n'));
  sections.push('');
  sections.push('## Diff to Review');
  sections.push('');
  sections.push('```diff');
  sections.push(diff.trimEnd());
  sections.push('```');
  sections.push('');
  sections.push('## Output Format');
  sections.push('');
  sections.push('Output your review in this exact format:');
  sections.push('');
  sections.push('```markdown');
  sections.push(`## Review: Task ${taskId}`);
  sections.push('');
  sections.push('**Verdict**: APPROVED | CHANGES_REQUIRED');
  sections.push('');
  sections.push('### Checklist');
  sections.push('| # | Item | Status | Notes |');
  sections.push('|---|------|--------|-------|');
  sections.push('| 1 | Scope Compliance | PASS/FAIL | ... |');
  sections.push('| 2 | Correctness | PASS/FAIL | ... |');
  sections.push('| 3 | Code Quality | PASS/FAIL | ... |');
  sections.push('| 4 | Error Handling | PASS/FAIL | ... |');
  sections.push('| 5 | Tests | PASS/FAIL | ... |');
  sections.push('| 6 | Consistency | PASS/FAIL | ... |');
  sections.push('| 7 | No Regressions | PASS/FAIL | ... |');
  sections.push('');
  sections.push('### Required Changes (if CHANGES_REQUIRED)');
  sections.push('1. [file:line] — What to fix and why');
  sections.push('2. ...');
  sections.push('');
  sections.push('### Notes (optional)');
  sections.push('- Any observations or suggestions (non-blocking)');
  sections.push('```');
  sections.push('');
  sections.push('IMPORTANT:');
  sections.push('- Be strict. If something is wrong, mark it FAIL.');
  sections.push(
    '- Be specific. "Function foo() on line 42 has an unused parameter \'bar\'" beats "code quality is bad".',
  );
  sections.push('- Do NOT approve code that has ANY failing checklist items.');
  sections.push('- Do NOT suggest nice-to-haves as required changes — only flag real issues.');

  return `${sections.join('\n')}\n`;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
