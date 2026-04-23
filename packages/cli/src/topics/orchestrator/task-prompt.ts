/**
 * `prove orchestrator task-prompt` — emit the worktree implementation agent
 * prompt for a specific task id.
 *
 * Replaces `skills/orchestrator/scripts/generate-task-prompt.sh`. The shell
 * predecessor shelled out to `python3` for plan/prd/validator extraction,
 * then used `<<<LABEL>>>` sentinels + `awk` to re-thread those fields back
 * into a bash heredoc. This TS version reads every JSON input directly and
 * writes the final prompt in one pass — no sentinel indirection.
 *
 * Output: prompt markdown on stdout, identical in shape to the retired
 * shell template (worktree-cd block / task details / acceptance criteria /
 * implementation rules / code quality checklist / resource constraints).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TaskPromptOpts {
  runDir: string;
  taskId: string;
  projectRoot: string;
  worktreePath?: string;
}

interface PlanStep {
  id: string;
  title?: string;
}

interface PlanTask {
  id: string;
  title?: string;
  description?: string;
  acceptance_criteria?: string[];
  steps?: PlanStep[];
}

interface PlanShape {
  tasks?: PlanTask[];
}

interface PrdShape {
  acceptance_criteria?: string[];
  test_strategy?: string;
}

interface ValidatorEntry {
  name?: string;
  phase?: string;
  command?: string;
  prompt?: string;
}

interface ConfigShape {
  validators?: ValidatorEntry[];
}

interface ValidatorSummary {
  build: string;
  lint: string;
  test: string;
  custom: string;
  llmLines: string[];
}

export function runTaskPrompt(opts: TaskPromptOpts): number {
  const plan = readJson<PlanShape>(join(opts.runDir, 'plan.json'));
  const prd = readJson<PrdShape>(join(opts.runDir, 'prd.json'));

  if (!plan) {
    process.stderr.write(`ERROR: plan.json not found at ${join(opts.runDir, 'plan.json')}\n`);
    return 1;
  }
  if (!prd) {
    process.stderr.write(`ERROR: prd.json not found at ${join(opts.runDir, 'prd.json')}\n`);
    return 1;
  }

  const taskIdStr = String(opts.taskId);
  const task = (plan.tasks ?? []).find((t) => String(t.id) === taskIdStr);
  if (!task) {
    process.stderr.write(
      `ERROR: task ${taskIdStr} not found in ${join(opts.runDir, 'plan.json')}\n`,
    );
    return 1;
  }

  const config = readJson<ConfigShape>(join(opts.projectRoot, '.claude', '.prove.json'));
  const validators = summarizeValidators(config?.validators ?? []);

  process.stdout.write(renderTaskPrompt({ task, prd, validators, opts, taskIdStr }));
  return 0;
}

function summarizeValidators(entries: ValidatorEntry[]): ValidatorSummary {
  const byPhase = (phase: string): string =>
    entries
      .filter((v) => v.phase === phase && !!v.command)
      .map((v) => v.command as string)
      .join('; ');

  const llmLines = entries
    .filter((v) => !!v.prompt)
    .map((v) => `   - **${v.name ?? ''}**: \`${v.prompt}\``);

  return {
    build: byPhase('build'),
    lint: byPhase('lint'),
    test: byPhase('test'),
    custom: byPhase('custom'),
    llmLines,
  };
}

interface RenderInput {
  task: PlanTask;
  prd: PrdShape;
  validators: ValidatorSummary;
  opts: TaskPromptOpts;
  taskIdStr: string;
}

function renderTaskPrompt(input: RenderInput): string {
  const { task, prd, validators, opts, taskIdStr } = input;
  const ac = task.acceptance_criteria ?? [];
  const steps = task.steps ?? [];
  const prdAc = prd.acceptance_criteria ?? [];

  const sections: string[] = [];

  if (opts.worktreePath) {
    sections.push(
      [
        '',
        '## Worktree',
        '',
        'You are working in a pre-created worktree. Before doing anything else, change into it:',
        '',
        '```bash',
        `cd ${opts.worktreePath}`,
        '```',
        '',
        'All file reads, edits, and git commands must happen inside this directory.',
      ].join('\n'),
    );
  } else {
    sections.push('');
  }

  sections.push('');
  sections.push(`You are implementing **Task ${taskIdStr}: ${task.title ?? ''}**`);
  sections.push('');
  sections.push('## Task Details');
  sections.push('');
  sections.push(task.description ?? '');
  sections.push('');

  if (ac.length > 0) {
    sections.push('## Task Acceptance Criteria');
    sections.push('');
    sections.push(formatBulletList(ac));
    sections.push('');
  }

  if (steps.length > 0) {
    sections.push('## Steps');
    sections.push('');
    sections.push(steps.map((s) => `- \`${s.id}\` ${s.title ?? ''}`).join('\n'));
    sections.push('');
  }

  sections.push('## Acceptance Criteria (from PRD)');
  sections.push('');
  sections.push(formatBulletList(prdAc));
  sections.push('');

  if (prd.test_strategy) {
    sections.push('## Test Strategy (from PRD)');
    sections.push('');
    sections.push(prd.test_strategy);
    sections.push('');
  }

  sections.push('## Implementation Rules');
  sections.push('');
  sections.push(
    [
      '1. **Read first** — Before modifying any file, read it to understand existing patterns and conventions.',
      '2. **Scope discipline** — Only modify files listed in the task. If you discover you need to touch an unlisted file, document why in your commit message.',
      '3. **Tests alongside code** — Write tests as specified in the task. Do not skip tests.',
      '4. **Verify before committing**:',
    ].join('\n'),
  );

  if (validators.build) sections.push(`   - Build: \`${validators.build}\``);
  if (validators.lint) sections.push(`   - Lint: \`${validators.lint}\``);
  if (validators.test) {
    sections.push(`   - Tests: \`${validators.test}\``);
  } else {
    sections.push("   - Run the project's test suite (check .claude/.prove.json for the command)");
  }
  if (validators.custom) sections.push(`   - Custom: \`${validators.custom}\``);
  if (validators.llmLines.length > 0) {
    sections.push(
      '   - LLM validators (your code will be evaluated against these prompt criteria):',
    );
    sections.push(validators.llmLines.join('\n'));
  }

  sections.push('5. **Commit format**: `feat({scope}): {task description}`');
  sections.push("6. **Max 3 retry attempts** if tests fail — fix the issue, don't just retry.");
  sections.push('');
  sections.push('## Code Quality Checklist (reviewer will check these)');
  sections.push('');
  sections.push(
    [
      '- [ ] No unused imports or variables',
      '- [ ] No hardcoded values that should be configurable',
      '- [ ] Error handling for edge cases',
      '- [ ] Follows existing naming conventions',
      '- [ ] No code duplication — reuse existing utilities',
      '- [ ] Tests cover happy path AND at least one error case',
    ].join('\n'),
  );
  sections.push('');
  sections.push('## Resource Constraints');
  sections.push('');
  sections.push(
    [
      '- **DO NOT** spawn agents with `isolation: "worktree"`. You are already in a worktree — nested worktrees cause exponential resource growth.',
      '- **DO NOT** use the Agent tool with `run_in_background: true` for heavy workloads. You are a leaf worker, not an orchestrator.',
    ].join('\n'),
  );
  sections.push('');
  sections.push('## When Done');
  sections.push('');
  sections.push(
    'Commit your work and exit. The worktree branch will be reviewed by a principal-architect agent before merge.',
  );
  sections.push('');
  sections.push(
    "**Step-state accounting is the orchestrator's job, not yours.** Do NOT call `scripts/prove-run step-complete` or any other run_state mutator. Your contract is:",
  );
  sections.push('');
  sections.push(
    [
      '1. Produce at least one commit on this worktree branch containing the intended change.',
      '2. Exit.',
    ].join('\n'),
  );
  sections.push('');
  sections.push(
    'The SubagentStop hook reads the latest commit on this worktree and auto-completes the step from it. If you exit without committing, the hook halts the step with a diagnostic so the orchestrator knows to retry. Do NOT merge.',
  );

  return `${sections.join('\n')}\n`;
}

function formatBulletList(items: string[]): string {
  return items.map((c) => `- ${c}`).join('\n');
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
