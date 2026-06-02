/**
 * Tests for the closed assert-kind expression grammar + in-process evaluator.
 *
 * Four concerns, mirroring the deliverable:
 *   1. parse — valid expressions parse; invalid/unknown ones throw a typed error
 *   2. evaluate — truth table over comparisons, boolean ops, parens, truthiness
 *   3. dispatch — `verifyCriterion` routes by `verifies_by` (assert in-process,
 *      the rest delegated)
 *   4. offending sub-expression — a failing expression names the false branch
 *
 * Every test builds its own context inline (no shared fixture) so each case
 * reads as a self-contained input → expected-output pair.
 */

import { describe, expect, test } from 'bun:test';
import type { StateData } from '../run-state/state';
import {
  type AssertContext,
  AssertGrammarError,
  CONTEXT_ACCESSORS,
  buildAssertContext,
  evaluateAssert,
  parseAssert,
  verifyCriterion,
} from './assert-grammar';
import type { AcceptanceCriterion } from './types';

// Fully-populated context; individual tests override the fields they exercise.
function ctx(
  overrides: Partial<{
    run: string;
    taskStatus: string;
    taskReview: string;
    step: string;
    build: string;
    lint: string;
    test: string;
    custom: string;
    llm: string;
  }> = {},
): AssertContext {
  return {
    run: { status: overrides.run ?? 'running' },
    task: {
      status: overrides.taskStatus ?? 'in_progress',
      review: overrides.taskReview ?? 'pending',
    },
    step: { status: overrides.step ?? 'completed' },
    validator: {
      build: overrides.build ?? 'pass',
      lint: overrides.lint ?? 'pass',
      test: overrides.test ?? 'pass',
      custom: overrides.custom ?? 'pending',
      llm: overrides.llm ?? 'pending',
    },
  };
}

function assertCriterion(check: string): AcceptanceCriterion {
  return { id: 'c1', text: 'x', verifies_by: 'assert', check, status: 'active', idempotent: true };
}

describe('parseAssert — valid expressions', () => {
  test.each([
    "validator.test == 'pass'",
    "validator.test != 'fail'",
    "task.review == 'approved' and validator.build == 'pass'",
    "run.status == 'completed' or run.status == 'running'",
    "not validator.test == 'fail'",
    "(validator.build == 'pass' or validator.lint == 'pass') and validator.test == 'pass'",
    'validator.build',
    'true',
    'false',
    '3 < 5',
    '-2 <= 0',
  ])('parses %p', (expr) => {
    expect(() => parseAssert(expr)).not.toThrow();
  });
});

describe('parseAssert — invalid/unknown expressions throw a typed error', () => {
  test.each([
    ['empty', ''],
    ['unknown accessor', "validator.bogus == 'pass'"],
    ['unterminated string', "validator.test == 'pass"],
    ['stray equals', 'validator.test = pass'],
    ['missing close paren', "(validator.test == 'pass'"],
    ['trailing token', "validator.test == 'pass' validator.build"],
    ['operator without operand', 'validator.test =='],
    ['bare comparison op', "== 'pass'"],
    ['lone garbage char', '@'],
  ])('%s throws AssertGrammarError', (_label, expr) => {
    expect(() => parseAssert(expr)).toThrow(AssertGrammarError);
  });
});

describe('evaluateAssert — invalid expression throws, never silent-passes', () => {
  test('unknown accessor throws rather than returning ok', () => {
    expect(() => evaluateAssert("nope.field == 'x'", ctx())).toThrow(AssertGrammarError);
  });

  test('ordering comparison on a non-numeric operand throws', () => {
    expect(() => evaluateAssert("run.status < 'completed'", ctx())).toThrow(AssertGrammarError);
  });
});

describe('evaluateAssert — truth table', () => {
  const cases: Array<[string, AssertContext, boolean]> = [
    // equality
    ["validator.test == 'pass'", ctx({ test: 'pass' }), true],
    ["validator.test == 'pass'", ctx({ test: 'fail' }), false],
    ["validator.test != 'fail'", ctx({ test: 'pass' }), true],
    ["validator.test != 'fail'", ctx({ test: 'fail' }), false],
    // boolean and
    [
      "validator.build == 'pass' and validator.test == 'pass'",
      ctx({ build: 'pass', test: 'pass' }),
      true,
    ],
    [
      "validator.build == 'pass' and validator.test == 'pass'",
      ctx({ build: 'pass', test: 'fail' }),
      false,
    ],
    // boolean or
    ["run.status == 'completed' or run.status == 'running'", ctx({ run: 'running' }), true],
    ["run.status == 'completed' or run.status == 'failed'", ctx({ run: 'running' }), false],
    // not
    ["not validator.test == 'fail'", ctx({ test: 'pass' }), true],
    ["not validator.test == 'fail'", ctx({ test: 'fail' }), false],
    // precedence: or binds looser than and. Parses as
    //   (build=='fail') or (lint=='pass' and test=='pass').
    // Left branch true → whole expr true regardless of the and-branch.
    [
      "validator.build == 'fail' or validator.lint == 'pass' and validator.test == 'pass'",
      ctx({ build: 'fail', lint: 'pass', test: 'pass' }),
      true,
    ],
    // Left branch false (build=pass); right and-branch false (test=fail) → false.
    [
      "validator.build == 'fail' or validator.lint == 'pass' and validator.test == 'pass'",
      ctx({ build: 'pass', lint: 'pass', test: 'fail' }),
      false,
    ],
    // parens force the or to bind first: (build=='fail' or lint=='pass') and test=='pass'.
    // Group is (false or false)=false → whole expr false even though test=='pass' holds.
    // Without parens the same fields would parse as build=='fail' or (lint=='pass' and test=='pass')
    // = false or (false and true) = false, so also assert the grouping makes a difference below.
    [
      "(validator.build == 'fail' or validator.lint == 'pass') and validator.test == 'pass'",
      ctx({ build: 'pass', lint: 'fail', test: 'pass' }),
      false,
    ],
    // grouping difference: (build=='pass' or lint=='pass') and test=='fail' is false,
    // but build=='pass' or (lint=='pass' and test=='fail') is true — same fields, parens flip it.
    [
      "(validator.build == 'pass' or validator.lint == 'pass') and validator.test == 'fail'",
      ctx({ build: 'pass', lint: 'pass', test: 'pass' }),
      false,
    ],
    [
      "validator.build == 'pass' or validator.lint == 'pass' and validator.test == 'fail'",
      ctx({ build: 'pass', lint: 'pass', test: 'pass' }),
      true,
    ],
    // truthiness of a bare accessor (non-empty string is true)
    ['validator.build', ctx({ build: 'pass' }), true],
    ['validator.build', ctx({ build: '' }), false],
    // boolean literals
    ['true', ctx(), true],
    ['false', ctx(), false],
    // numeric ordering
    ['3 < 5', ctx(), true],
    ['5 <= 5', ctx(), true],
    ['5 < 5', ctx(), false],
    ['10 > 2', ctx(), true],
    ['2 >= 3', ctx(), false],
    // absent context field resolves to "" → comparison simply false, no throw
    ["validator.custom == 'pass'", ctx({ custom: '' }), false],
  ];

  test.each(cases)('%p evaluates to %p', (expr, context, expected) => {
    expect(evaluateAssert(expr, context).ok).toBe(expected);
  });
});

describe('evaluateAssert — offending sub-expression on failure', () => {
  test('and: names the false branch only', () => {
    const result = evaluateAssert(
      "validator.build == 'pass' and validator.test == 'pass'",
      ctx({ build: 'pass', test: 'fail' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("validator.test == 'pass'");
  });

  test('and: descends to the first false branch', () => {
    const result = evaluateAssert(
      "validator.build == 'pass' and validator.lint == 'pass' and validator.test == 'pass'",
      ctx({ build: 'pass', lint: 'fail', test: 'pass' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("validator.lint == 'pass'");
  });

  test('or: both false → names the whole or', () => {
    const result = evaluateAssert(
      "run.status == 'completed' or run.status == 'failed'",
      ctx({ run: 'running' }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("run.status == 'completed' or run.status == 'failed'");
  });

  test('single comparison: the comparison itself is the offender', () => {
    const result = evaluateAssert("task.review == 'approved'", ctx({ taskReview: 'rejected' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("task.review == 'approved'");
  });

  test('success: reason is empty', () => {
    const result = evaluateAssert("validator.test == 'pass'", ctx({ test: 'pass' }));
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('');
  });
});

describe('verifyCriterion — dispatch routing', () => {
  test('assert: decided in-process (satisfied)', () => {
    const v = verifyCriterion(assertCriterion("validator.test == 'pass'"), ctx({ test: 'pass' }));
    expect(v).toEqual({ ok: true, reason: '', delegated: false });
  });

  test('assert: decided in-process (unsatisfied names offender)', () => {
    const v = verifyCriterion(assertCriterion("validator.test == 'pass'"), ctx({ test: 'fail' }));
    expect(v.ok).toBe(false);
    expect(v.delegated).toBe(false);
    expect(v.reason).toBe("validator.test == 'pass'");
  });

  test('assert: invalid expression throws (not a silent pass)', () => {
    expect(() => verifyCriterion(assertCriterion('@bad'), ctx())).toThrow(AssertGrammarError);
  });

  test('bash: delegates to validators channel', () => {
    const c: AcceptanceCriterion = {
      id: 'b',
      text: 'x',
      verifies_by: 'bash',
      check: 'bun run build',
      status: 'active',
      idempotent: true,
    };
    const v = verifyCriterion(c, ctx());
    expect(v.delegated).toBe(true);
    expect(v.channel).toBe('validators');
  });

  test('gate: delegates to operator gate channel', () => {
    const c: AcceptanceCriterion = {
      id: 'g',
      text: 'x',
      verifies_by: 'gate',
      check: 'looks good?',
      status: 'active',
      idempotent: false,
    };
    const v = verifyCriterion(c, ctx());
    expect(v.delegated).toBe(true);
    expect(v.channel).toBe('gate');
  });

  test('agent: delegates to validation-agent channel', () => {
    const c: AcceptanceCriterion = {
      id: 'a',
      text: 'x',
      verifies_by: 'agent',
      check: 'judge quality',
      status: 'active',
      idempotent: false,
    };
    const v = verifyCriterion(c, ctx());
    expect(v.delegated).toBe(true);
    expect(v.channel).toBe('validation-agent');
  });
});

describe('buildAssertContext — projects run-state into the flat context', () => {
  function state(): StateData {
    return {
      schema_version: '4',
      kind: 'state',
      run_status: 'running',
      slug: 'add-login',
      branch: 'main',
      current_task: 't1',
      current_step: 't1.1',
      started_at: '',
      updated_at: '',
      ended_at: '',
      tasks: [
        {
          id: 't1',
          status: 'in_progress',
          started_at: '',
          ended_at: '',
          review: { verdict: 'approved', notes: '', reviewer: '', reviewed_at: '' },
          steps: [
            {
              id: 't1.1',
              status: 'completed',
              started_at: '',
              ended_at: '',
              commit_sha: 'abc',
              validator_summary: {
                build: 'pass',
                lint: 'pass',
                test: 'fail',
                custom: 'pending',
                llm: 'skipped',
              },
              halt_reason: '',
            },
          ],
        },
      ],
      dispatch: { dispatched: [] },
    };
  }

  test('focused task + step populate every field', () => {
    const c = buildAssertContext(state(), 't1', 't1.1');
    expect(c).toEqual({
      run: { status: 'running' },
      task: { status: 'in_progress', review: 'approved' },
      step: { status: 'completed' },
      validator: { build: 'pass', lint: 'pass', test: 'fail', custom: 'pending', llm: 'skipped' },
    });
  });

  test('unmatched task leaves task/step/validator fields empty', () => {
    const c = buildAssertContext(state(), 'nope');
    expect(c.run.status).toBe('running');
    expect(c.task.status).toBe('');
    expect(c.step.status).toBe('');
    expect(c.validator.test).toBe('');
  });

  test('end-to-end: evaluate against a built context', () => {
    const c = buildAssertContext(state(), 't1', 't1.1');
    expect(evaluateAssert("task.review == 'approved' and validator.build == 'pass'", c).ok).toBe(
      true,
    );
    const fail = evaluateAssert("validator.test == 'pass'", c);
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe("validator.test == 'pass'");
  });
});

describe('closed vocabulary invariants', () => {
  test('every declared accessor resolves without throwing', () => {
    const c = ctx();
    for (const accessor of CONTEXT_ACCESSORS) {
      expect(() => evaluateAssert(`${accessor} == 'x'`, c)).not.toThrow();
    }
  });
});
