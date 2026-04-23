/**
 * Schema definitions for `.claude/.prove.json` and `.claude/settings.json`.
 *
 * Ported 1:1 from `tools/schema/schemas.py`. Each field spec describes
 * one key in the target JSON document:
 *   - `type`:        "str" | "int" | "bool" | "list" | "dict" | "any"
 *   - `required`:    whether the key must be present (default false)
 *   - `items`:       child spec for list elements
 *   - `fields`:      known dict keys (validated strictly + warns on unknowns)
 *   - `values`:      spec for arbitrary dict values (used when `fields` absent)
 *   - `enum`:        allowed literal values for scalar types
 *   - `description`: documentation; not validator input
 *   - `default`:     default value used by migrations
 *
 * `CURRENT_SCHEMA_VERSION` ships as `"5"` here even though the Python source
 * still reports `"3"` — the v3 -> v4 migration landed in an earlier task and
 * the v4 -> v5 migration (adds `tools.scrum`) lands in Phase 12 Task 2.
 */

export type FieldType = 'str' | 'int' | 'bool' | 'list' | 'dict' | 'any';

/**
 * Discriminated spec for a single schema field. All validator, migrator, and
 * downstream consumers must read specs through this type — no `any` leakage.
 */
export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  items?: FieldSpec;
  fields?: Record<string, FieldSpec>;
  values?: FieldSpec;
  description?: string;
  default?: unknown;
  enum?: readonly (string | number | boolean)[];
}

/** Top-level schema envelope: a version tag plus the root `fields` map. */
export interface Schema {
  version: string;
  fields: Record<string, FieldSpec>;
}

export const CURRENT_SCHEMA_VERSION = '5';

/**
 * Shape of `tools.scrum` introduced in schema v5. The v4 -> v5 migration
 * seeds this block when absent with `{ enabled: true, scope: 'user',
 * config: {} }`. Kept as a named export so consumers (migrations, docs,
 * downstream skills) can reference the canonical scrum defaults without
 * re-deriving them from the generic `tools.values` shape.
 */
export const TOOL_SCRUM_SCHEMA: FieldSpec = {
  type: 'dict',
  required: false,
  fields: {
    enabled: {
      type: 'bool',
      required: true,
      description: 'scrum task management',
      default: true,
    },
    scope: {
      type: 'str',
      required: false,
      description: 'Activation scope (user or project)',
      default: 'user',
    },
    config: {
      type: 'dict',
      required: false,
      description: 'Tool-specific configuration overrides',
      default: {},
    },
  },
  description: 'Scrum task management tool activation (added in schema v5)',
};

// --- .claude/.prove.json schema ---

export const PROVE_SCHEMA: Schema = {
  version: CURRENT_SCHEMA_VERSION,
  fields: {
    schema_version: {
      type: 'str',
      required: true,
      description: 'Schema version for migration tracking',
      default: CURRENT_SCHEMA_VERSION,
    },
    scopes: {
      type: 'dict',
      required: false,
      values: { type: 'str' },
      description: 'Maps commit scope names to directory paths',
    },
    validators: {
      type: 'list',
      required: false,
      items: {
        type: 'dict',
        fields: {
          name: {
            type: 'str',
            required: true,
            description: 'Human-readable validator name',
          },
          command: {
            type: 'str',
            required: false,
            description: 'Shell command to execute',
          },
          prompt: {
            type: 'str',
            required: false,
            description: 'Path to LLM validation prompt file',
          },
          phase: {
            type: 'str',
            required: true,
            description: 'Execution phase: build, lint, test, custom, or llm',
            enum: ['build', 'lint', 'test', 'custom', 'llm'],
          },
        },
      },
      description: 'Ordered list of validation checks',
    },
    reporters: {
      type: 'list',
      required: false,
      items: {
        type: 'dict',
        fields: {
          name: {
            type: 'str',
            required: true,
            description: 'Human-readable reporter name',
          },
          command: {
            type: 'str',
            required: true,
            description: 'Shell command to execute',
          },
          events: {
            type: 'list',
            required: true,
            items: { type: 'str' },
            description: 'Event types that trigger this reporter',
          },
        },
      },
      description: 'Notification reporters for orchestrator events',
    },
    claude_md: {
      type: 'dict',
      required: false,
      fields: {
        references: {
          type: 'list',
          required: false,
          items: {
            type: 'dict',
            fields: {
              path: {
                type: 'str',
                required: true,
                description: 'File path for @ inclusion (supports ~ expansion)',
              },
              label: {
                type: 'str',
                required: true,
                description: 'Human-readable label for this reference',
              },
            },
          },
          description: 'External files to include in CLAUDE.md via @ references',
          default: [],
        },
      },
      description: 'CLAUDE.md generation settings',
    },
    tools: {
      type: 'dict',
      required: false,
      values: {
        type: 'dict',
        fields: {
          enabled: {
            type: 'bool',
            required: true,
            description: 'Whether this tool is active in the project',
            default: true,
          },
          scope: {
            type: 'str',
            required: false,
            description: 'Activation scope (user or project)',
          },
          config: {
            type: 'dict',
            required: false,
            description: 'Tool-specific configuration overrides',
          },
        },
      },
      description:
        'Tool activation state and configuration overrides. Known entries: ' +
        'acb, cafi, pcd, run_state, scrum (see TOOL_SCRUM_SCHEMA). Each entry ' +
        "has { enabled: bool, scope?: 'user' | 'project', config?: object }.",
    },
  },
};

// --- .claude/settings.json schema (prove-managed sections) ---

const HOOK_ENTRY_SCHEMA: FieldSpec = {
  type: 'dict',
  fields: {
    type: {
      type: 'str',
      required: true,
      description: 'Hook handler type',
      enum: ['command', 'http', 'prompt', 'agent'],
    },
    command: {
      type: 'str',
      required: false,
      description: 'Shell command for command-type hooks',
    },
    async: {
      type: 'bool',
      required: false,
      description: 'Run hook asynchronously',
      default: false,
    },
    timeout: {
      type: 'int',
      required: false,
      description: 'Hook timeout in seconds',
      default: 600,
    },
  },
};

const HOOK_MATCHER_SCHEMA: FieldSpec = {
  type: 'dict',
  fields: {
    matcher: {
      type: 'str',
      required: true,
      description: 'Regex pattern to match tool/agent names',
    },
    hooks: {
      type: 'list',
      required: true,
      items: HOOK_ENTRY_SCHEMA,
      description: 'Hook handlers to run on match',
    },
    _tool: {
      type: 'str',
      required: false,
      description:
        'Tool registry tag — identifies which prove tool owns this hook entry',
    },
  },
};

export const SETTINGS_SCHEMA: Schema = {
  version: CURRENT_SCHEMA_VERSION,
  fields: {
    hooks: {
      type: 'dict',
      required: false,
      values: {
        type: 'list',
        items: HOOK_MATCHER_SCHEMA,
      },
      description: 'Claude Code hook configuration keyed by event name',
    },
  },
};
