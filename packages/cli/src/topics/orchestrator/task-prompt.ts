/**
 * `claude-prove orchestrator task-prompt` — emit the worktree implementation agent
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

import { isAbsolute, join } from 'node:path';
import { teamAgentNames } from '../scrum/team-agent-names';
import { readJson } from './read-json';

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

/**
 * Acceptance criterion on a plan task. The v3 shape is structured (`text` +
 * optional `verifies_by`/`check`, forwarded from scrum via `compile-plan`); a
 * legacy v2 string (an unmigrated plan.json) is tolerated and renders as its
 * own text. PRD acceptance_criteria stay bare strings.
 */
type PlanCriterion =
  | string
  | {
      text?: string;
      verifies_by?: string;
      check?: string;
    };

interface PlanTask {
  id: string;
  title?: string;
  description?: string;
  acceptance_criteria?: PlanCriterion[];
  /** Owning team forwarded by compile-plan; drives the role-bound agent roster. */
  team_slug?: string;
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
  // A relative run dir is absolutized against projectRoot (the main worktree
  // root) — the worker cd's into its task worktree, where `.prove/` is
  // gitignored and absent, so a relative path would silently miss the run dir.
  const resolvedRunDir = isAbsolute(opts.runDir)
    ? opts.runDir
    : join(opts.projectRoot, opts.runDir);

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
    sections.push(formatCriteriaList(ac));
    sections.push('');
  }

  if (steps.length > 0) {
    sections.push('## Steps');
    sections.push('');
    sections.push(steps.map((s) => `- \`${s.id}\` ${s.title ?? ''}`).join('\n'));
    sections.push('');
  }

  if (task.team_slug) {
    sections.push(renderTeamAgents(task.team_slug));
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
      "- **DO NOT** run `claude-prove store …` or any store-opening `claude-prove scrum …` command from this worktree. Every worktree shares ONE `.prove/prove.db` (resolved through git's common directory), and opening it AUTO-MIGRATES that shared store to your in-flight schema version — which corrupts the migration log when a sibling worktree carries a different version. Validate schema and store changes with the in-memory test suite (`bun test`); to exercise the CLI by hand, isolate it against a throwaway store with `--workspace-root <tmpdir>`.",
    ].join('\n'),
  );
  sections.push('');
  sections.push(renderCheckpointInterrupt(resolvedRunDir));
  sections.push('');
  sections.push(renderTypedFindings(resolvedRunDir, taskIdStr));
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
      '1. Record every substantive finding as a typed reasoning-log entry (see "Typed Findings" above).',
      '2. Produce at least one commit on this worktree branch containing the intended change.',
      '3. Exit.',
    ].join('\n'),
  );
  sections.push('');
  sections.push(
    'The SubagentStop hook reads the latest commit on this worktree and auto-completes the step from it. If you exit without committing, the hook halts the step with a diagnostic so the orchestrator knows to retry. Do NOT merge.',
  );

  return `${sections.join('\n')}\n`;
}

/**
 * Cooperative checkpoint-interrupt protocol (Layer 2) for the worker prompt.
 *
 * Best-effort graceful interrupt that layers ON TOP of the Layer-1
 * cancel-and-redispatch floor — it never replaces it. The driver raises a
 * cancel flag (a `CANCEL` file under the run dir); the worker polls it at
 * natural checkpoints and, when set, writes a `synthesis` reasoning-log entry
 * capturing progress + next steps, commits work-in-progress, and self-exits so
 * a re-dispatch RESUMES from the handoff rather than restarting. A non-polling
 * or stuck worker will not stop here — the token budget / subagent timeout
 * (Layer 1) remains the hard backstop.
 *
 * Receives the already-absolutized run dir, so the embedded flag path and
 * handoff-append command target the main worktree's `.prove/runs/...` tree —
 * never the worker's own task worktree, where `.prove/` is gitignored and
 * absent.
 */
function renderCheckpointInterrupt(resolvedRunDir: string): string {
  const cancelFlag = join(resolvedRunDir, 'CANCEL');
  return [
    '## Cooperative checkpoint-interrupt (Layer 2)',
    '',
    'The driver can ask for an early, graceful stop by writing a cancel-flag file. Poll it at natural checkpoints (after a logical unit of work, before starting the next file or step):',
    '',
    '```bash',
    `test -f "${cancelFlag}" && echo "cancel requested"`,
    '```',
    '',
    'When the cancel-flag is present, perform a graceful handoff so a re-dispatch RESUMES instead of restarting:',
    '',
    `1. Write a \`synthesis\` reasoning-log entry capturing progress so far and the concrete next steps. Compose the entry JSON with the Write tool, then append it: \`claude-prove acb log append --run-dir "${resolvedRunDir}" --file <entry.json>\`.`,
    '2. Commit your work-in-progress (`feat({scope}): WIP — graceful handoff at checkpoint`).',
    '3. Self-exit; do not continue past the checkpoint.',
    '',
    'This path is best-effort and layers ON TOP of the Layer-1 cancel-and-redispatch floor — it never replaces it. When you are mid-step or cannot stop cleanly, keep working: the token budget and subagent timeout remain the hard backstop.',
  ].join('\n');
}

/**
 * Typed-findings protocol for the normal-completion path.
 *
 * Without this section, worker findings reach the driver only inside the
 * final handoff message, get folded into driver `synthesis` entries, and
 * milestone-close curation — which mechanically sweeps only the typed kinds
 * `hack`/`risk`/`decision`/`assumption` — proposes zero candidates. Workers
 * CAN write these entries from a worktree: `acb log append` is a file append
 * into the main worktree's run dir, not a store-opening command, so the
 * shared-store ban in Resource Constraints does not apply to it.
 *
 * The `agent` value `task-<id>` keeps per-worker provenance in the
 * `log/<agent>/` layout, matching the `task/<slug>/<id>` branch convention.
 */
function renderTypedFindings(resolvedRunDir: string, taskIdStr: string): string {
  return [
    '## Typed Findings — record before exiting',
    '',
    'Findings that should outlive this run MUST land in the reasoning log as typed entries — these are file appends into the main worktree run dir, not store-opening commands, so the shared-store ban in Resource Constraints does not apply. A finding mentioned only in your final handoff message is dropped: milestone-close curation sweeps typed entries, never handoff prose. This applies on NORMAL completion, not just on cancel.',
    '',
    'Record one entry per substantive finding, choosing the type by what you found:',
    '',
    '- `hack` — a shortcut or temporary workaround you shipped. Extra fields: `file_refs` (string[]), `cleanup_condition` (string).',
    '- `risk` — fragility or danger you saw but did not fix. Extra fields: `severity` (`"low"|"medium"|"high"|"critical"`), `mitigation` (string).',
    '- `decision` — a choice between defensible options. Extra fields: `alternatives` (string[]), `selected_rationale` (string).',
    '- `assumption` — something you proceeded on without verifying. Extra fields: `resolved` (boolean), `resolution_ref` (string or null).',
    '',
    `Each entry is one JSON object with the envelope fields — \`id\` (fresh UUID), \`ts\` (ISO-8601), \`type\`, \`agent\` (use \`task-${taskIdStr}\`), \`run_path\` (the run dir below), \`body\` (the finding itself, in prose) — plus the type's extra fields. Validation is strict and closed: unknown types or extra keys are rejected, so put detail in \`body\`, never in new keys.`,
    '',
    'Compose each entry file with the Write tool (Bash heredocs mangle multi-line prose), then land it:',
    '',
    '```bash',
    `claude-prove acb log append --run-dir "${resolvedRunDir}" --file <entry.json>`,
    '```',
    '',
    'A clean run with nothing worth recording appends nothing — do not invent findings. Still summarize your findings in the final handoff message; the typed entries are the durable record, the handoff is for the driver.',
  ].join('\n');
}

/**
 * Render the task's role-bound team agent roster. The three names
 * (`team-<slug>-tech_lead|engineer|implementer`) are derived deterministically
 * from the slug over the canonical role enum — no store lookup — so the worker
 * knows exactly which seats own this task's work without resolving the team
 * from `prove.db`.
 */
function renderTeamAgents(teamSlug: string): string {
  return [
    `## Team Agents (team ${teamSlug})`,
    '',
    'This task is owned by a team. Its role-bound agents — derived from the team slug — are:',
    '',
    ...teamAgentNames(teamSlug).map((name) => `- \`${name}\``),
  ].join('\n');
}

function formatBulletList(items: string[]): string {
  return items.map((c) => `- ${c}`).join('\n');
}

/**
 * Render structured plan-task criteria as a bullet list. Each line is the
 * criterion `text`, annotated with `(verifies_by: check)` when a verification
 * kind is present so the implementer sees how the criterion will be checked.
 */
function formatCriteriaList(criteria: PlanCriterion[]): string {
  return criteria
    .map((c) => {
      if (typeof c === 'string') return `- ${c}`;
      const text = c.text ?? '';
      if (!c.verifies_by) return `- ${text}`;
      const check = c.check ? `: ${c.check}` : '';
      return `- ${text} (${c.verifies_by}${check})`;
    })
    .join('\n');
}
