# Agent Change Brief (ACB) -- Specification

**Version:** 0.1 (Draft)
**Status:** Draft
**Date:** 2026-03-19
**Authors:** Manuel Morales, Claude Opus 4.6

---

## 1. Purpose

Git diffs organize code changes by file path. When the author is an AI agent, human reviewers need changes organized by declared intent so they can evaluate whether each change was grounded in the task, whether agent judgment calls were sound, and whether anything was changed without justification. The Agent Change Brief (ACB) is a structured JSON document that reorganizes a code change set by intent, surfaces agent decisions explicitly, and enables per-group accept/reject review. A companion review state document tracks reviewer responses. Both formats are defined in this specification.

## 2. Scope

### 2.1 In Scope

This specification defines:

- The `.acb.json` document format (the ACB Document), including all fields, types, and constraints.
- The `.acb-review.json` document format (the Review State Document), including all fields, types, and constraints.
- All controlled vocabularies used by both documents.
- Validation rules that determine whether an instance of either document is well-formed.
- The hash-based linking mechanism between the two documents.

### 2.2 Out of Scope

This specification does NOT define:

- How ACB Documents are generated (prompt design, agent tooling, framework integration).
- How ACB Documents are rendered for human consumption (UI, terminal, IDE plugins, markdown views).
- How ACB Documents integrate with CI pipelines, merge gates, or automated workflows.
- Version history, diffing, or migration of ACB Documents across revisions.
- Where ACB Documents are stored within a repository or file system.
- Transport or exchange protocols for ACB Documents.

## 3. Terminology

**ACB Document** -- A JSON file conforming to the `.acb.json` schema defined in this specification. It is the agent's structured declaration of intent over a code change set. Once generated, it is immutable.

**Review State Document** -- A JSON file conforming to the `.acb-review.json` schema defined in this specification. It is the reviewer's mutable response to an ACB Document, linked by the ACB Document's content hash.

**Change Set** -- The set of all lines added, modified, or deleted in a git diff that the ACB Document describes. The ACB Document does not define the change set; it references one.

**Intent Group** -- A named collection of file references within the ACB Document that share a common purpose. Intent groups are the primary unit of review. Every changed line in the change set MUST belong to at least one intent group.

**Classification** -- A label on an intent group that describes the relationship between the group's changes and the task statement. One of three enumerated values defined in Section 5.3.

**Ambiguity Tag** -- A label indicating a specific type of uncertainty or gap in the task that the agent navigated. One of five enumerated values defined in Section 5.4.

**Annotation** -- A structured note attached to an intent group that surfaces agent reasoning, context, or concerns. One of three enumerated types defined in Section 5.5.

**File Reference** -- A structured pointer to one or more line ranges within a file in the change set. File references never contain code; they reference locations only.

**Causal Link** -- A directional reference from one entity (intent group or annotation) to another, expressing that the source caused or necessitated the target.

**Negative Space Entry** -- A record of a file or region the agent examined but deliberately did not change, with a stated reason.

**Open Question** -- A decision the agent flagged as needing human input, including the default behavior the agent implemented in the absence of that input.

**Task Statement** -- The verbatim text of the task given to the agent. For multi-turn tasks, all turns with boundaries marked. This is the ground truth against which intent group classifications are evaluated.

**Content Hash** -- The SHA-256 hash of the ACB Document's byte content, used by the Review State Document to reference a specific ACB Document version.

**View Hint** -- An advisory label on a file reference that suggests how a renderer might display the referenced region. View hints are non-normative recommendations to rendering tools.

## 4. Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

A conformant ACB Document is a JSON file that satisfies all MUST and MUST NOT requirements in Section 5 and all validation rules in Section 7.

A conformant Review State Document is a JSON file that satisfies all MUST and MUST NOT requirements in Section 6 and all validation rules in Section 7.

A conformant producer is any system that generates conformant ACB Documents.

A conformant reviewer tool is any system that generates conformant Review State Documents.

## 5. ACB Document (`.acb.json`)

### 5.1 Top-Level Structure

A conformant ACB Document MUST be a single JSON object with the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `acb_version` | string | MUST | The version of this specification the document conforms to. For this version: `"0.1"`. |
| `id` | string | MUST | A unique identifier for this ACB Document. MUST be a UUID v4. |
| `change_set_ref` | object | MUST | Identifies the change set this ACB describes. See Section 5.2. |
| `task_statement` | object | MUST | The verbatim task given to the agent. See Section 5.6. |
| `intent_groups` | array | MUST | Ordered array of intent group objects. MUST contain at least one element. See Section 5.7. |
| `open_questions` | array | MAY | Array of open question objects. See Section 5.9. If absent, treated as empty. |
| `negative_space` | array | MAY | Array of negative space entry objects. See Section 5.10. If absent, treated as empty. |
| `generated_at` | string | MUST | ISO 8601 timestamp (UTC) of when the ACB Document was generated. Format: `YYYY-MM-DDTHH:MM:SSZ`. |
| `agent_id` | string | SHOULD | An identifier for the agent or system that generated the ACB Document. No format constraint beyond non-empty string. |

A conformant ACB Document MUST NOT contain fields not defined in this specification at the top level. Implementations that need to carry additional metadata SHOULD use the `extensions` pattern defined in Section 5.11.

### 5.2 Change Set Reference

The `change_set_ref` object identifies the git diff the ACB Document describes.

| Field | Type | Required | Description |
|---|---|---|---|
| `base_ref` | string | MUST | The git ref (commit SHA, branch, or tag) of the base of the diff. |
| `head_ref` | string | MUST | The git ref of the head of the diff. |
| `repository` | string | MAY | Repository identifier (e.g., `owner/repo`). If absent, the ACB is assumed to describe a diff in the repository where it resides. |

### 5.3 Classification Values

Every intent group carries exactly one classification. The complete set of valid classification values is:

| Value | Meaning |
|---|---|
| `explicit` | The task directly and unambiguously required this change. The `task_grounding` field MUST trace to a specific statement or turn in the task statement. |
| `inferred` | The change is a logically necessary consequence of the task but was not directly stated. The `task_grounding` field MUST explain the inferential chain. |
| `speculative` | The change is an agent judgment call, not required by the task. Flags the group for heightened reviewer attention. The `task_grounding` field MUST explain the agent's reasoning. |

No other classification values are valid.

### 5.4 Ambiguity Tags

Ambiguity tags indicate specific types of uncertainty the agent navigated. The complete set of valid ambiguity tag values is:

| Value | Meaning |
|---|---|
| `underspecified` | The task required a concrete decision but did not provide needed information. The agent filled the gap with a default or convention. |
| `conflicting_signals` | The task contained contradictory direction. The agent chose one interpretation. |
| `assumption` | The agent assumed an unstated constraint not derivable from the codebase or task. |
| `scope_creep` | The change extends beyond the task scope. MUST only appear on intent groups with classification `speculative`. |
| `convention` | The agent followed common practice with no task grounding. When this tag is present, the `task_grounding` field MUST state which convention was followed. |

No other ambiguity tag values are valid.

An intent group MAY carry zero or more ambiguity tags. When present, the `ambiguity_tags` array MUST contain only values from the table above, with no duplicates.

### 5.5 Annotation Types

Annotations surface agent reasoning, context, or concerns within an intent group. The complete set of valid annotation type values is:

| Value | Meaning | Constraints |
|---|---|---|
| `judgment_call` | The agent made a non-trivial decision. States alternatives considered. | MUST carry at least one ambiguity tag in the annotation's `ambiguity_tags` field. Reviewer SHOULD accept or override. |
| `note` | Factual context the reviewer would otherwise have to reconstruct. No judgment involved. | No additional constraints. |
| `flag` | Quality concern, deviation from expectation, or code smell. Informational. | No additional constraints. |

No other annotation type values are valid.

### 5.6 Task Statement

The `task_statement` object carries the verbatim task text.

| Field | Type | Required | Description |
|---|---|---|---|
| `turns` | array | MUST | Ordered array of turn objects. MUST contain at least one element. |

Each turn object has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `turn_id` | string | MUST | Unique identifier for this turn within the task statement. |
| `role` | string | MUST | The role of the speaker. Valid values: `"user"`, `"system"`, `"assistant"`. |
| `content` | string | MUST | Verbatim text of the turn. MUST NOT be summarized, paraphrased, or truncated. |
| `timestamp` | string | MAY | ISO 8601 timestamp of the turn, if available. |

For single-turn tasks, the `turns` array MUST contain exactly one element.

### 5.7 Intent Group

Each element of the `intent_groups` array is an object with the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | MUST | Unique identifier for this intent group within the ACB Document. |
| `title` | string | MUST | Human-readable summary of the group's purpose. SHOULD be concise (under 120 characters). |
| `classification` | string | MUST | One of the classification values defined in Section 5.3. |
| `ambiguity_tags` | array | MUST | Array of ambiguity tag values (Section 5.4). MAY be empty. MUST NOT contain duplicates. |
| `task_grounding` | string | MUST | Explanation of why this change was made, grounded in the task statement. Requirements vary by classification; see Section 5.3. |
| `file_refs` | array | MUST | Array of file reference objects (Section 5.8). MUST contain at least one element. |
| `annotations` | array | MAY | Array of annotation objects. If absent, treated as empty. |
| `causal_links` | array | MAY | Array of causal link objects. If absent, treated as empty. |

The `intent_groups` array MUST be ordered so that foundational changes appear before changes they cause, when causal relationships exist between groups. When no causal relationship exists between two groups, their relative order is not constrained.

#### 5.7.1 Annotation Object

Each annotation object within an intent group has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | MUST | Unique identifier for this annotation within the ACB Document. |
| `type` | string | MUST | One of the annotation type values defined in Section 5.5. |
| `body` | string | MUST | The annotation content. For `judgment_call` type, MUST state the alternatives considered. |
| `ambiguity_tags` | array | Conditional | Array of ambiguity tag values. MUST be present and non-empty when `type` is `"judgment_call"`. MAY be present for other types. MUST NOT contain duplicates when present. |
| `file_refs` | array | MAY | Array of file reference objects pointing to the specific locations this annotation concerns. If absent, the annotation applies to the intent group as a whole. |
| `causal_links` | array | MAY | Array of causal link objects. If absent, treated as empty. |

#### 5.7.2 Causal Link Object

Each causal link object has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `target_group_id` | string | MUST | The `id` of the intent group that this entity caused or necessitated. MUST reference an existing intent group within the same ACB Document. |
| `rationale` | string | MUST | Brief explanation of the causal relationship. |

Causal links express that the containing entity (an intent group or annotation) caused or necessitated the target group's changes.

The set of all causal links in an ACB Document MUST form a directed acyclic graph (DAG). If the agent identifies a genuine circular dependency, the agent MUST surface it as an open question (Section 5.9) rather than encode a cycle.

### 5.8 File Reference

Each file reference object has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | MUST | File path relative to the repository root. MUST use forward slashes (`/`) as path separators regardless of operating system. |
| `ranges` | array | MUST | Array of line range strings. Each string MUST match the format `"N"` (single line) or `"N-M"` (inclusive range) where N and M are positive integers and N <= M. MUST contain at least one element. |
| `view_hint` | string | MAY | Advisory hint for rendering tools. See Section 5.8.1. |

Line numbers in ranges refer to lines in the head revision of the change set (the state after the change). Ranges are 1-indexed.

#### 5.8.1 View Hint Values

View hints are non-normative. Rendering tools MAY ignore them. The defined values are:

| Value | Meaning |
|---|---|
| `changed_region` | The referenced range contains the changed lines themselves. |
| `full_file` | Renderer should consider showing the full file for context. |
| `context` | The referenced range provides context for understanding changes in the same intent group but does not itself contain changes. |

Producers MAY omit view hints. Producers MUST NOT use values outside this set; if a producer has no appropriate hint, it MUST omit the field rather than invent a value.

### 5.9 Open Question

Each open question object has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | MUST | Unique identifier for this open question within the ACB Document. |
| `question` | string | MUST | The question requiring human input. |
| `context` | string | MUST | Background information needed to understand the question. |
| `default_behavior` | string | MUST | Description of what the agent implemented in the absence of human input. |
| `related_group_ids` | array | MAY | Array of intent group `id` values that this question relates to. Every value MUST reference an existing intent group. |
| `related_paths` | array | MAY | Array of file paths (same format as file reference `path` fields) that this question concerns. |

### 5.10 Negative Space Entry

Each negative space entry object has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | MUST | File path relative to the repository root. Same format as file reference `path` fields. |
| `ranges` | array | MAY | Array of line range strings (same format as file reference `ranges`). If absent, the entry applies to the entire file. |
| `reason` | string | MUST | One of the negative space reason values defined below. |
| `explanation` | string | MUST | Human-readable explanation of why this file or region was not changed. |

The complete set of valid negative space reason values is:

| Value | Meaning |
|---|---|
| `out_of_scope` | The file is relevant to the area of the codebase but the task did not require changes to it. |
| `possible_other_callers` | The agent could not confirm it was safe to modify this file or region without affecting unknown callers. |
| `intentionally_preserved` | The agent made a positive decision to leave this file or region unchanged. |
| `would_require_escalation` | A change is warranted but requires human judgment or authority the agent does not have. |

No other negative space reason values are valid.

### 5.11 Extensions

A conformant ACB Document MAY include an `extensions` field at the top level.

| Field | Type | Required | Description |
|---|---|---|---|
| `extensions` | object | MAY | A free-form JSON object for implementation-specific metadata. |

Conformant consumers MUST ignore the `extensions` field if they do not understand it. The contents of `extensions` are not governed by this specification and MUST NOT affect the interpretation of any other field.

## 6. Review State Document (`.acb-review.json`)

### 6.1 Top-Level Structure

A conformant Review State Document MUST be a single JSON object with the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `acb_version` | string | MUST | The version of this specification the document conforms to. For this version: `"0.1"`. |
| `acb_hash` | string | MUST | The SHA-256 content hash of the ACB Document this review applies to, encoded as a lowercase hexadecimal string (64 characters). |
| `acb_id` | string | MUST | The `id` field from the referenced ACB Document. Provided for human readability; the `acb_hash` is the authoritative link. |
| `reviewer` | string | MUST | Identifier of the reviewer. No format constraint beyond non-empty string. |
| `group_verdicts` | array | MUST | Array of group verdict objects. See Section 6.2. |
| `question_answers` | array | MAY | Array of question answer objects. See Section 6.3. If absent, treated as empty. |
| `overall_verdict` | string | MUST | One of the overall verdict values defined in Section 6.4. |
| `overall_comment` | string | MAY | Free-text comment on the change set as a whole. |
| `updated_at` | string | MUST | ISO 8601 timestamp (UTC) of the most recent update. Format: `YYYY-MM-DDTHH:MM:SSZ`. |

### 6.2 Group Verdict

Each group verdict object has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `group_id` | string | MUST | The `id` of the intent group this verdict applies to. MUST correspond to an intent group in the referenced ACB Document. |
| `verdict` | string | MUST | One of the group verdict values defined below. |
| `comment` | string | MAY | Free-text reviewer comment on this group. |
| `annotation_responses` | array | MAY | Array of annotation response objects. See Section 6.2.1. If absent, treated as empty. |

The complete set of valid group verdict values is:

| Value | Meaning |
|---|---|
| `accepted` | The reviewer approves the changes in this intent group. |
| `rejected` | The reviewer does not approve the changes in this intent group. A `comment` SHOULD be provided explaining the rejection. |
| `needs_discussion` | The reviewer requires further discussion before rendering a verdict. A `comment` SHOULD be provided. |
| `pending` | The reviewer has not yet evaluated this intent group. |

No other group verdict values are valid.

#### 6.2.1 Annotation Response

Each annotation response object has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `annotation_id` | string | MUST | The `id` of the annotation this response applies to. MUST correspond to an annotation in the referenced ACB Document. |
| `response` | string | MUST | The reviewer's response. For `judgment_call` annotations, this SHOULD state whether the reviewer accepts the agent's choice or prefers an alternative. |

### 6.3 Question Answer

Each question answer object has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `question_id` | string | MUST | The `id` of the open question this answers. MUST correspond to an open question in the referenced ACB Document. |
| `answer` | string | MUST | The reviewer's answer. |

### 6.4 Overall Verdict Values

The complete set of valid overall verdict values is:

| Value | Meaning |
|---|---|
| `approved` | The reviewer approves the change set. |
| `changes_requested` | The reviewer requires changes before approval. |
| `pending` | The reviewer has not reached an overall verdict. |

No other overall verdict values are valid.

### 6.5 Staleness Detection

If the SHA-256 hash of the current `.acb.json` file content does not match the `acb_hash` field in the Review State Document, the review is stale. Tooling that consumes Review State Documents SHOULD warn the user when a stale review is detected. A stale Review State Document is not invalid, but its verdicts cannot be assumed to apply to the current ACB Document.

## 7. Validation Rules

The following numbered rules define well-formedness for ACB Documents and Review State Documents. Each rule is independently testable. A document that violates any applicable rule is non-conformant.

### 7.1 ACB Document Rules

**Rule ACB-1: Complete coverage.** Every changed line in the change set MUST appear in the `ranges` of at least one file reference within at least one intent group. A changed line not accounted for by any intent group is a spec violation.

**Rule ACB-2: Explicit grounding.** Every intent group with classification `explicit` MUST have a `task_grounding` value that is traceable to a specific turn in the `task_statement`. "Traceable" means the grounding text identifies the turn (by `turn_id` or by quoting the relevant passage) and explains the connection.

**Rule ACB-3: Non-empty grounding.** Every intent group with classification `inferred` or `speculative` MUST have a non-empty `task_grounding` value.

**Rule ACB-4: Judgment call tags.** Every annotation with type `judgment_call` MUST have a non-empty `ambiguity_tags` array containing only values from Section 5.4.

**Rule ACB-5: Causal link targets exist.** Every `target_group_id` in a causal link object MUST reference the `id` of an existing intent group in the same ACB Document.

**Rule ACB-6: Unique identifiers.** All `id` values across intent groups, annotations, and open questions within a single ACB Document MUST be unique. No two entities in the document MAY share an `id`.

**Rule ACB-7: Verbatim task.** The `task_statement` field MUST contain the original task instruction given to the agent. The content MUST NOT be summarized, paraphrased, or truncated.

**Rule ACB-8: Acyclic causal graph.** The directed graph formed by all causal links in the document MUST be acyclic. If a genuine circular dependency exists, it MUST be surfaced as an open question (Section 5.9) and the cycle MUST NOT appear in the causal links.

**Rule ACB-9: Scope creep tag constraint.** The ambiguity tag `scope_creep` MUST only appear on intent groups (in the group-level `ambiguity_tags` array) whose classification is `speculative`. If `scope_creep` appears on an intent group with any other classification, the document is non-conformant.

**Rule ACB-10: Open question references exist.** Every value in an open question's `related_group_ids` array MUST reference the `id` of an existing intent group in the same ACB Document.

**Rule ACB-11: Non-empty intent groups.** The `intent_groups` array MUST contain at least one element.

**Rule ACB-12: Non-empty file refs.** Every intent group's `file_refs` array MUST contain at least one element.

**Rule ACB-13: Valid range format.** Every range string in a file reference's `ranges` array MUST match the pattern `^[1-9][0-9]*(-[1-9][0-9]*)?$`. For range strings of the form `"N-M"`, N MUST be less than or equal to M.

### 7.2 Review State Document Rules

**Rule REV-1: Valid hash format.** The `acb_hash` field MUST be a lowercase hexadecimal string of exactly 64 characters (representing a SHA-256 hash).

**Rule REV-2: Complete group coverage.** The `group_verdicts` array MUST contain exactly one entry for every intent group in the referenced ACB Document. No intent group MAY be omitted and no extra entries MAY be present.

**Rule REV-3: Valid verdict values.** Every `verdict` field in a group verdict MUST be one of the values defined in Section 6.2. Every `overall_verdict` MUST be one of the values defined in Section 6.4.

**Rule REV-4: Annotation response targets exist.** Every `annotation_id` in an annotation response MUST correspond to an annotation in the referenced ACB Document.

**Rule REV-5: Question answer targets exist.** Every `question_id` in a question answer MUST correspond to an open question in the referenced ACB Document.

**Rule REV-6: Non-empty reviewer.** The `reviewer` field MUST be a non-empty string.

## 8. Security / Privacy Considerations

**Task statement exposure.** The ACB Document contains a verbatim copy of the task given to the agent. If the task includes sensitive information (credentials, internal URLs, personal data), that information will be present in the ACB Document. Producers SHOULD warn users when generating ACB Documents for tasks that may contain sensitive content. Organizations MAY define policies for redacting sensitive content from task statements, but any such redaction violates Rule ACB-7 and MUST be documented in the `extensions` field with key `"task_redaction_policy"`.

**Review state attribution.** The Review State Document contains a `reviewer` field that identifies the reviewer. Systems that store or transmit Review State Documents SHOULD consider whether reviewer identity requires protection under applicable privacy policies.

**No code content.** By design, the ACB Document contains no source code. It contains file paths and line numbers, which may reveal repository structure. Organizations SHOULD assess whether path and line number metadata constitutes sensitive information in their context.

## 9. Change Log

| Version | Date | Summary |
|---|---|---|
| 0.1 | 2026-03-19 | Initial draft. Defines ACB Document and Review State Document formats, all controlled vocabularies, and validation rules. |

## Appendix A: Example ACB Document (Informative)

This appendix is non-normative. It illustrates a minimal conformant ACB Document.

```json
{
  "acb_version": "0.1",
  "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "change_set_ref": {
    "base_ref": "abc1234",
    "head_ref": "def5678"
  },
  "task_statement": {
    "turns": [
      {
        "turn_id": "turn-1",
        "role": "user",
        "content": "Add input validation to the login endpoint. Reject empty usernames."
      }
    ]
  },
  "intent_groups": [
    {
      "id": "group-1",
      "title": "Add username validation to login handler",
      "classification": "explicit",
      "ambiguity_tags": [],
      "task_grounding": "Turn turn-1 directly requests: 'Add input validation to the login endpoint. Reject empty usernames.'",
      "file_refs": [
        {
          "path": "src/auth/login.go",
          "ranges": ["15-28"],
          "view_hint": "changed_region"
        }
      ],
      "annotations": [
        {
          "id": "ann-1",
          "type": "note",
          "body": "Validation uses the existing ValidationError type already defined in src/errors/errors.go."
        }
      ]
    },
    {
      "id": "group-2",
      "title": "Add test for empty username rejection",
      "classification": "inferred",
      "ambiguity_tags": [],
      "task_grounding": "Validation logic requires test coverage; the codebase has existing test patterns in src/auth/login_test.go.",
      "file_refs": [
        {
          "path": "src/auth/login_test.go",
          "ranges": ["45-62"],
          "view_hint": "changed_region"
        }
      ]
    }
  ],
  "negative_space": [
    {
      "path": "src/auth/signup.go",
      "reason": "out_of_scope",
      "explanation": "Signup endpoint has similar validation gaps but the task specifically targets login."
    }
  ],
  "generated_at": "2026-03-19T14:30:00Z",
  "agent_id": "claude-opus-4.6"
}
```

## Appendix B: Example Review State Document (Informative)

This appendix is non-normative. It illustrates a Review State Document corresponding to the ACB Document in Appendix A.

```json
{
  "acb_version": "0.1",
  "acb_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "acb_id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "reviewer": "mmorales",
  "group_verdicts": [
    {
      "group_id": "group-1",
      "verdict": "accepted",
      "comment": "Validation looks correct.",
      "annotation_responses": [
        {
          "annotation_id": "ann-1",
          "response": "Acknowledged. Good use of existing error type."
        }
      ]
    },
    {
      "group_id": "group-2",
      "verdict": "accepted"
    }
  ],
  "overall_verdict": "approved",
  "updated_at": "2026-03-19T15:00:00Z"
}
```
