/**
 * Unit tests for the per-action usage registry — the single source of truth
 * the action-scoped `--help` renderer and full-usage error path both read.
 *
 * These exercise the pure functions directly against a cac instance carrying
 * the real topic commands (registered via the topic `register` functions), so
 * the flag descriptions assert come from the live `.option()` declarations.
 */

import { describe, expect, test } from 'bun:test';
import { cac } from 'cac';
import { register as registerRunState } from '../../topics/run-state';
import { register as registerScrum } from '../../topics/scrum';
import { actionUsageError, renderActionHelp, renderUsageLine } from './action-registry';
import { ACTION_REGISTRY } from './registry-data';

function buildCli() {
  const cli = cac('claude-prove');
  registerScrum(cli);
  registerRunState(cli);
  return cli;
}

describe('renderUsageLine', () => {
  test('names every positional in order, then [flags]', () => {
    const line = renderUsageLine('claude-prove', 'scrum', 'link-run', {
      positionals: ['task-id', 'run-path'],
      flags: ['branch', 'slug'],
    });
    expect(line).toBe('Usage: claude-prove scrum link-run <task-id> <run-path> [flags]');
  });

  test('omits [flags] when the action declares no scoped flags', () => {
    const line = renderUsageLine('claude-prove', 'run-state', 'ls', {
      positionals: [],
      flags: [],
    });
    expect(line).toBe('Usage: claude-prove run-state ls');
  });
});

describe('renderActionHelp — scoped flag omission', () => {
  test('scrum link-run help shows only its two flags, not the topic flat dump', () => {
    const cli = buildCli();
    const help = renderActionHelp(cli, ACTION_REGISTRY, 'scrum', 'link-run');
    expect(help).toBeDefined();
    // Usage line names both positionals.
    expect(help).toContain('Usage: claude-prove scrum link-run <task-id> <run-path> [flags]');
    // Its scoped flags appear with their live descriptions.
    expect(help).toContain('--branch <b>');
    expect(help).toContain('--slug');
    // Unrelated flags from sibling actions are omitted.
    expect(help).not.toContain('--title');
    expect(help).not.toContain('--verifies-by');
    expect(help).not.toContain('--ask-type');
    expect(help).not.toContain('--target-state');
  });

  test('scrum task create help omits flags scoped to other actions', () => {
    const cli = buildCli();
    const help = renderActionHelp(cli, ACTION_REGISTRY, 'scrum', 'task', 'create');
    expect(help).toBeDefined();
    expect(help).toContain('Usage: claude-prove scrum task create [flags]');
    expect(help).toContain('--title <t>');
    expect(help).toContain('--milestone');
    // Acceptance / escalation / team flags belong to other sub-actions.
    expect(help).not.toContain('--verifies-by');
    expect(help).not.toContain('--summary');
    expect(help).not.toContain('--schema-ref');
  });

  test('run-state validate help shows the run-resolution flags', () => {
    const cli = buildCli();
    const help = renderActionHelp(cli, ACTION_REGISTRY, 'run-state', 'validate');
    expect(help).toBeDefined();
    expect(help).toContain('Usage: claude-prove run-state validate <file> [flags]');
    expect(help).toContain('--branch');
    expect(help).toContain('--slug');
    expect(help).toContain('--kind');
    // No leakage of init/step/report-only flags.
    expect(help).not.toContain('--plan');
    expect(help).not.toContain('--verdict');
    expect(help).not.toContain('--reviewer');
  });

  test('unregistered action returns undefined (caller falls back to cac help)', () => {
    const cli = buildCli();
    expect(renderActionHelp(cli, ACTION_REGISTRY, 'scrum', 'bogus-action')).toBeUndefined();
    expect(renderActionHelp(cli, ACTION_REGISTRY, 'unknown-topic', 'whatever')).toBeUndefined();
  });
});

describe('actionUsageError — full usage line on missing positional', () => {
  function capture(fn: () => number): { code: number; err: string } {
    const original = process.stderr.write.bind(process.stderr);
    let err = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = fn();
      return { code, err };
    } finally {
      process.stderr.write = original;
    }
  }

  test('names ALL positionals at once for a multi-positional action', () => {
    const cli = buildCli();
    const { code, err } = capture(() =>
      actionUsageError(
        cli,
        ACTION_REGISTRY,
        'scrum',
        'link-run',
        'the following arguments are required: task-id, run-path',
      ),
    );
    expect(code).toBe(1);
    expect(err).toContain('Usage: claude-prove scrum link-run <task-id> <run-path> [flags]');
    expect(err).toContain('error: the following arguments are required: task-id, run-path');
  });

  test('falls back to bare message for an unregistered action', () => {
    const cli = buildCli();
    const { code, err } = capture(() =>
      actionUsageError(cli, ACTION_REGISTRY, 'scrum', 'bogus', 'something is required'),
    );
    expect(code).toBe(1);
    expect(err).not.toContain('Usage:');
    expect(err).toContain('error: something is required');
  });
});
