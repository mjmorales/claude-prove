import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import type { AcbDocument, ReviewStateDocument } from "@acb/core";
import {
  createBlankReview,
  setGroupVerdict,
  setAnnotationResponse,
  answerQuestion,
  setOverallVerdict,
  serializeReview,
} from "@acb/core";
import type { ExtToWeb, WebToExt } from "./bridge.js";
import { navigateToFileRef } from "./editor.js";
import { DecorationManager } from "./decoration-manager.js";

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

    const decorationManager = new DecorationManager();

    const loadDocument = () => {
      try {
        const acb: AcbDocument = JSON.parse(document.getText());
        const reviewPath = this.getReviewPath(document.uri.fsPath);
        let review: ReviewStateDocument | null = null;

        if (fs.existsSync(reviewPath)) {
          review = JSON.parse(fs.readFileSync(reviewPath, "utf-8"));
        }

        decorationManager.setAcb(acb);
        for (const editor of vscode.window.visibleTextEditors) {
          decorationManager.updateEditor(editor);
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

    const editorSubscription = vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor) {
          decorationManager.updateEditor(editor);
        }
      },
    );

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
      editorSubscription.dispose();
      decorationManager.dispose();
    });

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage((msg: WebToExt) => {
      const reviewPath = this.getReviewPath(document.uri.fsPath);
      const rawContent = document.getText();

      const loadReview = (): ReviewStateDocument => {
        if (fs.existsSync(reviewPath)) {
          return JSON.parse(fs.readFileSync(reviewPath, "utf-8"));
        }
        const acb: AcbDocument = JSON.parse(rawContent);
        return createBlankReview(acb, "vscode-user", rawContent);
      };

      const saveReview = (review: ReviewStateDocument) => {
        fs.writeFileSync(reviewPath, serializeReview(review), "utf-8");
        sendMessage({ type: "acb:review-saved" });
      };

      try {
        switch (msg.type) {
          case "review:set-verdict": {
            const review = setGroupVerdict(
              loadReview(),
              msg.groupId,
              msg.verdict,
              msg.comment,
            );
            saveReview(review);
            break;
          }

          case "review:set-comment": {
            const review = setGroupVerdict(
              loadReview(),
              msg.groupId,
              loadReview().group_verdicts.find(
                (g) => g.group_id === msg.groupId,
              )?.verdict ?? "pending",
              msg.comment,
            );
            saveReview(review);
            break;
          }

          case "review:set-overall": {
            const review = setOverallVerdict(
              loadReview(),
              msg.verdict,
              msg.comment,
            );
            saveReview(review);
            break;
          }

          case "review:answer-question": {
            const review = answerQuestion(
              loadReview(),
              msg.questionId,
              msg.answer,
            );
            saveReview(review);
            break;
          }

          case "review:annotation-response": {
            const review = setAnnotationResponse(
              loadReview(),
              msg.groupId,
              msg.annotationId,
              msg.response,
            );
            saveReview(review);
            break;
          }

          case "navigate:file-ref": {
            const workspaceRoot =
              vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceRoot) {
              navigateToFileRef(workspaceRoot, msg.path, msg.ranges);
            }
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
