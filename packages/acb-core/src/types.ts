/**
 * TypeScript types for the Agent Change Brief (ACB) specification v0.1.
 * See specs/agent-change-brief.spec.md for the normative reference.
 */

// --- Section 5.3: Classification Values ---

export const CLASSIFICATIONS = ["explicit", "inferred", "speculative"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

// --- Section 5.4: Ambiguity Tags ---

export const AMBIGUITY_TAGS = [
  "underspecified",
  "conflicting_signals",
  "assumption",
  "scope_creep",
  "convention",
] as const;
export type AmbiguityTag = (typeof AMBIGUITY_TAGS)[number];

// --- Section 5.5: Annotation Types ---

export const ANNOTATION_TYPES = ["judgment_call", "note", "flag"] as const;
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];

// --- Section 5.8.1: View Hint Values ---

export const VIEW_HINTS = ["changed_region", "full_file", "context"] as const;
export type ViewHint = (typeof VIEW_HINTS)[number];

// --- Section 5.10: Negative Space Reasons ---

export const NEGATIVE_SPACE_REASONS = [
  "out_of_scope",
  "possible_other_callers",
  "intentionally_preserved",
  "would_require_escalation",
] as const;
export type NegativeSpaceReason = (typeof NEGATIVE_SPACE_REASONS)[number];

// --- Section 5.6: Task Statement ---

export const TURN_ROLES = ["user", "system", "assistant"] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

export interface Turn {
  turn_id: string;
  role: TurnRole;
  content: string;
  timestamp?: string;
}

export interface TaskStatement {
  turns: Turn[];
}

// --- Section 5.2: Change Set Reference ---

export interface ChangeSetRef {
  base_ref: string;
  head_ref: string;
  repository?: string;
}

// --- Section 5.8: File Reference ---

export interface FileRef {
  path: string;
  ranges: string[];
  view_hint?: ViewHint;
}

// --- Section 5.7.2: Causal Link ---

export interface CausalLink {
  target_group_id: string;
  rationale: string;
}

// --- Section 5.7.1: Annotation ---

export interface Annotation {
  id: string;
  type: AnnotationType;
  body: string;
  ambiguity_tags?: AmbiguityTag[];
  file_refs?: FileRef[];
  causal_links?: CausalLink[];
}

// --- Section 5.7: Intent Group ---

export interface IntentGroup {
  id: string;
  title: string;
  classification: Classification;
  ambiguity_tags: AmbiguityTag[];
  task_grounding: string;
  file_refs: FileRef[];
  annotations?: Annotation[];
  causal_links?: CausalLink[];
}

// --- Section 5.9: Open Question ---

export interface OpenQuestion {
  id: string;
  question: string;
  context: string;
  default_behavior: string;
  related_group_ids?: string[];
  related_paths?: string[];
}

// --- Section 5.10: Negative Space Entry ---

export interface NegativeSpaceEntry {
  path: string;
  ranges?: string[];
  reason: NegativeSpaceReason;
  explanation: string;
}

// --- Section 5.1: ACB Document (top-level) ---

export interface AcbDocument {
  acb_version: string;
  id: string;
  change_set_ref: ChangeSetRef;
  task_statement: TaskStatement;
  intent_groups: IntentGroup[];
  open_questions?: OpenQuestion[];
  negative_space?: NegativeSpaceEntry[];
  generated_at: string;
  agent_id?: string;
  extensions?: Record<string, unknown>;
}

// --- Section 6.2: Group Verdict ---

export const GROUP_VERDICT_VALUES = [
  "accepted",
  "rejected",
  "needs_discussion",
  "pending",
] as const;
export type GroupVerdictValue = (typeof GROUP_VERDICT_VALUES)[number];

// --- Section 6.4: Overall Verdict ---

export const OVERALL_VERDICT_VALUES = [
  "approved",
  "changes_requested",
  "pending",
] as const;
export type OverallVerdictValue = (typeof OVERALL_VERDICT_VALUES)[number];

// --- Section 6.2.1: Annotation Response ---

export interface AnnotationResponse {
  annotation_id: string;
  response: string;
}

// --- Section 6.2: Group Verdict Object ---

export interface GroupVerdict {
  group_id: string;
  verdict: GroupVerdictValue;
  comment?: string;
  annotation_responses?: AnnotationResponse[];
}

// --- Section 6.3: Question Answer ---

export interface QuestionAnswer {
  question_id: string;
  answer: string;
}

// --- Section 6.1: Review State Document ---

export interface ReviewStateDocument {
  acb_version: string;
  acb_hash: string;
  acb_id: string;
  reviewer: string;
  group_verdicts: GroupVerdict[];
  question_answers?: QuestionAnswer[];
  overall_verdict: OverallVerdictValue;
  overall_comment?: string;
  updated_at: string;
}

// --- Utility Types ---

export interface ParseError {
  path: string;
  message: string;
  rule?: string;
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: ParseError[] };

export interface ValidationResult {
  rule: string;
  valid: boolean;
  message?: string;
  path?: string;
}
