import type { GroupVerdictValue, OverallVerdictValue } from "@acb/core";

// Webview → Extension messages
// Duplicated from src/bridge.ts to avoid cross-boundary imports that break esbuild bundling.
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
