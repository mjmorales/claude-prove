/**
 * Post-review CLI commands: resolve, fix, discuss.
 *
 * Each reads an ACB + review state pair and generates a deterministic
 * plain-text prompt for the next action. No LLM involved — same input,
 * same output.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import type {
  AcbDocument,
  ReviewStateDocument,
  IntentGroup,
  GroupVerdict,
} from "../types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ParsedArgs {
  acbPath: string;
  reviewPath: string;
  outputPath?: string;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs | null {
  let acbPath: string | undefined;
  let reviewPath: string | undefined;
  let outputPath: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--acb") {
      acbPath = args[++i];
    } else if (arg === "--review") {
      reviewPath = args[++i];
    } else if (arg === "--output") {
      outputPath = args[++i];
    } else if (arg === "--json") {
      json = true;
    } else if (!acbPath && !arg.startsWith("--")) {
      acbPath = arg;
    }
  }

  // Default ACB path
  if (!acbPath) {
    acbPath = ".acb/review.acb.json";
  }

  acbPath = resolve(acbPath);

  if (!existsSync(acbPath)) {
    console.error(`ACB file not found: ${acbPath}`);
    return null;
  }

  // Derive review path if not specified
  if (!reviewPath) {
    const dir = dirname(acbPath);
    const base = basename(acbPath);
    const reviewBase = base.replace(/\.acb\.json$/, ".acb-review.json");
    reviewPath = join(dir, reviewBase);
  } else {
    reviewPath = resolve(reviewPath);
  }

  if (!existsSync(reviewPath)) {
    console.error(`Review file not found: ${reviewPath}`);
    console.error("Complete the review in the ACB extension first.");
    return null;
  }

  return { acbPath, reviewPath, outputPath, json };
}

function loadPair(args: ParsedArgs): { acb: AcbDocument; review: ReviewStateDocument } | null {
  try {
    const acb: AcbDocument = JSON.parse(readFileSync(args.acbPath, "utf-8"));
    const review: ReviewStateDocument = JSON.parse(readFileSync(args.reviewPath, "utf-8"));
    return { acb, review };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error reading ACB/review files: ${msg}`);
    return null;
  }
}

function output(text: string, args: ParsedArgs): void {
  if (args.outputPath) {
    const { writeFileSync } = require("node:fs");
    writeFileSync(args.outputPath, text + "\n", "utf-8");
    console.error(`Prompt written to ${args.outputPath}`);
  } else {
    console.log(text);
  }
}

function groupById(acb: AcbDocument): Map<string, IntentGroup> {
  return new Map(acb.intent_groups.map((g) => [g.id, g]));
}

function fileList(group: IntentGroup): string {
  return group.file_refs
    .map((ref) => `  ${ref.path} [${ref.ranges.join(", ")}]`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export function runResolve(args: string[]): number {
  const parsed = parseArgs(args);
  if (!parsed) return 2;

  const pair = loadPair(parsed);
  if (!pair) return 2;

  const { acb, review } = pair;
  const groups = groupById(acb);

  const lines: string[] = [];
  lines.push("# ACB Review: Approved");
  lines.push("");

  const accepted = review.group_verdicts.filter((v) => v.verdict === "accepted");
  const other = review.group_verdicts.filter((v) => v.verdict !== "accepted");

  lines.push(`${accepted.length}/${review.group_verdicts.length} intent groups accepted.`);
  if (other.length > 0) {
    lines.push(`${other.length} groups with other verdicts (see below).`);
  }
  lines.push("");

  // Annotation responses
  const responses: string[] = [];
  for (const gv of review.group_verdicts) {
    const group = groups.get(gv.group_id);
    for (const ar of gv.annotation_responses ?? []) {
      const ann = group?.annotations?.find((a) => a.id === ar.annotation_id);
      responses.push(
        `- **${ar.annotation_id}** (${group?.title ?? gv.group_id}): ${ar.response}` +
        (ann ? `\n  Original: ${ann.body}` : ""),
      );
    }
  }

  if (responses.length > 0) {
    lines.push("## Annotation Responses");
    lines.push("");
    lines.push(...responses);
    lines.push("");
  }

  // Overall
  if (review.overall_comment) {
    lines.push(`## Overall Comment`);
    lines.push("");
    lines.push(review.overall_comment);
    lines.push("");
  }

  lines.push("## Status");
  lines.push("");
  lines.push(`Overall verdict: **${review.overall_verdict}**`);
  lines.push(`Reviewed: ${review.updated_at}`);
  lines.push("");
  lines.push("Branch is ready to merge.");

  output(lines.join("\n"), parsed);
  return 0;
}

// ---------------------------------------------------------------------------
// fix
// ---------------------------------------------------------------------------

export function runFix(args: string[]): number {
  const parsed = parseArgs(args);
  if (!parsed) return 2;

  const pair = loadPair(parsed);
  if (!pair) return 2;

  const { acb, review } = pair;
  const groups = groupById(acb);

  const rejected = review.group_verdicts.filter((v) => v.verdict === "rejected");
  const discussion = review.group_verdicts.filter((v) => v.verdict === "needs_discussion");
  const accepted = review.group_verdicts.filter((v) => v.verdict === "accepted");
  const pending = review.group_verdicts.filter((v) => v.verdict === "pending");

  if (rejected.length === 0 && discussion.length === 0 && pending.length === 0) {
    console.error("No groups need fixing — all accepted. Use `acb-review resolve` instead.");
    return 1;
  }

  const lines: string[] = [];
  lines.push("# ACB Review: Changes Requested");
  lines.push("");

  // Rejected groups
  if (rejected.length > 0) {
    lines.push("## Rejected Groups");
    lines.push("");
    for (const gv of rejected) {
      renderGroupForFix(lines, gv, groups);
    }
  }

  // Needs discussion
  if (discussion.length > 0) {
    lines.push("## Groups Needing Discussion");
    lines.push("");
    for (const gv of discussion) {
      renderGroupForFix(lines, gv, groups);
    }
  }

  // Pending
  if (pending.length > 0) {
    lines.push("## Pending (not yet reviewed)");
    lines.push("");
    for (const gv of pending) {
      const group = groups.get(gv.group_id);
      lines.push(`### ${group?.title ?? gv.group_id}`);
      if (group) lines.push(fileList(group));
      lines.push("");
    }
  }

  // Accepted (for context)
  if (accepted.length > 0) {
    lines.push("## Accepted Groups (no changes needed)");
    lines.push("");
    for (const gv of accepted) {
      const group = groups.get(gv.group_id);
      lines.push(`- ${group?.title ?? gv.group_id} ✓`);
    }
    lines.push("");
  }

  // Open questions
  const unanswered = (acb.open_questions ?? []).filter((q) => {
    const answered = (review.question_answers ?? []).some((qa) => qa.question_id === q.id);
    return !answered;
  });
  if (unanswered.length > 0) {
    lines.push("## Unanswered Open Questions");
    lines.push("");
    for (const q of unanswered) {
      lines.push(`- **${q.id}**: ${q.question}`);
      lines.push(`  Context: ${q.context}`);
      lines.push(`  Default: ${q.default_behavior}`);
      lines.push("");
    }
  }

  // Instructions
  lines.push("## Instructions");
  lines.push("");
  lines.push("Fix the rejected groups above. Do not modify accepted groups.");
  lines.push("After fixing, commit with an intent manifest as usual.");
  lines.push("The ACB will be progressively reassembled on each commit.");

  output(lines.join("\n"), parsed);
  return 0;
}

function renderGroupForFix(
  lines: string[],
  gv: GroupVerdict,
  groups: Map<string, IntentGroup>,
): void {
  const group = groups.get(gv.group_id);
  lines.push(`### ${group?.title ?? gv.group_id} (${gv.verdict})`);
  lines.push("");

  if (gv.comment) {
    lines.push(`**Reviewer:** ${gv.comment}`);
    lines.push("");
  }

  if (group) {
    lines.push(`**Task grounding:** ${group.task_grounding}`);
    lines.push("");
    lines.push("**Files:**");
    lines.push(fileList(group));
    lines.push("");

    // Annotation responses
    for (const ar of gv.annotation_responses ?? []) {
      const ann = group.annotations?.find((a) => a.id === ar.annotation_id);
      if (ann) {
        lines.push(`**${ann.type}** (${ann.id}): ${ann.body}`);
        lines.push(`  → Reviewer response: ${ar.response}`);
        lines.push("");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// discuss
// ---------------------------------------------------------------------------

export function runDiscuss(args: string[]): number {
  const parsed = parseArgs(args);
  if (!parsed) return 2;

  const pair = loadPair(parsed);
  if (!pair) return 2;

  const { acb, review } = pair;
  const groups = groupById(acb);

  const discussion = review.group_verdicts.filter((v) => v.verdict === "needs_discussion");
  const unanswered = (acb.open_questions ?? []).filter((q) => {
    const answered = (review.question_answers ?? []).some((qa) => qa.question_id === q.id);
    return !answered;
  });

  if (discussion.length === 0 && unanswered.length === 0) {
    // Fall back to any group with a comment
    const withComments = review.group_verdicts.filter((v) => v.comment);
    if (withComments.length === 0) {
      console.error("No groups need discussion and no unanswered questions.");
      return 1;
    }
  }

  const lines: string[] = [];
  lines.push("# ACB Review: Discussion");
  lines.push("");

  if (discussion.length > 0) {
    lines.push("## Groups Requiring Discussion");
    lines.push("");

    for (const gv of discussion) {
      const group = groups.get(gv.group_id);
      lines.push(`### ${group?.title ?? gv.group_id}`);
      lines.push("");

      if (gv.comment) {
        lines.push(`**Reviewer:** ${gv.comment}`);
        lines.push("");
      }

      if (group) {
        lines.push(`**Agent's grounding:** ${group.task_grounding}`);
        lines.push("");
        lines.push("**Files:**");
        lines.push(fileList(group));
        lines.push("");

        // Show annotations and any responses
        for (const ann of group.annotations ?? []) {
          lines.push(`**${ann.type}** (${ann.id}): ${ann.body}`);
          const response = (gv.annotation_responses ?? []).find(
            (ar) => ar.annotation_id === ann.id,
          );
          if (response) {
            lines.push(`  → Reviewer: ${response.response}`);
          }
          lines.push("");
        }
      }
    }
  }

  // Groups with comments but not needs_discussion
  const commented = review.group_verdicts.filter(
    (v) => v.comment && v.verdict !== "needs_discussion",
  );
  if (commented.length > 0) {
    lines.push("## Reviewer Comments on Other Groups");
    lines.push("");
    for (const gv of commented) {
      const group = groups.get(gv.group_id);
      lines.push(`- **${group?.title ?? gv.group_id}** (${gv.verdict}): ${gv.comment}`);
    }
    lines.push("");
  }

  // Open questions
  if (unanswered.length > 0) {
    lines.push("## Open Questions");
    lines.push("");
    for (const q of unanswered) {
      lines.push(`### ${q.id}: ${q.question}`);
      lines.push("");
      lines.push(`**Context:** ${q.context}`);
      lines.push(`**Default behavior:** ${q.default_behavior}`);
      if (q.related_group_ids && q.related_group_ids.length > 0) {
        const titles = q.related_group_ids
          .map((id) => groups.get(id)?.title ?? id)
          .join(", ");
        lines.push(`**Related groups:** ${titles}`);
      }
      lines.push("");
    }
  }

  // Answered questions for context
  const answered = (review.question_answers ?? []);
  if (answered.length > 0) {
    lines.push("## Already Answered");
    lines.push("");
    for (const qa of answered) {
      const q = (acb.open_questions ?? []).find((oq) => oq.id === qa.question_id);
      lines.push(`- **${q?.question ?? qa.question_id}**: ${qa.answer}`);
    }
    lines.push("");
  }

  output(lines.join("\n"), parsed);
  return 0;
}
