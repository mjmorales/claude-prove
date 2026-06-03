/**
 * Built-in intake forms — the three conversational Q&A paths encoded once as
 * `intake/v1` specs, so the HTML form gathers exactly the same answers the
 * interview would. Each form is a faithful second front-end to an existing
 * writer; the intake skill maps the pasted-back payload onto that writer:
 *
 *   - `charter`   → the charter.md body (vision / mission / outcome bet),
 *                   authored into the skeleton `install bootstrap-identity`
 *                   scaffolds.
 *   - `team`      → `scrum team create` + `scope-set` + `rotate` (roster).
 *   - `decompose` → the decompose-ladder kickoff inputs (the children themselves
 *                   still come from the planning subagent, not the form).
 *
 * Field ids ARE the writer's argument names where practical, so the mapping is
 * mechanical. Choice enums mirror the CLI's closed enums exactly.
 */

import type { IntakeForm } from './forms';

/** charter.md body: the three prompts the conversational bootstrap interview asks. */
const CHARTER_FORM: IntakeForm = {
  schema_version: '1',
  form: 'charter',
  title: 'Project charter',
  description: 'The charter.md body — authored into the skeleton the bootstrap scaffolds.',
  fields: [
    {
      id: 'vision',
      label: 'Vision',
      type: 'textarea',
      required: true,
      help: 'The future state this project moves toward.',
    },
    {
      id: 'mission',
      label: 'Mission',
      type: 'textarea',
      required: true,
      help: 'What it does, for whom, and why.',
    },
    {
      id: 'outcome_bet',
      label: 'Outcome bet',
      type: 'textarea',
      required: true,
      help: 'The measurable result you are betting on.',
    },
  ],
};

/** Team registry row + scope + roster — mirrors `scrum team create`/`scope-set`/`rotate`. */
const TEAM_FORM: IntakeForm = {
  schema_version: '1',
  form: 'team',
  title: 'Team',
  description: 'A team registry row, its scope globs, and its three-role roster.',
  fields: [
    {
      id: 'slug',
      label: 'Slug',
      type: 'text',
      required: true,
      placeholder: 'platform-core',
      help: 'Kebab-case team identifier; unique across the registry.',
    },
    {
      id: 'team_type',
      label: 'Team type',
      type: 'choice',
      required: true,
      choices: ['stream_aligned', 'platform', 'enabling', 'complicated_subsystem'],
    },
    {
      id: 'charter',
      label: 'Charter (one line)',
      type: 'text',
      help: 'A one-line statement of what this team owns.',
    },
    {
      id: 'lifetime',
      label: 'Lifetime',
      type: 'choice',
      choices: ['persistent', 'terminates_on_milestone'],
      default: 'persistent',
    },
    {
      id: 'terminates_on',
      label: 'Terminates on milestone',
      type: 'text',
      help: 'Milestone id — required only when lifetime is terminates_on_milestone.',
    },
    {
      id: 'scope_read',
      label: 'Read scope globs',
      type: 'text',
      placeholder: 'src/**, docs/**',
      help: 'Comma-separated globs the team may read.',
    },
    {
      id: 'scope_write',
      label: 'Write scope globs',
      type: 'text',
      placeholder: 'src/platform/**',
      help: 'Comma-separated globs the team owns; may not overlap another team.',
    },
    {
      id: 'tech_lead',
      label: 'Tech lead',
      type: 'text',
      placeholder: 'CT-…',
      help: 'Contributor id (CT-UUID) holding the tech_lead role.',
    },
    {
      id: 'engineer',
      label: 'Engineer',
      type: 'text',
      placeholder: 'CT-…',
      help: 'Contributor id (CT-UUID) holding the engineer role.',
    },
    {
      id: 'implementer',
      label: 'Implementer',
      type: 'text',
      placeholder: 'CT-…',
      help: 'Contributor id (CT-UUID) holding the implementer role.',
    },
  ],
};

/** Decompose-ladder kickoff inputs — what to decompose and into which tier. */
const DECOMPOSE_FORM: IntakeForm = {
  schema_version: '1',
  form: 'decompose',
  title: 'Decomposition kickoff',
  description:
    'Root inputs for the decompose ladder. The children come from the planner, not this form.',
  fields: [
    {
      id: 'parent',
      label: 'Parent',
      type: 'text',
      required: true,
      help: 'The id to decompose — a milestone, epic, or story (or an initiative/charter path at the root).',
    },
    {
      id: 'layer',
      label: 'Target child layer',
      type: 'choice',
      required: true,
      choices: ['epic', 'story', 'task'],
      help: 'The tier the proposed children sit at.',
    },
    {
      id: 'milestone',
      label: 'Milestone',
      type: 'text',
      help: 'Milestone id the children belong to.',
    },
    {
      id: 'context',
      label: 'Planning context',
      type: 'textarea',
      help: 'Goal, constraints, or scope notes to fold into the planner prompt.',
    },
  ],
};

/** The closed set of built-in form specs, keyed by `form` identity. */
const BUILTIN_FORMS: Record<string, IntakeForm> = {
  charter: CHARTER_FORM,
  team: TEAM_FORM,
  decompose: DECOMPOSE_FORM,
};

/** The built-in form names, sorted for stable listing. */
export const BUILTIN_FORM_NAMES: string[] = Object.keys(BUILTIN_FORMS).sort();

/** Resolve a built-in form by name, or `null` when the name is unknown. */
export function getBuiltinForm(name: string): IntakeForm | null {
  return BUILTIN_FORMS[name] ?? null;
}
