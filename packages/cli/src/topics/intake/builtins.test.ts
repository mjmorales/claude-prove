/**
 * Built-in intake forms tests. Every built-in must be a valid intake/v1 spec,
 * the registry must expose the three conversational Q&A paths, and lookup must
 * resolve names and miss cleanly.
 */

import { describe, expect, test } from 'bun:test';
import { BUILTIN_FORM_NAMES, getBuiltinForm } from './builtins';
import { validateFormSpec } from './forms';

describe('built-in intake forms', () => {
  test('exposes charter, team, and decompose', () => {
    expect(BUILTIN_FORM_NAMES).toEqual(['charter', 'decompose', 'team']);
  });

  test('every built-in form is a valid intake/v1 spec', () => {
    for (const name of BUILTIN_FORM_NAMES) {
      const form = getBuiltinForm(name);
      expect(form).not.toBeNull();
      expect(validateFormSpec(form)).toEqual([]);
    }
  });

  test('the charter form gathers the three charter.md body prompts', () => {
    const form = getBuiltinForm('charter');
    expect(form?.fields.map((f) => f.id)).toEqual(['vision', 'mission', 'outcome_bet']);
    expect(form?.fields.every((f) => f.required)).toBe(true);
  });

  test('the team form mirrors the team_type and lifetime closed enums', () => {
    const form = getBuiltinForm('team');
    const teamType = form?.fields.find((f) => f.id === 'team_type');
    expect(teamType?.choices).toEqual([
      'stream_aligned',
      'platform',
      'enabling',
      'complicated_subsystem',
    ]);
    const lifetime = form?.fields.find((f) => f.id === 'lifetime');
    expect(lifetime?.choices).toEqual(['persistent', 'terminates_on_milestone']);
  });

  test('the decompose form gathers the kickoff layer enum', () => {
    const form = getBuiltinForm('decompose');
    const layer = form?.fields.find((f) => f.id === 'layer');
    expect(layer?.choices).toEqual(['epic', 'story', 'task']);
  });

  test('an unknown form name resolves to null', () => {
    expect(getBuiltinForm('nope')).toBeNull();
  });
});
