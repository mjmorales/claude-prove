import type {
  AcbDocument,
  ReviewStateDocument,
  GroupVerdictValue,
  OverallVerdictValue,
} from "@acb/core";

// Extension → Webview messages
export type ExtToWeb =
  | { type: "acb:load"; acb: AcbDocument; review: ReviewStateDocument | null }
  | { type: "acb:review-saved" }
  | { type: "acb:error"; message: string };

// Webview → Extension messages
export type WebToExt =
  | {
      type: "review:set-verdict";
      groupId: string;
      verdict: GroupVerdictValue;
      comment?: string;
    }
  | { type: "review:set-comment"; groupId: string; comment: string }
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
  | { type: "navigate:file-ref"; path: string; ranges: string[] };
