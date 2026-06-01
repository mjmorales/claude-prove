/**
 * Parity tests for `claude-prove orchestrator task-prompt`.
 *
 * Covers structural invariants from the retired shell template:
 *   - worktree cd block is present when --worktree is passed
 *   - task title, description, acceptance criteria, steps render verbatim
 *   - validator commands from .claude/.prove.json appear in the Implementation
 *     Rules block
 *   - LLM validators render as `   - **<name>**: \`<prompt>\`` lines
 *   - falsy flags trigger a 1-exit with an error on stderr
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTaskPrompt } from './task-prompt';

let root: string;
let runDir: string;
let project: string;
let stdoutBuf: string;
let stderrBuf: string;
let writeSpy: { restore: () => void };

function spyStd(): { restore: () => void } {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  stdoutBuf = '';
  stderrBuf = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdoutBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

function writePlan(plan: unknown): void {
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan));
}

function writePrd(prd: unknown): void {
  writeFileSync(join(runDir, 'prd.json'), JSON.stringify(prd));
}

function writeConfig(config: unknown): void {
  const dir = join(project, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.prove.json'), JSON.stringify(config));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-prompt-'));
  runDir = join(root, 'run');
  project = join(root, 'project');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeSpy = spyStd();
});

afterEach(() => {
  writeSpy.restore();
  rmSync(root, { recursive: true, force: true });
});

const BASE_PLAN = {
  tasks: [
    {
      id: '1',
      title: 'hello-world',
      description: 'Build the hello-world feature.',
      acceptance_criteria: [
        { text: 'AC-1', verifies_by: 'bash', check: 'bun test' },
        { text: 'AC-2' },
      ],
      steps: [
        { id: '1.1', title: 'scaffold' },
        { id: '1.2', title: 'wire up' },
      ],
    },
  ],
};

const BASE_PRD = {
  acceptance_criteria: ['PRD-AC-1'],
  test_strategy: 'Run the bun suite.',
};

describe('orchestrator task-prompt', () => {
  test('renders worktree cd block, task title, AC, steps, PRD', () => {
    writePlan(BASE_PLAN);
    writePrd(BASE_PRD);
    writeConfig({
      validators: [
        { name: 'build', phase: 'build', command: 'bun tsc --build' },
        { name: 'tests', phase: 'test', command: 'bun test' },
      ],
    });

    const code = runTaskPrompt({
      runDir,
      taskId: '1',
      projectRoot: project,
      worktreePath: '/tmp/worktree-1',
    });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('cd /tmp/worktree-1');
    expect(stdoutBuf).toContain('**Task 1: hello-world**');
    expect(stdoutBuf).toContain('Build the hello-world feature.');
    // Structured criterion with verifies_by renders the kind+check annotation;
    // a bare { text } renders just the text.
    expect(stdoutBuf).toContain('- AC-1 (bash: bun test)');
    expect(stdoutBuf).toContain('- AC-2');
    expect(stdoutBuf).toContain('- `1.1` scaffold');
    expect(stdoutBuf).toContain('- `1.2` wire up');
    expect(stdoutBuf).toContain('- PRD-AC-1');
    expect(stdoutBuf).toContain('Run the bun suite.');
    expect(stdoutBuf).toContain('- Build: `bun tsc --build`');
    expect(stdoutBuf).toContain('- Tests: `bun test`');
  });

  test('injects the cooperative checkpoint-interrupt protocol with the cancel-flag path', () => {
    writePlan(BASE_PLAN);
    writePrd(BASE_PRD);
    const code = runTaskPrompt({ runDir, taskId: '1', projectRoot: project });
    expect(code).toBe(0);
    // Section header + the three terms the acceptance grep scans for.
    expect(stdoutBuf).toContain('## Cooperative checkpoint-interrupt (Layer 2)');
    expect(stdoutBuf).toContain('cancel-flag');
    expect(stdoutBuf).toContain('graceful handoff');
    // The cancel-flag read path resolves against the run dir.
    expect(stdoutBuf).toContain(join(runDir, 'CANCEL'));
    // The handoff is a synthesis reasoning-log entry appended via acb log.
    expect(stdoutBuf).toContain('`synthesis` reasoning-log entry');
    expect(stdoutBuf).toContain(`claude-prove acb log append --run-dir "${runDir}"`);
    // Layering: best-effort on top of the Layer-1 floor, never replacing it.
    expect(stdoutBuf).toContain('layers ON TOP of the Layer-1 cancel-and-redispatch floor');
    expect(stdoutBuf).toContain('token budget and subagent timeout remain the hard backstop');
  });

  test('no worktree flag → omits the cd block', () => {
    writePlan(BASE_PLAN);
    writePrd(BASE_PRD);
    const code = runTaskPrompt({ runDir, taskId: '1', projectRoot: project });
    expect(code).toBe(0);
    expect(stdoutBuf).not.toContain('## Worktree');
    expect(stdoutBuf).not.toContain('cd /tmp/');
  });

  test('LLM validators render as indented bullet list', () => {
    writePlan(BASE_PLAN);
    writePrd(BASE_PRD);
    writeConfig({
      validators: [{ name: 'doc-quality', phase: 'llm', prompt: '.prove/prompts/doc.md' }],
    });
    const code = runTaskPrompt({ runDir, taskId: '1', projectRoot: project });
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('   - **doc-quality**: `.prove/prompts/doc.md`');
  });

  test('missing plan.json → exit 1, stderr diagnostic', () => {
    writePrd(BASE_PRD);
    const code = runTaskPrompt({ runDir, taskId: '1', projectRoot: project });
    expect(code).toBe(1);
    expect(stderrBuf).toContain('plan.json not found');
  });

  test('task id not in plan → exit 1', () => {
    writePlan(BASE_PLAN);
    writePrd(BASE_PRD);
    const code = runTaskPrompt({ runDir, taskId: '99', projectRoot: project });
    expect(code).toBe(1);
    expect(stderrBuf).toContain('task 99 not found');
  });
});
