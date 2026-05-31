import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { canComputeHunks, computeHunks, hunkId } from './diffEngine';

export class DiffCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(
    private stateManager: StateManager,
  ) {}

  fire(): void {
    this._onDidChangeCodeLenses.fire();
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== 'file') return [];
    if (!this.stateManager.enabled) return [];

    // Show CodeLens in hunkwise diff tabs and normal editors. This is the
    // stable action surface; native diff handles the heavy visual rendering.
    const inActiveDiffTab = this.isActiveHunkwiseDiffTab(document.uri);
    const showNormalEditorLenses = !inActiveDiffTab && this.stateManager.showInlineDecorations;
    if (!inActiveDiffTab && !showNormalEditorLenses) return [];

    const fileState = this.stateManager.getFile(document.uri.fsPath);
    if (!fileState || fileState.status !== 'reviewing') return [];
    if (fileState.diffUnavailable || !canComputeHunks(fileState.baseline, document.getText())) return [];

    const hunks = computeHunks(fileState.baseline, document.getText());
    const lenses: vscode.CodeLens[] = [];

    for (let index = 0; index < hunks.length; index++) {
      const hunk = hunks[index];
      // CodeLens renders above the target line, so place it on the line
      // after the hunk to appear visually below the changed block.
      const afterHunk = hunk.newStart - 1 + hunk.newLines;
      const line = Math.min(afterHunk, document.lineCount - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const id = hunkId(hunk);

      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(arrow-up) Previous',
          command: 'hunkwise.previousHunk',
          arguments: [document.uri.fsPath, id],
        }),
        new vscode.CodeLens(range, {
          title: `Hunk ${index + 1}/${hunks.length}`,
          command: 'hunkwise.noop',
        }),
        new vscode.CodeLens(range, {
          title: '$(arrow-down) Next',
          command: 'hunkwise.nextHunk',
          arguments: [document.uri.fsPath, id],
        }),
        new vscode.CodeLens(range, {
          title: '$(check) Accept Hunk',
          command: 'hunkwise.codeLensAcceptHunk',
          arguments: [document.uri.fsPath, id],
        }),
        new vscode.CodeLens(range, {
          title: '$(x) Discard Hunk',
          command: 'hunkwise.codeLensDiscardHunk',
          arguments: [document.uri.fsPath, id],
        }),
      );
    }

    return lenses;
  }

  private isActiveHunkwiseDiffTab(uri: vscode.Uri): boolean {
    const fsPath = uri.fsPath;
    for (const group of vscode.window.tabGroups.all) {
      const active = group.activeTab;
      if (active?.input instanceof vscode.TabInputTextDiff) {
        if (active.input.original.scheme === 'hunkwise-baseline'
          && active.input.modified.fsPath === fsPath) {
          return true;
        }
      }
    }
    return false;
  }
}
