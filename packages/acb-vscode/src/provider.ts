import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import type {
  AcbDocument,
  ReviewStateDocument,
  GroupVerdictValue,
  OverallVerdictValue,
} from "@acb/core";
import type { ExtToWeb, WebToExt } from "./bridge.js";

/**
 * Custom editor provider for .acb.json files.
 * Opens an ACB document in a webview panel with the React-based review UI.
 */
export class AcbReviewEditorProvider
  implements vscode.CustomTextEditorProvider
{
  public static readonly viewType = "acb.reviewEditor";

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static register(
    context: vscode.ExtensionContext,
  ): vscode.Disposable {
    const provider = new AcbReviewEditorProvider(context);
    return vscode.window.registerCustomEditorProvider(
      AcbReviewEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    );
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    // Configure webview
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview"),
      ],
    };

    webviewPanel.webview.html = this.getWebviewContent(webviewPanel.webview);

    // Parse ACB and load review state
    const sendMessage = (msg: ExtToWeb) => {
      webviewPanel.webview.postMessage(msg);
    };

    const loadDocument = () => {
      try {
        const acb: AcbDocument = JSON.parse(document.getText());
        const reviewPath = this.getReviewPath(document.uri.fsPath);
        let review: ReviewStateDocument | null = null;

        if (fs.existsSync(reviewPath)) {
          review = JSON.parse(fs.readFileSync(reviewPath, "utf-8"));
        }

        sendMessage({ type: "acb:load", acb, review });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to parse ACB document";
        sendMessage({ type: "acb:error", message });
      }
    };

    // Initial load
    loadDocument();

    // Reload when the underlying document changes
    const changeSubscription = vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          loadDocument();
        }
      },
    );

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
    });

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage((msg: WebToExt) => {
      const reviewPath = this.getReviewPath(document.uri.fsPath);

      const loadReview = (): ReviewStateDocument => {
        if (fs.existsSync(reviewPath)) {
          return JSON.parse(fs.readFileSync(reviewPath, "utf-8"));
        }
        // Create a blank review
        const acb: AcbDocument = JSON.parse(document.getText());
        return {
          acb_version: acb.acb_version,
          acb_hash: "",
          acb_id: acb.id,
          reviewer: "vscode-user",
          group_verdicts: acb.intent_groups.map((g) => ({
            group_id: g.id,
            verdict: "pending" as const,
          })),
          overall_verdict: "pending",
          updated_at: new Date().toISOString(),
        };
      };

      const saveReview = (review: ReviewStateDocument) => {
        review.updated_at = new Date().toISOString();
        fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2), "utf-8");
        sendMessage({ type: "acb:review-saved" });
      };

      try {
        switch (msg.type) {
          case "review:set-verdict": {
            const review = loadReview();
            const gv = review.group_verdicts.find(
              (g) => g.group_id === msg.groupId,
            );
            if (gv) {
              gv.verdict = msg.verdict;
              if (msg.comment !== undefined) {
                gv.comment = msg.comment;
              }
            }
            saveReview(review);
            break;
          }

          case "review:set-comment": {
            const review = loadReview();
            const gv = review.group_verdicts.find(
              (g) => g.group_id === msg.groupId,
            );
            if (gv) {
              gv.comment = msg.comment;
            }
            saveReview(review);
            break;
          }

          case "review:set-overall": {
            const review = loadReview();
            review.overall_verdict = msg.verdict;
            if (msg.comment !== undefined) {
              review.overall_comment = msg.comment;
            }
            saveReview(review);
            break;
          }

          case "review:answer-question": {
            const review = loadReview();
            const answers = review.question_answers ?? [];
            const existing = answers.find(
              (qa) => qa.question_id === msg.questionId,
            );
            if (existing) {
              existing.answer = msg.answer;
            } else {
              answers.push({
                question_id: msg.questionId,
                answer: msg.answer,
              });
            }
            review.question_answers = answers;
            saveReview(review);
            break;
          }

          case "review:annotation-response": {
            const review = loadReview();
            const gv = review.group_verdicts.find(
              (g) => g.group_id === msg.groupId,
            );
            if (gv) {
              const responses = gv.annotation_responses ?? [];
              const existing = responses.find(
                (ar) => ar.annotation_id === msg.annotationId,
              );
              if (existing) {
                existing.response = msg.response;
              } else {
                responses.push({
                  annotation_id: msg.annotationId,
                  response: msg.response,
                });
              }
              gv.annotation_responses = responses;
            }
            saveReview(review);
            break;
          }

          case "navigate:file-ref": {
            // Stub: will be implemented in Task 3.3
            vscode.window.showInformationMessage(
              `Navigate to ${msg.path} (ranges: ${msg.ranges.join(", ")})`,
            );
            break;
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to handle message";
        sendMessage({ type: "acb:error", message });
      }
    });
  }

  /**
   * Generate the HTML content for the webview, loading the bundled React app.
   */
  private getWebviewContent(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "webview",
        "index.js",
      ),
    );

    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <title>ACB Review</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Derive the review file path from an ACB file path.
   * e.g., "foo.acb.json" → "foo.acb-review.json"
   */
  public getReviewPath(acbPath: string): string {
    const dir = path.dirname(acbPath);
    const base = path.basename(acbPath);
    const reviewBase = base.replace(/\.acb\.json$/, ".acb-review.json");
    return path.join(dir, reviewBase);
  }
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
