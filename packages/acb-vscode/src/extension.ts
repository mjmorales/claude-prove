import * as vscode from "vscode";
import { AcbReviewEditorProvider } from "./provider.js";

export function activate(context: vscode.ExtensionContext): void {
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
