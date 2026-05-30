import * as vscode from 'vscode';
import { StateManager } from './stateManager';
import { canComputeHunks, computeHunks, hunkId } from './diffEngine';
import { log } from './log';

const MAX_INLINE_HUNKS = 80;
const MAX_INLINE_INSETS = 140;
const MAX_ADDED_DECORATION_RANGES = 5000;

// ── Added lines ──────────────────────────────────────────────────────────────
const addedLineDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  isWholeLine: true,
});

// ── HTML helpers ─────────────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Deleted-lines inset ───────────────────────────────────────────────────────
function buildDeletedHtml(lines: string[], tabSize: number): string {
  const lineCount = Math.max(1, lines.length);
  const rows = lines.map(l => `<div class="line">${escapeHtml(l)}</div>`).join('');
  return `<!DOCTYPE html><html style="background:var(--vscode-diffEditor-removedLineBackground,rgba(255,0,0,0.1))"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body {
  background: var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1));
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  font-weight: var(--vscode-editor-font-weight, normal);
}
.line {
  height: calc(100vh / ${lineCount});
  line-height: calc(100vh / ${lineCount});
  white-space: pre;
  overflow: hidden;
  text-overflow: clip;
  tab-size: ${tabSize};
}
</style>
</head><body>${rows}</body></html>`;
}

// ── Action-bar inset ──────────────────────────────────────────────────────────
function buildActionsHtml(filePath: string, hunkId: string, ordinal: number, total: number): string {
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: visible; }
body { background: transparent; position: relative; }
.bar {
  position: absolute;
  top: 50%; left: 4px;
  transform: translateY(-50%);
  display: flex; align-items: center; gap: 4px;
}
button, .count {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #cccccc);
  border: 1px solid var(--vscode-button-border, rgba(128,128,128,0.4));
  border-radius: 2px;
  padding: 0 6px; font-size: 10px;
  font-family: var(--vscode-font-family, sans-serif);
  height: min(20px, calc(100vh - 2px)); line-height: 1;
  display: inline-flex; align-items: center; white-space: nowrap;
}
button { cursor: pointer; }
.count {
  background: transparent;
  color: var(--vscode-descriptionForeground, #999);
  border-color: transparent;
  min-width: 34px;
  justify-content: center;
}
button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.btn-nav { padding: 0 5px; }
.btn-accept {
  background: #2a7d3a;
  color: #d4f0da;
  border-color: rgba(63,185,80,0.3);
}
.btn-accept:hover { background: #256b31; }
.btn-discard {
  background: rgba(248,81,73,0.08);
  color: #c97d7a;
  border-color: rgba(248,81,73,0.25);
}
.btn-discard:hover { background: rgba(248,81,73,0.15); }
</style>
</head><body>
<div class="bar">
<button class="btn-nav" title="Previous change" onclick="previous()">↑</button>
<span class="count">${ordinal}/${total}</span>
<button class="btn-nav" title="Next change" onclick="next()">↓</button>
<button class="btn-accept" onclick="accept()">✓ Accept</button>
<button class="btn-discard" onclick="discard()">↺ Discard</button>
</div>
<script>
const vscode = acquireVsCodeApi();
function previous() { vscode.postMessage({ command: 'previous', filePath: ${JSON.stringify(filePath)}, hunkId: ${JSON.stringify(hunkId)} }); }
function next() { vscode.postMessage({ command: 'next', filePath: ${JSON.stringify(filePath)}, hunkId: ${JSON.stringify(hunkId)} }); }
function accept() { vscode.postMessage({ command: 'accept', filePath: ${JSON.stringify(filePath)}, hunkId: ${JSON.stringify(hunkId)} }); }
function discard() { vscode.postMessage({ command: 'discard', filePath: ${JSON.stringify(filePath)}, hunkId: ${JSON.stringify(hunkId)} }); }
</script>
</body></html>`;
}

interface HunkInset {
  inset: vscode.WebviewEditorInset;
  disposable: vscode.Disposable;
  disposeListener: vscode.Disposable;
  // Cache key: used to detect whether this inset can be reused
  cacheKey: string;
  disposed: boolean;
  disposing: boolean;
}

type InsetRole = 'deleted' | 'action';

function insetCacheKey(afterLine: number, height: number, role: InsetRole): string {
  return `${role}:${afterLine}:${height}`;
}

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
  // editorKey → ordered list of insets for that editor
  private insets: Map<string, HunkInset[]> = new Map();
  private renderSignatures: Map<string, string> = new Map();
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private insetUnavailableLogged = false;
  private degradedEditors: Set<string> = new Set();
  private onAction: ((command: 'accept' | 'discard' | 'previous' | 'next', filePath: string, hunkId: string) => void) | undefined;

  constructor(
    private stateManager: StateManager,
    onAction?: (command: 'accept' | 'discard' | 'previous' | 'next', filePath: string, hunkId: string) => void,
  ) {
    this.onAction = onAction;
  }

  refresh(editors?: readonly vscode.TextEditor[]): void {
    const targets = editors ?? vscode.window.visibleTextEditors;
    const diffPaths = this.diffEditorFilePaths();
    if (!editors) this.disposeHiddenEditors(targets);
    for (const editor of targets) {
      this.applyToEditor(editor, diffPaths);
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

  refreshActionBar(_editor: vscode.TextEditor): void { /* buttons live in insets */ }

  private disposeInsetList(list: HunkInset[]): void {
    for (const h of list) {
      h.disposing = true;
      h.disposeListener.dispose();
      h.disposable.dispose();
      if (!h.disposed) h.inset.dispose();
    }
  }

  private disposeHiddenEditors(visibleEditors: readonly vscode.TextEditor[]): void {
    const visibleKeys = new Set(visibleEditors.map(editorKey));
    for (const key of Array.from(this.insets.keys())) {
      if (visibleKeys.has(key)) continue;
      this.disposeInsetList(this.insets.get(key) ?? []);
      this.insets.delete(key);
      this.renderSignatures.delete(key);
      this.degradedEditors.delete(key);
    }
  }

  /**
   * Collect file paths that are open in any diff tab (git, hunkwise, etc.).
   */
  private diffEditorFilePaths(): Set<string> {
    const paths = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          paths.add(tab.input.modified.fsPath);
        }
      }
    }
    return paths;
  }

  private applyToEditor(editor: vscode.TextEditor, diffPaths: Set<string>): void {
    const filePath = editor.document.uri.fsPath;
    const keyForEditor = editorKey(editor);
    const fileState = this.stateManager.getFile(filePath);

    // Skip insets: in diff editors (viewColumn undefined), or when user disabled inline decorations
    const isInDiff = editor.viewColumn === undefined && diffPaths.has(filePath);
    const skipInsets = isInDiff || !this.stateManager.showInlineDecorations;

    if (!fileState || fileState.status !== 'reviewing' || skipInsets) {
      this.disposeInsetList(this.insets.get(keyForEditor) ?? []);
      this.insets.delete(keyForEditor);
      this.renderSignatures.delete(keyForEditor);
      this.degradedEditors.delete(keyForEditor);
      editor.setDecorations(addedLineDecoration, []);
      return;
    }

    const currentText = editor.document.getText();
    if (fileState.diffUnavailable || !canComputeHunks(fileState.baseline, currentText)) {
      this.disposeInsetList(this.insets.get(keyForEditor) ?? []);
      this.insets.delete(keyForEditor);
      this.renderSignatures.delete(keyForEditor);
      editor.setDecorations(addedLineDecoration, []);
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
      skipInsets ? 'skip' : 'show',
      editor.options.tabSize ?? 4,
    ].join('|');
    const existingForSignature = this.insets.get(keyForEditor) ?? [];
    const insetsAlive = existingForSignature.every(h => !h.disposed);
    if (this.renderSignatures.get(keyForEditor) === signature && insetsAlive) {
      return;
    }

    const addedRanges: vscode.Range[] = [];
    const tabSize = editor.options.tabSize as number || 4;
    const parsed = computeHunks(fileState.baseline, currentText);
    const inlineInsetsEnabled = this.canCreateInsets();

    // Build the desired inset specs first
    interface InsetSpec {
      afterLine: number;
      height: number;
      role: InsetRole;
      enableScripts: boolean;
      html: string;
    }
    const specs: InsetSpec[] = [];

    for (let hunkIndex = 0; hunkIndex < parsed.length; hunkIndex++) {
      const hunk = parsed[hunkIndex];
      const id = hunkId(hunk);


      if (addedRanges.length < MAX_ADDED_DECORATION_RANGES) {
        for (let i = 0; i < hunk.newLines; i++) {
          const lineIdx = hunk.newStart - 1 + i;
          if (lineIdx < editor.document.lineCount) {
            addedRanges.push(editor.document.lineAt(lineIdx).range);
            if (addedRanges.length >= MAX_ADDED_DECORATION_RANGES) break;
          }
        }
      }

      if (!inlineInsetsEnabled || parsed.length > MAX_INLINE_HUNKS || specs.length >= MAX_INLINE_INSETS) continue;

      // ── Inset placement strategy ──
      //
      // Layout order (top → bottom):
      //   [deleted inset]   red lines showing removed content
      //   [green lines]     added lines in the actual document
      //   [action bar]      Accept / Discard buttons
      //
      // ── afterLine semantics ──
      // createWebviewTextEditorInset takes a 0-based line number.
      // Internally VSCode does +1 before storing as afterLineNumber (1-based).
      // afterLineNumber=0 means "above line 1" (file top).
      // So to place an inset above line 1 we must pass afterLine = -1.
      //
      // Normal case (newLines > 0):
      //   deleted → afterLine = newStart - 2  (just above the green block)
      //   action  → afterLine = newStart + newLines - 2  (just below the green block)
      //   Different afterLines, so push order doesn't matter.
      //
      // Pure deletion (newLines == 0):
      //   Both deleted and action use afterLine = newStart - 2 (same value).
      //   VSCode stacks insets at the same afterLine with the FIRST-pushed on TOP.
      //   So we push deleted first, then action, to render deleted above action.

      const hasDeletion = hunk.removedContent.length > 0;
      const hasAddition = hunk.newLines > 0;

      // afterLine for deleted inset: just above the green block (or above its insertion point)
      const deletedAfterLine = hunk.newStart - 2; // may be -1 when newStart==1, that's correct

      let actionAfterLine: number;
      if (hasAddition) {
        actionAfterLine = hunk.newStart + hunk.newLines - 2;
      } else {
        // Pure deletion: no green block. Action bar shares the same afterLine as the
        // deleted inset. VSCode stacks insets at the same afterLine with the first-pushed
        // on top, so we rely on push order below to place deleted above action.
        actionAfterLine = deletedAfterLine;
      }

      // When multiple insets share the same afterLine, VSCode stacks them so that
      // the FIRST pushed inset appears TOPMOST.  For the normal case (deletion above
      // green lines, action below), they have different afterLines so push order
      // doesn't matter.  For pure deletion (same afterLine), we push deleted first,
      // then action, so deleted renders above action.

      if (hasDeletion) {
        specs.push({
          afterLine: Math.max(-1, deletedAfterLine),
          height: hunk.removedContent.length,
          role: 'deleted',
          enableScripts: false,
          html: buildDeletedHtml(hunk.removedContent, tabSize),
        });
      }
      if (specs.length < MAX_INLINE_INSETS) {
        specs.push({
          afterLine: actionAfterLine,
          height: 1,
          role: 'action',
          enableScripts: true,
          html: buildActionsHtml(filePath, id, hunkIndex + 1, parsed.length),
        });
      }
    }

    // Reuse existing insets when cache keys match to avoid flicker
    const existing = this.insets.get(keyForEditor) ?? [];
    const nextInsets: HunkInset[] = [];

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const key = insetCacheKey(spec.afterLine, spec.height, spec.role);
      const prev = existing[i];
      if (prev && prev.cacheKey === key && !prev.disposed) {
        // Same position/height and still alive — reuse, just update html
        prev.inset.webview.html = spec.html;
        nextInsets.push(prev);
        existing[i] = undefined as any; // mark as consumed
      } else {
        // Position changed or inset was disposed by VSCode — recreate
        const created = this.makeInset(keyForEditor, editor, spec.afterLine, spec.height, spec.html, key, spec.enableScripts);
        if (created) nextInsets.push(created);
      }
    }

    // Dispose leftover insets not reused
    for (const leftover of existing) {
      if (leftover) {
        leftover.disposing = true;
        leftover.disposeListener.dispose();
        leftover.disposable.dispose();
        if (!leftover.disposed) leftover.inset.dispose();
      }
    }

    editor.setDecorations(addedLineDecoration, addedRanges);
    this.renderSignatures.set(keyForEditor, signature);
    if (nextInsets.length > 0) {
      this.insets.set(keyForEditor, nextInsets);
    } else {
      this.insets.delete(keyForEditor);
    }
  }

  private canCreateInsets(): boolean {
    const available = typeof (vscode.window as any).createWebviewTextEditorInset === 'function';
    if (!available && !this.insetUnavailableLogged) {
      this.insetUnavailableLogged = true;
      log('createWebviewTextEditorInset unavailable; falling back to line highlights only');
    }
    return available;
  }

  private makeInset(
    editorKey: string,
    editor: vscode.TextEditor,
    afterLine: number,
    height: number,
    html: string,
    cacheKey: string,
    enableScripts: boolean,
  ): HunkInset | undefined {
    try {
      const inset = (vscode.window as any).createWebviewTextEditorInset(
        editor, afterLine, height, { enableScripts }
      ) as vscode.WebviewEditorInset;
      inset.webview.html = html;
      const disposable = inset.webview.onDidReceiveMessage((msg: any) => {
        if (msg.command === 'accept' || msg.command === 'discard' || msg.command === 'previous' || msg.command === 'next') {
          this.onAction?.(msg.command, msg.filePath, msg.hunkId);
        }
      });
      const entry: HunkInset = {
        inset, disposable, cacheKey, disposed: false, disposing: false,
        disposeListener: inset.onDidDispose(() => {
          entry.disposed = true;
          if (entry.disposing) return;
          // Re-apply if editor is still visible so insets are immediately rebuilt
          const targetEditor = vscode.window.visibleTextEditors.find(
            e => editorKey === `${e.document.uri.toString()}#${e.viewColumn ?? 'embedded'}`
          );
          if (targetEditor) this.applyToEditor(targetEditor, this.diffEditorFilePaths());
        }),
      };
      return entry;
    } catch (err) {
      log(`createWebviewTextEditorInset failed: ${err}`);
      return undefined;
    }
  }

  dispose(): void {
    addedLineDecoration.dispose();
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    for (const list of this.insets.values()) {
      this.disposeInsetList(list);
    }
    this.insets.clear();
    this.renderSignatures.clear();
    this.degradedEditors.clear();
  }
}
