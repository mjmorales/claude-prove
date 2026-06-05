/**
 * Deterministic, store-free derivation of a team's role-bound agent names.
 *
 * A team slug maps to exactly one agent per `TeamRole`, named
 * `team-<slug>-<role>`. The name is both the agent file's frontmatter `name`
 * and the `PROVE_AGENT` value the seat's writes stamp, so a write is always
 * attributable to a single seat. Derivation is pure: it reads only the slug and
 * the closed `TEAM_ROLES` enum — no `prove.db` lookup — so every render surface
 * (the worktree task prompt, the wave-plan schedule) computes the same names
 * from the same source of truth without touching the store.
 */

import { TEAM_ROLES } from './types';
import type { TeamRole } from './types';

/**
 * The canonical agent name for a (team, role): `team-<slug>-<role>`. This is
 * both the frontmatter `name` and the `PROVE_AGENT` value the agent's writes
 * stamp.
 */
export function teamAgentName(slug: string, role: TeamRole): string {
  return `team-${slug}-${role}`;
}

/**
 * The three role-bound agent names for a team, in canonical `TEAM_ROLES` order
 * (`tech_lead`, `engineer`, `implementer`). Derived purely from the slug — no
 * store access — so prompt surfaces share one source of truth.
 */
export function teamAgentNames(slug: string): string[] {
  return TEAM_ROLES.map((role) => teamAgentName(slug, role));
}
