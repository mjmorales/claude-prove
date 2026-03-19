import * as vscode from 'vscode';
import type { AcbDocument, Classification } from '@acb/core';
import { parseRange } from './editor.js';

interface DecorationEntry {
  ranges: string[];
  classification: Classification;
  groupTitle: string;
}

/**
 * Manages gutter/border decorations for open editors based on the active
 * ACB document. Each classification gets a distinct left-border color.
 */
export class DecorationManager {
  private readonly decorationTypes: Record<Classification, vscode.TextEditorDecorationType>;
  private fileMap: Map<string, DecorationEntry[]> = new Map();

  constructor() {
    this.decorationTypes = {
      explicit: vscode.window.createTextEditorDecorationType({
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor('charts.green'),
        isWholeLine: true,
      }),
      inferred: vscode.window.createTextEditorDecorationType({
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor('charts.yellow'),
        isWholeLine: true,
      }),
      speculative: vscode.window.createTextEditorDecorationType({
        borderWidth: '0 0 0 3px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor('charts.red'),
        isWholeLine: true,
      }),
    };
  }

  /**
   * Build the internal file map from an ACB document. Call this whenever
   * the ACB document changes or is first loaded.
   */
  setAcb(acb: AcbDocument): void {
    this.fileMap.clear();

    for (const group of acb.intent_groups) {
      for (const fileRef of group.file_refs) {
        const entries = this.fileMap.get(fileRef.path) ?? [];
        entries.push({
          ranges: fileRef.ranges,
          classification: group.classification,
          groupTitle: group.title,
        });
        this.fileMap.set(fileRef.path, entries);
      }
    }
  }

  /**
   * Apply decorations to an editor if its file matches any file in the
   * current ACB document.
   */
  updateEditor(editor: vscode.TextEditor): void {
    // Clear existing decorations on this editor
    for (const decorationType of Object.values(this.decorationTypes)) {
      editor.setDecorations(decorationType, []);
    }

    const editorPath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const entries = this.fileMap.get(editorPath);
    if (!entries) {
      return;
    }

    // Group decoration ranges by classification
    const byClassification: Record<Classification, vscode.DecorationOptions[]> = {
      explicit: [],
      inferred: [],
      speculative: [],
    };

    for (const entry of entries) {
      for (const rangeStr of entry.ranges) {
        const range = parseRange(rangeStr);
        byClassification[entry.classification].push({
          range,
          hoverMessage: new vscode.MarkdownString(`**Intent Group:** ${entry.groupTitle}`),
        });
      }
    }

    // Apply decorations
    for (const classification of ['explicit', 'inferred', 'speculative'] as Classification[]) {
      const options = byClassification[classification];
      if (options.length > 0) {
        editor.setDecorations(this.decorationTypes[classification], options);
      }
    }
  }

  /**
   * Dispose all decoration types. Call when the ACB panel is closed.
   */
  dispose(): void {
    for (const decorationType of Object.values(this.decorationTypes)) {
      decorationType.dispose();
    }
    this.fileMap.clear();
  }
}
