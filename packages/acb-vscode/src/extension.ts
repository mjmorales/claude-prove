import * as vscode from "vscode";
import { AcbReviewEditorProvider } from "./provider.js";
import { LocalGitSource } from "./diff-content-source.js";
import { AcbGitContentProvider } from "./git-content-provider.js";

export function activate(context: vscode.ExtensionContext): void {
  // Register the git content provider for diff viewing
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const gitSource = new LocalGitSource(workspaceRoot);
    const contentProvider = new AcbGitContentProvider(gitSource);
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        AcbGitContentProvider.scheme,
        contentProvider,
      ),
    );
  }

  // Register the custom editor provider for .acb.json files
  context.subscriptions.push(AcbReviewEditorProvider.register(context));

  // Register the openReview command
  context.subscriptions.push(
    vscode.commands.registerCommand("acb.openReview", () => {
      vscode.window.showInformationMessage(
        "ACB: Open Review — use File > Open to open an .acb.json file.",
      );
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up
}
