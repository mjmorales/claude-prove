import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Parse a range string ("15" or "15-28") into a VS Code Range.
 * Range strings are 1-indexed; VS Code Ranges are 0-indexed.
 */
export function parseRange(range: string): vscode.Range {
  const parts = range.split('-');
  const startLine = parseInt(parts[0], 10) - 1;
  const endLine = parts.length > 1 ? parseInt(parts[1], 10) - 1 : startLine;
  return new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
}

/**
 * Navigate to a file reference: open the file, scroll to the range,
 * and apply a temporary highlight that fades after 2 seconds.
 */
export async function navigateToFileRef(
  workspaceRoot: string,
  filePath: string,
  ranges: string[]
): Promise<void> {
  const fullPath = path.join(workspaceRoot, filePath);
  const uri = vscode.Uri.file(fullPath);

  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: false,
  });

  if (ranges.length === 0) {
    return;
  }

  // Parse the first range for scrolling
  const primaryRange = parseRange(ranges[0]);
  editor.revealRange(primaryRange, vscode.TextEditorRevealType.InCenter);

  // Create a temporary highlight decoration
  const highlightDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: true,
  });

  // Apply decoration to all ranges
  const decorationRanges = ranges.map(parseRange);
  editor.setDecorations(highlightDecoration, decorationRanges);

  // Fade the highlight after 2 seconds
  setTimeout(() => {
    highlightDecoration.dispose();
  }, 2000);
}
