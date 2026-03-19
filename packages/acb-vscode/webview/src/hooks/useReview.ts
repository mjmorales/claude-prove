import type { GroupVerdictValue, OverallVerdictValue } from "@acb/core";
import type { WebToExt } from "../types";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let _vscodeApi: VsCodeApi | null = null;

function getVsCodeApi(): VsCodeApi {
  if (!_vscodeApi) {
    _vscodeApi = acquireVsCodeApi();
  }
  return _vscodeApi;
}

function post(msg: WebToExt): void {
  getVsCodeApi().postMessage(msg);
}

export interface ReviewActions {
  setVerdict(groupId: string, verdict: GroupVerdictValue, comment?: string): void;
  setOverall(verdict: OverallVerdictValue, comment?: string): void;
  answerQuestion(questionId: string, answer: string): void;
  respondToAnnotation(groupId: string, annotationId: string, response: string): void;
  navigateToFile(path: string, ranges: string[]): void;
}

export function useReview(): ReviewActions {
  return {
    setVerdict(groupId: string, verdict: GroupVerdictValue, comment?: string) {
      post({ type: "review:set-verdict", groupId, verdict, comment });
    },
    setOverall(verdict: OverallVerdictValue, comment?: string) {
      post({ type: "review:set-overall", verdict, comment });
    },
    answerQuestion(questionId: string, answer: string) {
      post({ type: "review:answer-question", questionId, answer });
    },
    respondToAnnotation(groupId: string, annotationId: string, response: string) {
      post({ type: "review:annotation-response", groupId, annotationId, response });
    },
    navigateToFile(path: string, ranges: string[]) {
      post({ type: "navigate:file-ref", path, ranges });
    },
  };
}
