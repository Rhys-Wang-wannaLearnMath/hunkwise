import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { canComputeHunks, computeHunks } from './diffEngine';
import { log } from './log';

const MAX_ADDED_DECORATION_RANGES = 5000;

const addedLineDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  isWholeLine: true,
});

function editorKey(editor: vscode.TextEditor): string {
  return `${editor.document.uri.toString()}#${editor.viewColumn ?? 'embedded'}`;
}

function fingerprint(value: string | null): string {
  if (value === null) return 'null';
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  }
  return `${value.length}:${hash >>> 0}`;
}

export class DecorationManager {
  private renderSignatures: Map<string, string> = new Map();
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private degradedEditors: Set<string> = new Set();

  constructor(
    private stateManager: StateManager,
  ) {}

  refresh(editors?: readonly vscode.TextEditor[]): void {
    const targets = editors ?? vscode.window.visibleTextEditors;
    if (!editors) this.clearHiddenEditorState(targets);
    for (const editor of targets) {
      this.applyToEditor(editor);
    }
  }

  scheduleRefresh(editors?: readonly vscode.TextEditor[], delayMs: number = 75): void {
    const targets = editors ?? vscode.window.visibleTextEditors;
    for (const editor of targets) {
      const key = editorKey(editor);
      const existing = this.refreshTimers.get(key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.refreshTimers.delete(key);
        this.refresh([editor]);
      }, delayMs);
      this.refreshTimers.set(key, timer);
    }
  }

  refreshActionBar(_editor: vscode.TextEditor): void { /* actions are provided by CodeLens */ }

  private clearHiddenEditorState(visibleEditors: readonly vscode.TextEditor[]): void {
    const visibleKeys = new Set(visibleEditors.map(editorKey));
    for (const key of Array.from(this.renderSignatures.keys())) {
      if (visibleKeys.has(key)) continue;
      this.renderSignatures.delete(key);
      this.degradedEditors.delete(key);
    }
  }

  private clearEditor(editor: vscode.TextEditor, key: string): void {
    editor.setDecorations(addedLineDecoration, []);
    this.renderSignatures.delete(key);
    this.degradedEditors.delete(key);
  }

  private applyToEditor(editor: vscode.TextEditor): void {
    const keyForEditor = editorKey(editor);

    // Native diff editors already render red/green regions. Keep this manager
    // limited to normal-editor fallback highlights to avoid duplicate work.
    const isEmbeddedDiffEditor = editor.viewColumn === undefined;
    if (
      editor.document.uri.scheme !== 'file'
      || isEmbeddedDiffEditor
      || !this.stateManager.showInlineDecorations
    ) {
      this.clearEditor(editor, keyForEditor);
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const fileState = this.stateManager.getFile(filePath);
    if (!fileState || fileState.status !== 'reviewing') {
      this.clearEditor(editor, keyForEditor);
      return;
    }

    const currentText = editor.document.getText();
    if (fileState.diffUnavailable || !canComputeHunks(fileState.baseline, currentText)) {
      editor.setDecorations(addedLineDecoration, []);
      this.renderSignatures.delete(keyForEditor);
      if (!this.degradedEditors.has(keyForEditor)) {
        this.degradedEditors.add(keyForEditor);
        log(`inline decorations skipped for ${editor.document.uri.fsPath}: file-level review`);
      }
      return;
    }
    this.degradedEditors.delete(keyForEditor);

    const signature = [
      editor.document.version,
      fingerprint(fileState.baseline),
      editor.options.tabSize ?? 4,
    ].join('|');
    if (this.renderSignatures.get(keyForEditor) === signature) {
      return;
    }

    const addedRanges: vscode.Range[] = [];
    const hunks = computeHunks(fileState.baseline, currentText);
    for (const hunk of hunks) {
      if (addedRanges.length >= MAX_ADDED_DECORATION_RANGES) break;
      for (let i = 0; i < hunk.newLines; i++) {
        const lineIdx = hunk.newStart - 1 + i;
        if (lineIdx < editor.document.lineCount) {
          addedRanges.push(editor.document.lineAt(lineIdx).range);
          if (addedRanges.length >= MAX_ADDED_DECORATION_RANGES) break;
        }
      }
    }

    editor.setDecorations(addedLineDecoration, addedRanges);
    this.renderSignatures.set(keyForEditor, signature);
  }

  dispose(): void {
    addedLineDecoration.dispose();
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    this.renderSignatures.clear();
    this.degradedEditors.clear();
  }
}
