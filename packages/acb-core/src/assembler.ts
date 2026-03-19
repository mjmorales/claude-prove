/**
 * Assembler: merges per-commit IntentManifest files into a single AcbDocument.
 *
 * The assembler reads all intent manifests for a branch, merges groups that
 * share the same `id` across commits, resolves file ref overlaps, and produces
 * the final `.acb.json` per the ACB spec.
 */

import { randomUUID } from "node:crypto";
import type {
  IntentManifest,
  AcbDocument,
  IntentGroup,
  FileRef,
  NegativeSpaceEntry,
  OpenQuestion,
  Annotation,
  CausalLink,
} from "./types.js";

export interface AssemblerOptions {
  /** Base git ref (commit SHA or branch). */
  base_ref: string;
  /** Head git ref (commit SHA or branch). */
  head_ref: string;
  /** Task statement turns. If not provided, a placeholder is generated. */
  task_statement?: AcbDocument["task_statement"];
  /** Agent ID for the assembled document. */
  agent_id?: string;
}

export interface AssemblerWarning {
  type: "duplicate_file_ref" | "id_collision" | "empty_manifests";
  message: string;
}

export interface AssembleResult {
  document: AcbDocument;
  warnings: AssemblerWarning[];
}

/** Parse a range string "N" or "N-M" into [start, end]. */
function parseRange(r: string): [number, number] {
  const parts = r.split("-");
  const start = parseInt(parts[0], 10);
  const end = parts.length === 2 ? parseInt(parts[1], 10) : start;
  return [start, end];
}

/** Convert a set of line numbers to minimal merged range strings. */
function linesToRanges(lines: Set<number>): string[] {
  if (lines.size === 0) return [];
  const sorted = Array.from(lines).sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges;
}

/** Merge file refs, combining ranges for the same path. */
function mergeFileRefs(existing: FileRef[], incoming: FileRef[]): FileRef[] {
  const byPath = new Map<string, { lines: Set<number>; viewHint?: string }>();

  for (const ref of [...existing, ...incoming]) {
    if (!byPath.has(ref.path)) {
      byPath.set(ref.path, { lines: new Set(), viewHint: ref.view_hint });
    }
    const entry = byPath.get(ref.path)!;
    for (const r of ref.ranges) {
      const [start, end] = parseRange(r);
      for (let line = start; line <= end; line++) {
        entry.lines.add(line);
      }
    }
    // Prefer full_file over changed_region over context
    if (ref.view_hint === "full_file") {
      entry.viewHint = "full_file";
    } else if (ref.view_hint === "changed_region" && entry.viewHint !== "full_file") {
      entry.viewHint = "changed_region";
    }
  }

  const result: FileRef[] = [];
  for (const [path, { lines, viewHint }] of byPath) {
    const ref: FileRef = { path, ranges: linesToRanges(lines) };
    if (viewHint) ref.view_hint = viewHint as FileRef["view_hint"];
    result.push(ref);
  }
  return result;
}

/** Merge annotations, deduplicating by id. */
function mergeAnnotations(existing: Annotation[], incoming: Annotation[]): Annotation[] {
  const byId = new Map<string, Annotation>();
  for (const ann of existing) byId.set(ann.id, ann);
  for (const ann of incoming) {
    if (!byId.has(ann.id)) {
      byId.set(ann.id, ann);
    }
    // If same id exists, keep the existing one (first-commit wins)
  }
  return Array.from(byId.values());
}

/** Merge causal links, deduplicating by target_group_id. */
function mergeCausalLinks(existing: CausalLink[], incoming: CausalLink[]): CausalLink[] {
  const byTarget = new Map<string, CausalLink>();
  for (const link of existing) byTarget.set(link.target_group_id, link);
  for (const link of incoming) {
    if (!byTarget.has(link.target_group_id)) {
      byTarget.set(link.target_group_id, link);
    }
  }
  return Array.from(byTarget.values());
}

/**
 * Assemble multiple per-commit IntentManifest files into a single AcbDocument.
 *
 * Groups with the same `id` across manifests are merged: file refs are combined,
 * annotations are deduplicated, and the first-seen values for title, classification,
 * task_grounding, and ambiguity_tags win (chronologically first commit).
 */
export function assemble(
  manifests: IntentManifest[],
  options: AssemblerOptions,
): AssembleResult {
  const warnings: AssemblerWarning[] = [];

  if (manifests.length === 0) {
    warnings.push({
      type: "empty_manifests",
      message: "No intent manifests provided. The assembled ACB will contain a placeholder group.",
    });
  }

  // Sort manifests by timestamp (chronological order)
  const sorted = [...manifests].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Merge intent groups across manifests
  const groupMap = new Map<string, IntentGroup>();
  const groupOrder: string[] = [];

  for (const manifest of sorted) {
    for (const group of manifest.intent_groups) {
      if (groupMap.has(group.id)) {
        // Merge into existing group
        const existing = groupMap.get(group.id)!;
        const merged: IntentGroup = {
          ...existing,
          file_refs: mergeFileRefs(existing.file_refs, group.file_refs),
          annotations: mergeAnnotations(
            existing.annotations ?? [],
            group.annotations ?? [],
          ),
          causal_links: mergeCausalLinks(
            existing.causal_links ?? [],
            group.causal_links ?? [],
          ),
          // Merge ambiguity tags (union, deduplicated)
          ambiguity_tags: Array.from(
            new Set([...existing.ambiguity_tags, ...group.ambiguity_tags]),
          ) as IntentGroup["ambiguity_tags"],
        };
        // Clean up optional empty arrays
        if (merged.annotations!.length === 0) delete merged.annotations;
        if (merged.causal_links!.length === 0) delete merged.causal_links;
        groupMap.set(group.id, merged);
      } else {
        // New group — clone it
        groupMap.set(group.id, { ...group });
        groupOrder.push(group.id);
      }
    }
  }

  // Merge negative space entries (deduplicate by path+reason)
  const negativeSpaceMap = new Map<string, NegativeSpaceEntry>();
  for (const manifest of sorted) {
    for (const ns of manifest.negative_space ?? []) {
      const key = `${ns.path}::${ns.reason}`;
      if (!negativeSpaceMap.has(key)) {
        negativeSpaceMap.set(key, ns);
      }
    }
  }

  // Merge open questions (deduplicate by id)
  const openQuestionMap = new Map<string, OpenQuestion>();
  for (const manifest of sorted) {
    for (const oq of manifest.open_questions ?? []) {
      if (!openQuestionMap.has(oq.id)) {
        openQuestionMap.set(oq.id, oq);
      }
    }
  }

  // Build the intent groups array in order of first appearance
  const intentGroups = groupOrder.map((id) => groupMap.get(id)!);

  // Fallback if no groups
  if (intentGroups.length === 0) {
    intentGroups.push({
      id: "uncategorized",
      title: "Uncategorized changes",
      classification: "explicit",
      ambiguity_tags: [],
      task_grounding: "No intent manifests were provided for these changes.",
      file_refs: [{ path: "unknown", ranges: ["1"] }],
    });
  }

  // Build task statement
  const taskStatement = options.task_statement ?? {
    turns: [
      {
        turn_id: "turn-1",
        role: "user" as const,
        content: "Task statement unavailable — assembled from per-commit intent manifests.",
      },
    ],
  };

  const negativeSpace = Array.from(negativeSpaceMap.values());
  const openQuestions = Array.from(openQuestionMap.values());

  const doc: AcbDocument = {
    acb_version: "0.1",
    id: randomUUID(),
    change_set_ref: {
      base_ref: options.base_ref,
      head_ref: options.head_ref,
    },
    task_statement: taskStatement,
    intent_groups: intentGroups,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  if (negativeSpace.length > 0) doc.negative_space = negativeSpace;
  if (openQuestions.length > 0) doc.open_questions = openQuestions;
  if (options.agent_id) doc.agent_id = options.agent_id;

  return { document: doc, warnings };
}
