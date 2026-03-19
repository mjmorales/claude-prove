/**
 * Shared protocol types for messages exchanged between the VS Code
 * extension host and the ACB webview. Both esbuild bundles import
 * from this file so the two sides stay in sync.
 *
 * IMPORTANT: This file must contain ONLY pure TypeScript type
 * definitions -- no runtime code, no Node-specific imports.
 */

import type {
  AcbDocument,
  ReviewStateDocument,
  GroupVerdictValue,
  OverallVerdictValue,
} from "@acb/core";

/** Extension host -> Webview */
export type ExtToWeb =
  | { type: "acb:load"; acb: AcbDocument; review: ReviewStateDocument | null }
  | { type: "acb:review-saved" }
  | { type: "acb:error"; message: string };

/** Webview -> Extension host */
export type WebToExt =
  | {
      type: "review:set-verdict";
      groupId: string;
      verdict: GroupVerdictValue;
      comment?: string;
    }
  | {
      type: "review:set-overall";
      verdict: OverallVerdictValue;
      comment?: string;
    }
  | { type: "review:answer-question"; questionId: string; answer: string }
  | {
      type: "review:annotation-response";
      groupId: string;
      annotationId: string;
      response: string;
    }
  | { type: "navigate:file-ref"; path: string; ranges: string[] }
  | { type: "navigate:group-diff"; groupId: string };
