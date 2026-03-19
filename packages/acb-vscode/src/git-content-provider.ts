import * as vscode from 'vscode';
import type { DiffContentSource } from './diff-content-source.js';

/**
 * Serves file content at virtual URIs for diff viewing.
 *
 * URI format: acb-git:/<path>?ref=<commit>
 * Example:    acb-git:/src/auth.go?ref=abc1234
 */
export class AcbGitContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'acb-git';

  constructor(private readonly source: DiffContentSource) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const filePath = uri.path.startsWith('/') ? uri.path.slice(1) : uri.path;
    const params = new URLSearchParams(uri.query);
    const ref = params.get('ref');

    if (!ref) {
      throw new Error(`Missing ref parameter in URI: ${uri.toString()}`);
    }

    return this.source.getContent(ref, filePath);
  }
}
