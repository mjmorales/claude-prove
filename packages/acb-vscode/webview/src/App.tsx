import React, { useEffect, useState } from "react";
import type { AcbDocument, ReviewStateDocument } from "@acb/core";

// Acquire the VS Code API (provided by the webview host)
const vscode = (window as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi();

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

interface LoadedState {
  acb: AcbDocument;
  review: ReviewStateDocument | null;
}

export function App(): React.ReactElement {
  const [state, setState] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case "acb:load":
          setState({ acb: msg.acb, review: msg.review });
          setError(null);
          break;
        case "acb:error":
          setError(msg.message);
          break;
        case "acb:review-saved":
          // Could show a toast or update indicator
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  if (error) {
    return <div style={{ color: "var(--vscode-errorForeground)", padding: 16 }}>Error: {error}</div>;
  }

  if (!state) {
    return <div style={{ padding: 16 }}>ACB Review Loading...</div>;
  }

  const { acb, review } = state;

  return (
    <div style={{ padding: 16, fontFamily: "var(--vscode-font-family)" }}>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>ACB Review</h1>
      <p><strong>ID:</strong> {acb.id}</p>
      <p><strong>Version:</strong> {acb.acb_version}</p>
      <p><strong>Generated:</strong> {acb.generated_at}</p>
      <p><strong>Intent Groups:</strong> {acb.intent_groups.length}</p>

      {acb.intent_groups.map((group) => {
        const verdict = review?.group_verdicts.find(
          (gv) => gv.group_id === group.id,
        );
        return (
          <div
            key={group.id}
            style={{
              border: "1px solid var(--vscode-panel-border)",
              padding: 12,
              marginTop: 8,
              borderRadius: 4,
            }}
          >
            <h2 style={{ fontSize: 14, margin: 0 }}>{group.title}</h2>
            <p style={{ fontSize: 12, opacity: 0.7 }}>
              {group.classification} &middot; {group.file_refs.length} file(s)
              {verdict ? ` · ${verdict.verdict}` : ""}
            </p>
          </div>
        );
      })}

      {review && (
        <p style={{ marginTop: 16, fontSize: 12, opacity: 0.7 }}>
          Overall: {review.overall_verdict} &middot; Last updated: {review.updated_at}
        </p>
      )}
    </div>
  );
}
