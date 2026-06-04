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
 * `CURRENT_SCHEMA_VERSION` is the single source of truth for the latest
 * config shape. Bumping it requires a matching migration hop in `migrate.ts`
 * and a corresponding `_migrate_vN_to_vM` registry entry.
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

export const CURRENT_SCHEMA_VERSION = '11';

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
    dev_mode: {
      type: 'bool',
      required: false,
      description:
        'Run prove from the working-tree source instead of the installed ' +
        '`claude-prove` binary. When true, user-facing codegen (CLAUDE.md, ' +
        'agent prompts, hook templates) emits `bun run ' +
        '<pluginDir>/packages/cli/bin/run.ts <topic>`; when false (default), ' +
        'emits bare `claude-prove <topic>`. Set by plugin developers working ' +
        'from a git checkout.',
      default: false,
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
          skill: {
            type: 'str',
            required: false,
            description:
              'Skill to invoke as the gate (e.g. "claude-skills:comment-audit"); the driver runs it via the Skill tool. Mutually exclusive with command/prompt',
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
        "has { enabled: bool, scope?: 'user' | 'project', config?: object }. " +
        'The config object is free-form per tool. For acb, the supported ' +
        'config keys are base_branch and review_ui_port. The review UI ' +
        'image/tag are pinned by the tooling, never the project config.',
    },
    brief: {
      type: 'dict',
      required: false,
      fields: {
        single_pass_token_threshold: {
          type: 'int',
          required: false,
          description:
            'Token budget that splits single-pass from multipass brief ' +
            'synthesis. Episodes whose combined token count is at or below ' +
            'this threshold synthesize in one pass; above it, the episodes ' +
            'are chunked and synthesized across multiple passes.',
          default: 8000,
        },
        max_synthesis_retries: {
          type: 'int',
          required: false,
          description:
            'Retry budget for the Stage-2 brief synthesis step. On a failed ' +
            'synthesis attempt the step retries up to this many times before ' +
            'giving up.',
          default: 2,
        },
        prose_judge_on: {
          type: 'bool',
          required: false,
          description:
            'Whether the non-blocking Stage-2 prose judge runs. When true, ' +
            'the judge scores synthesized prose for quality without gating ' +
            'the pipeline; when false, the judge is skipped entirely.',
          default: true,
        },
      },
      description: 'Agent Change Brief synthesis settings',
    },
    memory: {
      type: 'dict',
      required: false,
      fields: {
        stale_threshold_days: {
          type: 'int',
          required: false,
          description:
            'Age in days past which a decision record is reported stale by ' +
            'the decision review-stale report. Report-only — staleness never ' +
            'prunes or supersedes a decision.',
          default: 90,
        },
      },
      description: 'Durable-memory and decision-record settings',
    },
    decomposition: {
      type: 'dict',
      required: false,
      fields: {
        auto_accept_through: {
          type: 'str',
          required: false,
          enum: ['none', 'epic', 'story', 'task'],
          description:
            'Decompose layer through which children are auto-promoted ' +
            'backlog->ready without a human accept gate. Layers order ' +
            'epic -> story -> task; every layer at or above the named one ' +
            "auto-accepts and the gate still fires below it. 'none' is the " +
            'off setting: the accept gate fires at every layer.',
          default: 'none',
        },
      },
      description: 'Decompose-ladder settings',
    },
    artifacts: {
      type: 'dict',
      required: false,
      fields: {
        html_open: {
          type: 'str',
          required: false,
          description:
            'Shell command template used by `--open` (on `report` and ' +
            '`intake render`) to open a written HTML artifact. A `{file}` ' +
            'placeholder is replaced with the quoted artifact path; a ' +
            'template without the placeholder gets the path appended. ' +
            "Examples: 'cursor {file}' (editor embedded preview), " +
            "'open -a Safari {file}', 'xdg-open {file}'. Empty/absent = " +
            'the platform default opener (macOS open, Windows start, else ' +
            'xdg-open).',
          default: '',
        },
      },
      description: 'Rendered-artifact handling (HTML opener preferences)',
    },
    triggers: {
      type: 'list',
      required: false,
      items: {
        type: 'dict',
        fields: {
          on: {
            type: 'str',
            required: true,
            enum: [
              'backlog',
              'proposed',
              'accepted',
              'ready',
              'in_progress',
              'review',
              'blocked',
              'done',
              'cancelled',
            ],
            description:
              'Task status whose entry fires this binding (the status-transition target — e.g. "accepted" fires the next-layer decompose)',
          },
          workflow: {
            type: 'str',
            required: true,
            description:
              'Bound next-action the reconciler surfaces when a task enters `on` (a workflow name or a short next-action label)',
          },
          description: {
            type: 'str',
            required: false,
            description: 'Human-readable note on what this binding is for',
            default: '',
          },
        },
      },
      description:
        'Declared trigger bindings: status-transition -> bound next-action. The scrum reconciler consults this table on session transitions (session-start / subagent-stop / stop) and surfaces the bound action via the session-start digest and next-ready. No resident evaluator — bindings fire only when a session reconciles; intra-run, a workflow script branches directly.',
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
      description: 'Tool registry tag — identifies which prove tool owns this hook entry',
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
