/**
 * Schema definitions and validator for PCD pipeline artifacts.
 *
 * Ported 1:1 from `tools/pcd/schemas.py`. Field names, types, enums, and
 * descriptions match the Python source — on-disk artifacts must stay readable
 * across the cutover.
 *
 * The field-spec DSL mirrors run-state's but diverges in three ways that force
 * a dedicated local engine rather than reuse:
 *   - Has `float` (run-state doesn't).
 *   - Has no `values` (open-dict escape hatch) or unknown-field warnings.
 *   - Emits error strings as plain `"<path>: <message>"` with no `ERROR:`
 *     prefix — pcd callers surface the raw list to users.
 *
 * Enum formatting uses Python-style `str(list)` (single-quoted strings inside
 * brackets) and the observed value uses `repr()` semantics so error messages
 * stay byte-identical to `tools/pcd/schemas.py::validate_artifact`.
 */

// ---------------------------------------------------------------------------
// Field-spec DSL
// ---------------------------------------------------------------------------

export type FieldType = 'str' | 'int' | 'float' | 'bool' | 'list' | 'dict' | 'any';

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  items?: FieldSpec;
  fields?: Record<string, FieldSpec>;
  enum?: readonly (string | number | boolean)[];
  description?: string;
}

export type SchemaSpec = FieldSpec & { type: 'dict'; fields: Record<string, FieldSpec> };

// ---------------------------------------------------------------------------
// Reusable sub-schemas
// ---------------------------------------------------------------------------

export const QUESTION_TYPES = [
  'error_handling',
  'invariant',
  'contract',
  'side_effect',
  'dependency',
] as const;

export const FINDING_CATEGORIES = [
  'error_handling',
  'invariant',
  'contract',
  'side_effect',
  'dependency',
  'performance',
  'naming',
  'dead_code',
] as const;

export const RISK_LEVELS = ['critical', 'high', 'medium', 'low'] as const;

export const COMPLEXITY_LEVELS = ['high', 'medium', 'low'] as const;

export const GENERATED_BY = ['deterministic', 'annotated'] as const;

export const EDGE_TYPES = ['internal', 'external'] as const;

export const BATCH_FINDING_SEVERITIES = ['critical', 'important', 'improvement'] as const;

export const BATCH_FINDING_CATEGORIES = [
  'structural',
  'abstraction',
  'naming',
  'error_handling',
  'performance',
  'hygiene',
] as const;

export const ANSWER_STATUSES = ['answered', 'deferred', 'not_applicable'] as const;

const QUESTION_SCHEMA: FieldSpec = {
  type: 'dict',
  fields: {
    id: {
      type: 'str',
      required: true,
      description: 'Unique question identifier',
    },
    referencing_file: {
      type: 'str',
      required: true,
      description: 'File that raised the question',
    },
    referenced_symbol: {
      type: 'str',
      required: true,
      description: 'Symbol referenced by the question',
    },
    referenced_files: {
      type: 'list',
      required: true,
      items: { type: 'str' },
      description: 'Files that may answer the question',
    },
    question_type: {
      type: 'str',
      required: true,
      enum: QUESTION_TYPES,
      description: 'Category of the question',
    },
    text: {
      type: 'str',
      required: true,
      description: 'The question text',
    },
  },
};

const FINDING_SCHEMA: FieldSpec = {
  type: 'dict',
  fields: {
    category: {
      type: 'str',
      required: true,
      enum: FINDING_CATEGORIES,
      description: 'Finding category',
    },
    brief: {
      type: 'str',
      required: true,
      description: 'Short finding description',
    },
    line_range: {
      type: 'list',
      required: true,
      items: { type: 'int' },
      description: 'Start and end line numbers',
    },
  },
};

const CLUSTER_SCHEMA: FieldSpec = {
  type: 'dict',
  fields: {
    id: {
      type: 'int',
      required: true,
      description: 'Cluster identifier',
    },
    name: {
      type: 'str',
      required: true,
      description: 'Cluster name',
    },
    files: {
      type: 'list',
      required: true,
      items: { type: 'str' },
      description: 'Files in the cluster',
    },
    internal_edges: {
      type: 'int',
      required: true,
      description: 'Number of internal dependency edges',
    },
    external_edges: {
      type: 'int',
      required: true,
      description: 'Number of external dependency edges',
    },
    semantic_label: {
      type: 'str',
      required: false,
      description: 'LLM-assigned semantic label',
    },
    module_purpose: {
      type: 'str',
      required: false,
      description: 'LLM-assigned module purpose',
    },
  },
};

const QUESTION_INDEX_ENTRY_SCHEMA: FieldSpec = {
  type: 'dict',
  fields: {
    id: {
      type: 'str',
      required: true,
      description: 'Question identifier',
    },
    from_file: {
      type: 'str',
      required: true,
      description: 'File that raised the question',
    },
    target_files: {
      type: 'list',
      required: true,
      items: { type: 'str' },
      description: 'Files targeted by the question',
    },
    question_type: {
      type: 'str',
      required: true,
      enum: QUESTION_TYPES,
      description: 'Category of the question',
    },
    routed_to_batch: {
      type: 'int',
      required: false,
      description: 'Batch this question was routed to',
    },
  },
};

// ---------------------------------------------------------------------------
// Top-level schemas
// ---------------------------------------------------------------------------

export const STRUCTURAL_MAP_SCHEMA: SchemaSpec = {
  type: 'dict',
  fields: {
    version: {
      type: 'int',
      required: true,
      description: 'Schema version',
    },
    timestamp: {
      type: 'str',
      required: true,
      description: 'ISO-8601 generation timestamp',
    },
    generated_by: {
      type: 'str',
      required: true,
      enum: GENERATED_BY,
      description: 'Generation method',
    },
    summary: {
      type: 'dict',
      required: true,
      fields: {
        total_files: {
          type: 'int',
          required: true,
          description: 'Total number of files',
        },
        total_lines: {
          type: 'int',
          required: true,
          description: 'Total line count',
        },
        languages: {
          type: 'dict',
          required: true,
          description: 'Language breakdown',
        },
      },
      description: 'Codebase summary statistics',
    },
    modules: {
      type: 'list',
      required: true,
      items: {
        type: 'dict',
        fields: {
          path: {
            type: 'str',
            required: true,
            description: 'File path',
          },
          lines: {
            type: 'int',
            required: true,
            description: 'Line count',
          },
          language: {
            type: 'str',
            required: true,
            description: 'Programming language',
          },
          exports: {
            type: 'list',
            required: true,
            items: { type: 'str' },
            description: 'Exported symbols',
          },
          imports_from: {
            type: 'list',
            required: true,
            items: { type: 'str' },
            description: 'Files imported from',
          },
          imported_by: {
            type: 'list',
            required: true,
            items: { type: 'str' },
            description: 'Files that import this module',
          },
          cafi_description: {
            type: 'str',
            required: false,
            description: 'CAFI index description',
          },
          cluster_id: {
            type: 'int',
            required: true,
            description: 'Cluster assignment',
          },
        },
      },
      description: 'Module list with dependency info',
    },
    clusters: {
      type: 'list',
      required: true,
      items: CLUSTER_SCHEMA,
      description: 'File clusters',
    },
    dependency_edges: {
      type: 'list',
      required: true,
      items: {
        type: 'dict',
        fields: {
          from: {
            type: 'str',
            required: true,
            description: 'Source file',
          },
          to: {
            type: 'str',
            required: true,
            description: 'Target file',
          },
          type: {
            type: 'str',
            required: true,
            enum: EDGE_TYPES,
            description: 'Edge type',
          },
        },
      },
      description: 'Dependency edges between modules',
    },
  },
};

export const TRIAGE_CARD_SCHEMA: SchemaSpec = {
  type: 'dict',
  fields: {
    file: {
      type: 'str',
      required: true,
      description: 'File path',
    },
    lines: {
      type: 'int',
      required: true,
      description: 'Line count',
    },
    risk: {
      type: 'str',
      required: true,
      enum: RISK_LEVELS,
      description: 'Risk level',
    },
    confidence: {
      type: 'int',
      required: true,
      description: 'Confidence score (1-5)',
    },
    complexity: {
      type: 'str',
      required: false,
      enum: COMPLEXITY_LEVELS,
      description: 'Complexity assessment',
    },
    findings: {
      type: 'list',
      required: true,
      items: FINDING_SCHEMA,
      description: 'List of findings',
    },
    key_symbols: {
      type: 'list',
      required: false,
      items: { type: 'str' },
      description: 'Important symbols in the file',
    },
    scope_boundaries: {
      type: 'list',
      required: false,
      items: { type: 'str' },
      description: 'Scope boundary markers',
    },
    questions: {
      type: 'list',
      required: true,
      items: QUESTION_SCHEMA,
      description: 'Cross-file questions',
    },
  },
};

export const TRIAGE_CARD_CLEAN_SCHEMA: SchemaSpec = {
  type: 'dict',
  fields: {
    file: {
      type: 'str',
      required: true,
      description: 'File path',
    },
    lines: {
      type: 'int',
      required: true,
      description: 'Line count',
    },
    risk: {
      type: 'str',
      required: true,
      enum: ['low'],
      description: 'Risk level (always low for clean-bill)',
    },
    confidence: {
      type: 'int',
      required: true,
      description: 'Confidence score (1-5)',
    },
    status: {
      type: 'str',
      required: true,
      enum: ['clean'],
      description: 'Clean-bill status marker',
    },
  },
};

export const TRIAGE_MANIFEST_SCHEMA: SchemaSpec = {
  type: 'dict',
  fields: {
    version: {
      type: 'int',
      required: true,
      description: 'Schema version',
    },
    stats: {
      type: 'dict',
      required: true,
      fields: {
        files_reviewed: {
          type: 'int',
          required: true,
          description: 'Number of files reviewed',
        },
        high_risk: {
          type: 'int',
          required: true,
          description: 'Number of high-risk files',
        },
        medium_risk: {
          type: 'int',
          required: true,
          description: 'Number of medium-risk files',
        },
        low_risk: {
          type: 'int',
          required: true,
          description: 'Number of low-risk files',
        },
        total_questions: {
          type: 'int',
          required: true,
          description: 'Total cross-file questions',
        },
      },
      description: 'Triage statistics',
    },
    cards: {
      type: 'list',
      required: true,
      items: { type: 'dict' },
      description: 'Triage cards (full or clean-bill format)',
    },
    question_index: {
      type: 'list',
      required: true,
      items: QUESTION_INDEX_ENTRY_SCHEMA,
      description: 'Flattened question index for routing',
    },
  },
};

export const COLLAPSED_MANIFEST_SCHEMA: SchemaSpec = {
  type: 'dict',
  fields: {
    version: {
      type: 'int',
      required: true,
      description: 'Schema version',
    },
    stats: {
      type: 'dict',
      required: true,
      fields: {
        total_cards: {
          type: 'int',
          required: true,
          description: 'Total triage cards before collapse',
        },
        preserved: {
          type: 'int',
          required: true,
          description: 'Cards preserved in full',
        },
        collapsed: {
          type: 'int',
          required: true,
          description: 'Cards collapsed into summaries',
        },
        compression_ratio: {
          type: 'float',
          required: true,
          description: 'Ratio of collapsed to total',
        },
      },
      description: 'Collapse statistics',
    },
    preserved_cards: {
      type: 'list',
      required: true,
      items: { type: 'dict' },
      description: 'Full triage cards that were preserved',
    },
    collapsed_summaries: {
      type: 'list',
      required: true,
      items: {
        type: 'dict',
        fields: {
          cluster_id: {
            type: 'int',
            required: true,
            description: 'Cluster identifier',
          },
          file_count: {
            type: 'int',
            required: true,
            description: 'Number of files in the collapsed group',
          },
          files: {
            type: 'list',
            required: true,
            items: { type: 'str' },
            description: 'File paths in the collapsed group',
          },
          max_risk: {
            type: 'str',
            required: true,
            description: 'Highest risk level in the group',
          },
          aggregate_signals: {
            type: 'list',
            required: true,
            items: { type: 'str' },
            description: 'Aggregated signal descriptions',
          },
        },
      },
      description: 'Collapsed cluster summaries',
    },
    question_index: {
      type: 'list',
      required: true,
      items: QUESTION_INDEX_ENTRY_SCHEMA,
      description: 'Flattened question index for routing',
    },
  },
};

export const FINDINGS_BATCH_SCHEMA: SchemaSpec = {
  type: 'dict',
  fields: {
    batch_id: {
      type: 'int',
      required: true,
      description: 'Batch identifier',
    },
    files_reviewed: {
      type: 'list',
      required: true,
      items: { type: 'str' },
      description: 'Files reviewed in this batch',
    },
    findings: {
      type: 'list',
      required: true,
      items: {
        type: 'dict',
        fields: {
          id: {
            type: 'str',
            required: true,
            description: 'Finding identifier',
          },
          severity: {
            type: 'str',
            required: true,
            enum: BATCH_FINDING_SEVERITIES,
            description: 'Finding severity',
          },
          category: {
            type: 'str',
            required: true,
            enum: BATCH_FINDING_CATEGORIES,
            description: 'Finding category',
          },
          file: {
            type: 'str',
            required: true,
            description: 'File path',
          },
          line_range: {
            type: 'list',
            required: true,
            items: { type: 'int' },
            description: 'Start and end line numbers',
          },
          title: {
            type: 'str',
            required: true,
            description: 'Finding title',
          },
          detail: {
            type: 'str',
            required: true,
            description: 'Detailed finding description',
          },
          related_triage_findings: {
            type: 'list',
            required: false,
            items: { type: 'str' },
            description: 'IDs of related triage findings',
          },
          fix_sketch: {
            type: 'str',
            required: true,
            description: 'Suggested fix approach',
          },
        },
      },
      description: 'Review findings',
    },
    answers: {
      type: 'list',
      required: true,
      items: {
        type: 'dict',
        fields: {
          question_id: {
            type: 'str',
            required: true,
            description: 'ID of the answered question',
          },
          status: {
            type: 'str',
            required: true,
            enum: ANSWER_STATUSES,
            description: 'Answer status',
          },
          answer: {
            type: 'str',
            required: true,
            description: 'Answer text',
          },
          spawned_finding: {
            type: 'str',
            required: false,
            description: 'ID of finding spawned from this answer',
          },
        },
      },
      description: 'Answers to routed questions',
    },
    new_questions: {
      type: 'list',
      required: true,
      items: QUESTION_SCHEMA,
      description: 'New cross-file questions discovered during review',
    },
  },
};

export const BATCH_DEFINITION_SCHEMA: SchemaSpec = {
  type: 'dict',
  fields: {
    batch_id: {
      type: 'int',
      required: true,
      description: 'Batch identifier',
    },
    files: {
      type: 'list',
      required: true,
      items: { type: 'str' },
      description: 'Files assigned to this batch',
    },
    triage_cards: {
      type: 'list',
      required: true,
      items: { type: 'dict' },
      description: 'Triage cards for the batch files',
    },
    cluster_context: {
      type: 'list',
      required: true,
      items: CLUSTER_SCHEMA,
      description: 'Cluster context for the batch',
    },
    routed_questions: {
      type: 'list',
      required: true,
      items: {
        type: 'dict',
        fields: {
          id: {
            type: 'str',
            required: true,
            description: 'Question identifier',
          },
          from_file: {
            type: 'str',
            required: true,
            description: 'File that raised the question',
          },
          question: {
            type: 'str',
            required: true,
            description: 'Question text',
          },
        },
      },
      description: 'Questions routed to this batch',
    },
    estimated_tokens: {
      type: 'int',
      required: true,
      description: 'Estimated token count for the batch',
    },
  },
};

export const PIPELINE_STATUS_SCHEMA: SchemaSpec = {
  type: 'dict',
  fields: {
    version: {
      type: 'int',
      required: true,
      description: 'Schema version',
    },
    started_at: {
      type: 'str',
      required: true,
      description: 'ISO-8601 pipeline start timestamp',
    },
    rounds: {
      type: 'dict',
      required: true,
      description: 'Pipeline round statuses keyed by round name',
    },
  },
};

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

export const SCHEMA_REGISTRY = {
  structural_map: STRUCTURAL_MAP_SCHEMA,
  triage_card: TRIAGE_CARD_SCHEMA,
  triage_card_clean: TRIAGE_CARD_CLEAN_SCHEMA,
  triage_manifest: TRIAGE_MANIFEST_SCHEMA,
  collapsed_manifest: COLLAPSED_MANIFEST_SCHEMA,
  findings_batch: FINDINGS_BATCH_SCHEMA,
  batch_definition: BATCH_DEFINITION_SCHEMA,
  pipeline_status: PIPELINE_STATUS_SCHEMA,
} as const satisfies Record<string, SchemaSpec>;

export type SchemaKey = keyof typeof SCHEMA_REGISTRY;

// ---------------------------------------------------------------------------
// Validation engine
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a PCD artifact against its schema. Returns `{ ok, errors }` where
 * each error string matches the Python `_validate_value` output byte-for-byte:
 *   - `"<path>: required field is missing"`
 *   - `"<path>: expected <type>, got <actual-type>"`
 *   - `"<path>: expected int, got bool"` (bool-as-int guard)
 *   - `"<path>: expected one of [<enum>], got <repr>"`
 *
 * Unknown schema key returns a single-error envelope mirroring Python's
 * early-return shape.
 */
export function validateArtifact(data: unknown, schemaName: string): ValidationResult {
  const schema = (SCHEMA_REGISTRY as Record<string, SchemaSpec | undefined>)[schemaName];
  if (schema === undefined) {
    const valid = (Object.keys(SCHEMA_REGISTRY) as string[]).slice().sort().join(', ');
    return {
      ok: false,
      errors: [`unknown schema: ${pythonRepr(schemaName)} (valid: ${valid})`],
    };
  }

  if (!isPlainObject(data)) {
    return {
      ok: false,
      errors: [`expected dict, got ${pythonTypeName(data)}`],
    };
  }

  const errors = validateFields(data, schema.fields, '');
  return { ok: errors.length === 0, errors };
}

// --- internals ---

function validateFields(
  data: Record<string, unknown>,
  fields: Record<string, FieldSpec>,
  prefix: string,
): string[] {
  const errors: string[] = [];
  for (const [fieldName, spec] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${fieldName}` : fieldName;
    if (!(fieldName in data)) {
      if (spec.required) {
        errors.push(`${path}: required field is missing`);
      }
      continue;
    }
    errors.push(...validateValue(data[fieldName], spec, path));
  }
  return errors;
}

function validateValue(value: unknown, spec: FieldSpec, path: string): string[] {
  const errors: string[] = [];
  const expected = spec.type;

  if (expected === 'any') return errors;

  if (!matchesType(value, expected)) {
    errors.push(`${path}: expected ${expected}, got ${pythonTypeName(value)}`);
    return errors;
  }

  // Python bool-is-int subclass guard: reject booleans for `int`.
  if (expected === 'int' && typeof value === 'boolean') {
    errors.push(`${path}: expected int, got bool`);
    return errors;
  }

  if (spec.enum && !spec.enum.includes(value as string | number | boolean)) {
    errors.push(`${path}: expected one of ${formatEnum(spec.enum)}, got ${pythonRepr(value)}`);
  }

  if (expected === 'list' && spec.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validateValue(value[i], spec.items, `${path}[${i}]`));
    }
  }

  if (expected === 'dict' && spec.fields && isPlainObject(value)) {
    errors.push(...validateFields(value, spec.fields, path));
  }

  return errors;
}

/**
 * Type predicate mirroring Python's `_TYPE_MAP` semantics:
 *   - `int`: integer-valued numbers and booleans (bool is an int subclass).
 *     Booleans are then rejected by the explicit guard in validateValue.
 *   - `float`: any JS number (Python maps "float" to `(int, float)`).
 *   - `dict`: plain objects (not arrays).
 */
function matchesType(value: unknown, expected: Exclude<FieldType, 'any'>): boolean {
  switch (expected) {
    case 'str':
      return typeof value === 'string';
    case 'bool':
      return typeof value === 'boolean';
    case 'int':
      return (typeof value === 'number' && Number.isInteger(value)) || typeof value === 'boolean';
    case 'float':
      return typeof value === 'number';
    case 'list':
      return Array.isArray(value);
    case 'dict':
      return isPlainObject(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Mirror Python's `type(value).__name__` for JSON types.
 */
function pythonTypeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'string':
      return 'str';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(value) ? 'int' : 'float';
    case 'object':
      return 'dict';
    default:
      return typeof value;
  }
}

/**
 * Emulate Python's `repr()` for scalars (and fall back to JSON otherwise).
 * Strings gain single quotes; booleans Title-case; None -> None.
 */
function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/**
 * Emulate Python's `str(list)` — bracketed, comma-separated values, with
 * string items rendered via `repr()`.
 */
function formatEnum(values: readonly (string | number | boolean)[]): string {
  return `[${values.map((v) => pythonRepr(v)).join(', ')}]`;
}
