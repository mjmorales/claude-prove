import * as vscode from 'vscode';
import type { IntentGroup, ChangeSetRef } from '@acb/core';
import { AcbGitContentProvider } from './git-content-provider.js';
import { parseRange } from './editor.js';

/**
 * Tracks diff editor tabs opened per intent group so we can
 * auto-close the previous group's tabs when a new group opens.
 */
export class DiffTabTracker {

  /**
   * Snapshot tabs before opening diffs so we can identify which
   * tabs were added by the open operation.
   */
  snapshotTabs(): Set<string> {
    const ids = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        ids.add(this.tabKey(tab));
      }
    }
    return ids;
  }

  /**
   * Close tabs opened by the previous group, then record the
   * new group's tabs (those not in the before-snapshot).
   */
  async transition(_groupId: string, beforeSnapshot: Set<string>): Promise<void> {
    // Close previous group's tracked tabs
    await this.closeCurrent();

    // no-op: groupId tracked implicitly via _trackedTabs

    // Find newly opened tabs (diff tabs from the current operation)
    const tabsToClose: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!beforeSnapshot.has(this.tabKey(tab))) {
          tabsToClose.push(tab); // track for future close
        }
      }
    }
    // Store the tab references for later cleanup
    this._trackedTabs = tabsToClose;
  }

  private _trackedTabs: vscode.Tab[] = [];

  private async closeCurrent(): Promise<void> {
    if (this._trackedTabs.length > 0) {
      try {
        await vscode.window.tabGroups.close(this._trackedTabs);
      } catch {
        // Tabs may already be closed by the user — ignore
      }
      this._trackedTabs = [];
    }
  }

  private tabKey(tab: vscode.Tab): string {
    const input = tab.input;
    if (input && typeof input === 'object' && 'uri' in input) {
      return (input as { uri: vscode.Uri }).uri.toString();
    }
    return `${tab.label}-${tab.group.viewColumn}`;
  }

  dispose(): void {
    this._trackedTabs = [];
  }
}

/**
 * Build an acb-git: URI for a file at a given ref.
 */
function buildGitUri(filePath: string, ref: string): vscode.Uri {
  return vscode.Uri.parse(
    `${AcbGitContentProvider.scheme}:/${filePath}?ref=${encodeURIComponent(ref)}`,
  );
}

/**
 * Open diffs for all non-context files in an intent group.
 *
 * Attempts the multi-diff editor first (single tab, better UX).
 * Falls back to sequential vscode.diff tabs if unavailable.
 */
export async function openGroupDiffs(
  group: IntentGroup,
  changeSetRef: ChangeSetRef,
  tracker: DiffTabTracker,
): Promise<void> {
  // Filter out context-only file refs (no actual changes)
  const diffRefs = group.file_refs.filter((ref) => ref.view_hint !== 'context');

  if (diffRefs.length === 0) {
    vscode.window.showInformationMessage(
      `No changed files in intent group "${group.title}".`,
    );
    return;
  }

  const beforeSnapshot = tracker.snapshotTabs();

  // Build URI pairs for each file
  const resources = diffRefs.map((ref) => ({
    originalUri: buildGitUri(ref.path, changeSetRef.base_ref),
    modifiedUri: buildGitUri(ref.path, changeSetRef.head_ref),
    fileRef: ref,
  }));

  // Try multi-diff editor first
  const multiDiffOpened = await tryMultiDiffEditor(group, resources);

  if (!multiDiffOpened) {
    // Fall back to sequential vscode.diff tabs
    await openSequentialDiffs(group, resources);
  }

  // Give VS Code a moment to open tabs, then track them
  await new Promise((resolve) => setTimeout(resolve, 200));
  await tracker.transition(group.id, beforeSnapshot);
}

interface DiffResource {
  originalUri: vscode.Uri;
  modifiedUri: vscode.Uri;
  fileRef: { path: string; ranges: string[]; view_hint?: string };
}

/**
 * Attempt to open the multi-diff editor (internal VS Code API).
 * Returns true if successful, false if the command is unavailable.
 */
async function tryMultiDiffEditor(
  group: IntentGroup,
  resources: DiffResource[],
): Promise<boolean> {
  try {
    await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
      title: `Changes: ${group.title}`,
      multiDiffSourceUri: vscode.Uri.parse(
        `acb-diff-source:/${encodeURIComponent(group.id)}`,
      ),
      resources: resources.map((r) => ({
        originalUri: r.originalUri,
        modifiedUri: r.modifiedUri,
      })),
    });
    return true;
  } catch {
    // Command not available — fall back to sequential diffs
    return false;
  }
}

/**
 * Open individual vscode.diff tabs for each file in the group.
 */
async function openSequentialDiffs(
  group: IntentGroup,
  resources: DiffResource[],
): Promise<void> {
  for (let i = 0; i < resources.length; i++) {
    const { originalUri, modifiedUri, fileRef } = resources[i];
    const title = `${fileRef.path} (${group.title})`;

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      modifiedUri,
      title,
      {
        // Only focus the first diff tab
        preserveFocus: i > 0,
      },
    );

    // Scroll to the first range for changed_region hints
    if (fileRef.view_hint === 'changed_region' && fileRef.ranges.length > 0) {
      const editor = vscode.window.activeTextEditor;
      if (editor && i === 0) {
        const range = parseRange(fileRef.ranges[0]);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    }
  }
}
