/**
 * Unit tests for the deterministic, store-free team-agent-name helpers.
 *
 * Asserts the derivation is purely slug-driven over the closed `TEAM_ROLES`
 * enum: one name per role in canonical order, `team-<slug>-<role>` shape, and
 * the multi-name list stays in lockstep with the single-name function.
 */

import { describe, expect, test } from 'bun:test';

import { teamAgentName, teamAgentNames } from './team-agent-names';
import { TEAM_ROLES } from './types';

describe('teamAgentName', () => {
  test('renders the canonical team-<slug>-<role> shape', () => {
    expect(teamAgentName('payments', 'tech_lead')).toBe('team-payments-tech_lead');
    expect(teamAgentName('payments', 'engineer')).toBe('team-payments-engineer');
    expect(teamAgentName('payments', 'implementer')).toBe('team-payments-implementer');
  });
});

describe('teamAgentNames', () => {
  test('derives the three role-bound names in TEAM_ROLES order', () => {
    expect(teamAgentNames('payments')).toEqual([
      'team-payments-tech_lead',
      'team-payments-engineer',
      'team-payments-implementer',
    ]);
  });

  test('order matches the canonical TEAM_ROLES enum exactly', () => {
    expect(teamAgentNames('infra')).toEqual(TEAM_ROLES.map((role) => `team-infra-${role}`));
  });

  test('every name agrees with teamAgentName for the same role', () => {
    const slug = 'data-platform';
    expect(teamAgentNames(slug)).toEqual(TEAM_ROLES.map((role) => teamAgentName(slug, role)));
  });

  test('a slug with hyphens forwards verbatim into each name', () => {
    expect(teamAgentNames('ml-ops')).toEqual([
      'team-ml-ops-tech_lead',
      'team-ml-ops-engineer',
      'team-ml-ops-implementer',
    ]);
  });
});
