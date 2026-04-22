/**
 * 1:1 port of tools/schema/test_validate.py.
 *
 * Test-name mapping (Python class/method -> TS test name):
 *
 *   TestProveSchema.test_valid_complete_config          -> 'valid complete config'
 *   TestProveSchema.test_missing_schema_version         -> 'missing schema_version'
 *   TestProveSchema.test_minimal_valid_config           -> 'minimal valid config'
 *   TestProveSchema.test_wrong_type_validators          -> 'wrong type validators'
 *   TestProveSchema.test_wrong_type_scopes              -> 'wrong type scopes'
 *   TestProveSchema.test_validator_missing_required_fields
 *                                                       -> 'validator missing required fields'
 *   TestProveSchema.test_validator_invalid_phase        -> 'validator invalid phase'
 *   TestProveSchema.test_reporter_missing_events        -> 'reporter missing events'
 *   TestProveSchema.test_unknown_field_warns            -> 'unknown field warns'
 *   TestProveSchema.test_strict_mode_promotes_warnings  -> 'strict mode promotes warnings'
 *   TestProveSchema.test_scope_values_must_be_strings   -> 'scope values must be strings'
 *   TestProveSchema.test_tools_wrong_enabled_type       -> 'tools wrong enabled type'
 *
 *   TestSettingsSchema.test_valid_hooks_config          -> 'valid hooks config'
 *   TestSettingsSchema.test_empty_settings_valid        -> 'empty settings valid'
 *   TestSettingsSchema.test_hook_missing_type           -> 'hook missing type'
 *   TestSettingsSchema.test_hook_invalid_type_enum      -> 'hook invalid type enum'
 */

import { describe, expect, test } from 'bun:test';
import { PROVE_SCHEMA, SETTINGS_SCHEMA } from './schemas';
import { type ValidationError, validateConfig } from './validate';

function errorPaths(errors: ValidationError[]): Set<string> {
  return new Set(errors.filter((e) => e.severity === 'error').map((e) => e.path));
}

function warnPaths(errors: ValidationError[]): Set<string> {
  return new Set(errors.filter((e) => e.severity === 'warning').map((e) => e.path));
}

describe('TestProveSchema', () => {
  test('valid complete config', () => {
    const config = {
      schema_version: '1',
      scopes: { plugin: '.' },
      validators: [{ name: 'build', command: 'go build ./...', phase: 'build' }],
      reporters: [
        { name: 'slack', command: './notify.sh', events: ['step-complete'] },
      ],
      index: { excludes: [], max_file_size: 102400, concurrency: 3 },
    };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors)).toEqual(new Set());
  });

  test('missing schema_version', () => {
    const config = { validators: [] };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors).has('schema_version')).toBe(true);
  });

  test('minimal valid config', () => {
    const config = { schema_version: '1' };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors)).toEqual(new Set());
  });

  test('wrong type validators', () => {
    const config = { schema_version: '1', validators: 'not-a-list' };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors).has('validators')).toBe(true);
  });

  test('wrong type scopes', () => {
    const config = { schema_version: '1', scopes: ['a', 'b'] };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors).has('scopes')).toBe(true);
  });

  test('validator missing required fields', () => {
    const config = {
      schema_version: '1',
      validators: [{ command: 'echo hi' }],
    };
    const errors = validateConfig(config, PROVE_SCHEMA);
    const paths = errorPaths(errors);
    expect(paths.has('validators[0].name')).toBe(true);
    expect(paths.has('validators[0].phase')).toBe(true);
  });

  test('validator invalid phase', () => {
    const config = {
      schema_version: '1',
      validators: [{ name: 'bad', command: 'echo', phase: 'invalid' }],
    };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors).has('validators[0].phase')).toBe(true);
  });

  test('reporter missing events', () => {
    const config = {
      schema_version: '1',
      reporters: [{ name: 'slack', command: './notify.sh' }],
    };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors).has('reporters[0].events')).toBe(true);
  });

  test('unknown field warns', () => {
    const config = { schema_version: '1', custom_field: 'value' };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors)).toEqual(new Set());
    expect(warnPaths(errors).has('custom_field')).toBe(true);
  });

  test('strict mode promotes warnings', () => {
    const config = { schema_version: '1', custom_field: 'value' };
    const errors = validateConfig(config, PROVE_SCHEMA, true);
    expect(errorPaths(errors).has('custom_field')).toBe(true);
  });

  test('scope values must be strings', () => {
    const config = { schema_version: '1', scopes: { plugin: 42 } };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors).has('scopes.plugin')).toBe(true);
  });

  test('tools wrong enabled type', () => {
    const config = {
      schema_version: '3',
      tools: { cafi: { enabled: 'yes' } },
    };
    const errors = validateConfig(config, PROVE_SCHEMA);
    expect(errorPaths(errors).has('tools.cafi.enabled')).toBe(true);
  });
});

describe('TestSettingsSchema', () => {
  test('valid hooks config', () => {
    const config = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'echo hello',
                async: true,
                timeout: 30,
              },
            ],
          },
        ],
      },
    };
    const errors = validateConfig(config, SETTINGS_SCHEMA);
    expect(errorPaths(errors)).toEqual(new Set());
  });

  test('empty settings valid', () => {
    const config = {};
    const errors = validateConfig(config, SETTINGS_SCHEMA);
    expect(errorPaths(errors)).toEqual(new Set());
  });

  test('hook missing type', () => {
    const config = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ command: 'echo hello' }],
          },
        ],
      },
    };
    const errors = validateConfig(config, SETTINGS_SCHEMA);
    const hit = errors.some((e) => e.severity === 'error' && e.path.includes('type'));
    expect(hit).toBe(true);
  });

  test('hook invalid type enum', () => {
    const config = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'invalid' }],
          },
        ],
      },
    };
    const errors = validateConfig(config, SETTINGS_SCHEMA);
    const hit = errors.some((e) => e.severity === 'error' && e.path.includes('type'));
    expect(hit).toBe(true);
  });
});
