import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ignoreLib: ((options?: { ignoreCase?: boolean }) => import('ignore').Ignore) & typeof import('ignore') = require('ignore');
type Ignore = import('ignore').Ignore;
import { StateManager } from './stateManager';
import { canComputeHunks, computeHunks } from './diffEngine';
import { log } from './log';
import { normalizePath } from './pathNormalize';
import { readTextFile, TextFileReadResult, textLooksBinary } from './fileContent';
import { CodexSignal } from './codexSignal';

// In codex-only mode, a file change not (yet) attributed to Codex waits this long
// for the Codex signal to arrive before being silently absorbed into the baseline.
const CODEX_GRACE_MS = 1500;

// Transform gitignore rules from a sub-directory so they work in a single
// root-level matcher. Adds the directory's relative path as prefix, handling
// anchored (/), unanchored (any-depth), negation (!) and comment lines.
function prefixGitignoreRules(content: string, prefix: string): string {
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    const neg = trimmed.startsWith('!');
    let pattern = neg ? trimmed.slice(1) : trimmed;

    if (pattern.startsWith('/')) {
      // Anchored to directory: /dist → prefix/dist
      pattern = prefix + pattern;
    } else if (!pattern.includes('/') || (pattern.endsWith('/') && !pattern.slice(0, -1).includes('/'))) {
      // No internal slash (or only trailing slash): matches any depth
      // *.tmp → prefix/**/*.tmp, build/ → prefix/**/build/
      pattern = prefix + '/**/' + pattern;
    } else {
      // Has internal slash: relative to directory: foo/bar → prefix/foo/bar
      pattern = prefix + '/' + pattern;
    }

    return (neg ? '!' : '') + pattern;
  }).join('\n');
}

export class FileWatcher {
  private disposables: vscode.Disposable[] = [];
  private selfEditFiles: Set<string> = new Set();
  // Files being deleted by the user via VSCode (explorer / applyEdit)
  private pendingUserDeletes: Set<string> = new Set();
  // Old paths of in-progress user renames — suppress onDiskDelete without extra git ops
  private pendingRenameOldPaths: Set<string> = new Set();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private onStateChanged: () => void;
  private onIgnoreRulesChanged: (() => void) | undefined;
  // Compiled ignore instance from workspace .gitignore
  private gitignoreMatcher: Ignore = ignoreLib();
  private userIgnoreMatcher: Ignore = ignoreLib();
  private userIgnoreKey: string = '';
  private diskChangeTimers: Map<string, NodeJS.Timeout> = new Map();
  // When true, all file-system events are suppressed (used during branch switch)
  private _suppressed: boolean = false;
  // codex-only mode: signal source + per-file grace timers for unattributed changes
  private codexSignal: CodexSignal | undefined;
  private pendingCodexGate: Map<string, NodeJS.Timeout> = new Map();
  // Cache the trackedExtensions Set, rebuilt only when the source array changes.
  private trackedExtCache: { source: string[]; set: Set<string> } | undefined;

  constructor(
    private stateManager: StateManager,
    onStateChanged: () => void,
    onIgnoreRulesChanged?: () => void
  ) {
    this.onStateChanged = onStateChanged;
    this.onIgnoreRulesChanged = onIgnoreRulesChanged;
  }

  register(context: vscode.ExtensionContext): void {
    this.loadGitignore();

    const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
    gitignoreWatcher.onDidChange(() => { this.loadGitignore(); this.onIgnoreRulesChanged?.(); });
    gitignoreWatcher.onDidCreate(() => { this.loadGitignore(); this.onIgnoreRulesChanged?.(); });
    gitignoreWatcher.onDidDelete(() => { this.loadGitignore(); this.onIgnoreRulesChanged?.(); });
    this.disposables.push(gitignoreWatcher);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange(uri => this.scheduleDiskChange(uri));
    watcher.onDidDelete(uri => this.onDiskDelete(uri));
    watcher.onDidCreate(uri => this.onDiskCreate(uri));
    this.disposables.push(watcher);

    // onWillDeleteFiles fires for user-initiated deletes (explorer, applyEdit),
    // but NOT for external tool deletes — use this to distinguish the two.
    // onDidDeleteFiles may fire before FileSystemWatcher.onDidDelete, so we use
    // a short timeout as fallback cleanup instead of removing immediately.
    this.disposables.push(
      vscode.workspace.onWillDeleteFiles(e => {
        for (const uri of e.files) {
          this.pendingUserDeletes.add(normalizePath(uri.fsPath));
        }
      }),
      vscode.workspace.onDidDeleteFiles(e => {
        setTimeout(() => {
          for (const uri of e.files) {
            this.pendingUserDeletes.delete(normalizePath(uri.fsPath));
          }
        }, 500);
      }),
      // onWillRenameFiles fires BEFORE the actual rename. Record paths so
      // the subsequent onDiskDelete/onDiskCreate events are suppressed, and
      // migrate state+git. UI refresh is deferred to onDidRenameFiles because
      // the new file doesn't exist on disk yet when onWill fires.
      vscode.workspace.onWillRenameFiles(e => {
        for (const { oldUri, newUri } of e.files) {
          const oldPath = normalizePath(oldUri.fsPath);
          const newPath = normalizePath(newUri.fsPath);
          if (!this.stateManager.enabled) continue;
          log(`rename: ${path.basename(oldPath)} → ${path.basename(newPath)}`);
          this.pendingRenameOldPaths.add(oldPath);
          this.selfEditFiles.add(newPath);
          this.stateManager.renameFile(oldPath, newPath);
        }
      }),
      vscode.workspace.onDidRenameFiles(e => {
        let needsRefresh = false;
        for (const { oldUri, newUri } of e.files) {
          this.pendingRenameOldPaths.delete(normalizePath(oldUri.fsPath));
          this.selfEditFiles.delete(normalizePath(newUri.fsPath));
          if (this.stateManager.getFile(normalizePath(newUri.fsPath))) {
            needsRefresh = true;
          }
        }
        if (needsRefresh) this.onStateChanged();
      }),
    );

    const docChange = vscode.workspace.onDidChangeTextDocument(e => {
      this.onDocumentChange(e);
    });
    this.disposables.push(docChange);

    context.subscriptions.push(...this.disposables);
  }

  private loadGitignore(): void {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.gitignoreMatcher = ignoreLib();
    if (!rootPath) return;

    // Load global gitignore (core.excludesfile or default ~/.config/git/ignore)
    try {
      const { execFileSync } = require('child_process');
      const globalPath = (execFileSync('git', ['config', '--global', 'core.excludesfile'], {
        encoding: 'utf-8',
        timeout: 3000,
      }) as string).trim();
      if (globalPath) {
        const resolved = globalPath.startsWith('~')
          ? path.join(require('os').homedir(), globalPath.slice(1))
          : globalPath;
        try {
          this.gitignoreMatcher.add(fs.readFileSync(resolved, 'utf-8'));
        } catch { /* file may not exist */ }
      }
    } catch {
      // No core.excludesfile configured — try default location
      try {
        const defaultPath = path.join(require('os').homedir(), '.config', 'git', 'ignore');
        this.gitignoreMatcher.add(fs.readFileSync(defaultPath, 'utf-8'));
      } catch { /* no global gitignore */ }
    }

    // Collect all .gitignore files recursively from workspace root.
    // Root .gitignore rules are added directly; sub-directory rules get a
    // relative-path prefix so the single matcher instance handles scoping.
    this.collectGitignores(rootPath, rootPath);
  }

  private getUserIgnoreMatcher(): Ignore {
    const key = JSON.stringify(this.stateManager.ignorePatterns);
    if (key !== this.userIgnoreKey) {
      this.userIgnoreMatcher = ignoreLib().add(this.stateManager.ignorePatterns);
      this.userIgnoreKey = key;
    }
    return this.userIgnoreMatcher;
  }

  /**
   * Recursively collect .gitignore files starting from `dir`.
   * Skips directories already ignored by the current matcher state.
   */
  private collectGitignores(dir: string, rootPath: string): void {
    const gitignorePath = path.join(dir, '.gitignore');
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (dir === rootPath) {
        this.gitignoreMatcher.add(content);
      } else {
        const prefix = path.relative(rootPath, dir).replace(/\\/g, '/');
        this.gitignoreMatcher.add(prefixGitignoreRules(content, prefix));
      }
    } catch { /* no .gitignore in this directory */ }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootPath, full).replace(/\\/g, '/');
      // Skip directories already ignored — no need to descend
      if (this.gitignoreMatcher.ignores(rel + '/')) continue;
      this.collectGitignores(full, rootPath);
    }
  }

  /** Suppress all file-system event handling (used during branch switch). */
  suppressAll(): void {
    this._suppressed = true;
  }

  /** Resume file-system event handling after branch switch completes. */
  resumeAll(): void {
    this._suppressed = false;
  }

  setCodexSignal(signal: CodexSignal | undefined): void {
    this.codexSignal = signal;
  }

  markSelfEdit(filePath: string): void {
    this.selfEditFiles.add(normalizePath(filePath));
  }

  clearSelfEdit(filePath: string): void {
    this.selfEditFiles.delete(normalizePath(filePath));
  }

  isSelfEdit(filePath: string): boolean {
    return this.selfEditFiles.has(normalizePath(filePath));
  }

  shouldIgnore(filePath: string, isDirectory?: boolean): boolean {
    if (!filePath) return false;

    const hunkwiseDir = this.stateManager.dir;
    if (hunkwiseDir && filePath.startsWith(hunkwiseDir + path.sep)) return true;
    if (hunkwiseDir && filePath === hunkwiseDir) return true;

    // "Only track code/document files" mode: ignore files whose extension/name
    // is not in the allowlist. Directories are never filtered here so traversal
    // can still reach allowed files inside them.
    if (this.stateManager.trackCodeDocsOnly && !isDirectory && !this.matchesTrackedExtension(filePath)) {
      return true;
    }

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) return false;

    let relPath = '';
    try {
      relPath = vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false) || '';
    } catch {
      relPath = '';
    }

    if (!relPath) {
      try {
        relPath = path.relative(rootPath, filePath);
      } catch {
        relPath = '';
      }
    }

    relPath = relPath.replace(/\\/g, '/');
    if (!relPath || relPath === '.') return false;
    if (relPath.startsWith('..')) return false;

    // The `ignore` library requires a trailing slash to match directory-only
    // patterns (e.g. `.vscode-test/`). Without it, `ignores('.vscode-test')`
    // returns false even though the pattern is meant to ignore that directory.
    if (isDirectory) relPath += '/';

    if (this.getUserIgnoreMatcher().ignores(relPath)) return true;

    if (this.stateManager.respectGitignore && this.gitignoreMatcher.ignores(relPath)) return true;

    return false;
  }

  private getTrackedExtSet(): Set<string> {
    const source = this.stateManager.trackedExtensions;
    if (!this.trackedExtCache || this.trackedExtCache.source !== source) {
      this.trackedExtCache = { source, set: new Set(source) };
    }
    return this.trackedExtCache.set;
  }

  /** Whether a file's extension or exact name is in the tracked allowlist. */
  private matchesTrackedExtension(filePath: string): boolean {
    const set = this.getTrackedExtSet();
    if (set.size === 0) return true; // empty allowlist → don't hide everything
    const base = path.basename(filePath);
    if (set.has(base)) return true; // exact filename, e.g. Dockerfile
    const dot = base.lastIndexOf('.');
    if (dot > 0) {
      if (set.has(base.slice(dot + 1).toLowerCase())) return true;
    }
    return false;
  }

  private scheduleDiskChange(uri: vscode.Uri): void {
    const filePath = normalizePath(uri.fsPath);
    const existing = this.diskChangeTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.diskChangeTimers.delete(filePath);
      void this.onDiskChange(uri);
    }, 75);
    this.diskChangeTimers.set(filePath, timer);
  }

  private async onDiskCreate(uri: vscode.Uri): Promise<void> {
    const filePath = normalizePath(uri.fsPath);
    const basename = path.basename(filePath);
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    log(() => `onDiskCreate(${basename}): fileState=${fileState ? `{status:${fileState.status}, baseline.len:${fileState.baseline?.length ?? 'null'}}` : 'undefined'}`);
    if (fileState?.status === 'reviewing') {
      // File was deleted (showing deletion hunk) but now re-created — recompute
      const diskRead = await readTextFile(filePath);
      if (!diskRead.ok) {
        log(() => `onDiskCreate(${basename}): text read unavailable while reviewing (${diskRead.reason}), keeping file-level review`);
        this.markReviewingUnavailable(filePath, fileState.baseline, diskRead);
        return;
      }
      log(() => `onDiskCreate(${basename}): reviewing, recompute hunks (baseline.len=${fileState.baseline?.length ?? 'null'}, disk.len=${diskRead.content.length})`);
      this.recomputeHunks(filePath, fileState.baseline, diskRead.content);
      return;
    }
    if (fileState) { log(() => `onDiskCreate(${basename}): has fileState but not reviewing, skip`); return; }

    const git = this.stateManager.git;
    if (!git) { log(() => `onDiskCreate(${basename}): no git, skip`); return; }

    const diskRead = await readTextFile(filePath);
    if (!diskRead.ok) {
      const gitBaseline = await git.getBaseline(filePath);
      log(() => `onDiskCreate(${basename}): text read unavailable (${diskRead.reason}), enter file-level review`);
      this.markReviewingUnavailable(filePath, gitBaseline ?? null, diskRead);
      return;
    }

    const gitBaseline = await git.getBaseline(filePath);
    log(() => `onDiskCreate(${basename}): gitBaseline=${gitBaseline !== undefined ? `'${gitBaseline.length} chars'` : 'undefined'}`);
    if (gitBaseline !== undefined) {
      // Hunkwise already has a baseline — treat as a change
      log(() => `onDiskCreate(${basename}): has baseline, enterReviewing as change`);
      this.enterReviewing(filePath, gitBaseline, diskRead.content);
      return;
    }

    // External tool created this file — show as new file hunk (null = file didn't exist before)
    log(() => `onDiskCreate(${basename}): external create, enterReviewing as NEW`);
    this.enterReviewing(filePath, null, diskRead.content);
  }

  private async onDiskDelete(uri: vscode.Uri): Promise<void> {
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    const filePath = normalizePath(uri.fsPath);
    const basename = path.basename(filePath);
    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    const git = this.stateManager.git;

    if (this.pendingRenameOldPaths.has(filePath)) {
      // User-initiated rename — renameFile already migrated state+git, nothing to do
      this.pendingRenameOldPaths.delete(filePath);
      log(() => `onDiskDelete(${basename}): rename old path, skip`);
      return;
    }

    if (this.pendingUserDeletes.has(filePath)) {
      // User-initiated delete (explorer / VSCode API) — treat as manual, remove baseline.
      // Always go through stateManager.removeFile so git ops are serialized via gitQueue.
      this.pendingUserDeletes.delete(filePath);
      log(() => `onDiskDelete(${basename}): user delete, removeFile`);
      this.stateManager.removeFile(filePath);
      // Also clean up child files when a directory is deleted via VSCode
      const dirPrefix = filePath + path.sep;
      let needsRefresh = !!fileState;
      for (const [childPath] of this.stateManager.getAllFiles()) {
        if (childPath.startsWith(dirPrefix)) {
          this.stateManager.removeFile(childPath);
          needsRefresh = true;
        }
      }
      if (needsRefresh) {
        this.onStateChanged();
      }
      return;
    }

    // External tool deleted the file
    if (!git) { log(() => `onDiskDelete(${basename}): no git, skip`); return; }

    // If file was new (null baseline), just clean up — nothing to show, nothing in git
    if (fileState?.baseline === null) {
      log(() => `onDiskDelete(${basename}): new file (null baseline) deleted, removing fileState`);
      this.stateManager.exitReviewing(filePath);
      this.onStateChanged();
      return;
    }

    const gitBaseline = fileState?.baseline ?? await git.getBaseline(filePath);
    log(() => `onDiskDelete(${basename}): external delete, gitBaseline=${gitBaseline !== undefined ? `'${gitBaseline.length} chars'` : 'undefined'}`);
    if (gitBaseline !== undefined && textLooksBinary(gitBaseline)) {
      this.markReviewingUnavailable(filePath, '', { ok: false, reason: 'unreadable' });
      return;
    }
    if (gitBaseline === undefined) {
      // Not tracked at all — nothing to show
      if (fileState) {
        log(() => `onDiskDelete(${basename}): no baseline, removing fileState`);
        this.stateManager.removeFile(filePath);
        this.onStateChanged();
      }

      // When a directory is externally deleted, VSCode's FileSystemWatcher only
      // fires onDidDelete for the directory itself, not for individual files
      // inside it. Clean up any child state entries whose paths start with this
      // directory prefix so they don't remain as stale ghosts in the panel.
      const dirPrefix = filePath + path.sep;
      const allFiles = this.stateManager.getAllFiles();
      let childrenCleaned = 0;
      for (const [childPath, childState] of allFiles) {
        if (!childPath.startsWith(dirPrefix)) continue;
        if (childState.baseline === null) {
          // New file (no git baseline) — just remove from state
          this.stateManager.exitReviewing(childPath);
        } else {
          // Has baseline — show deletion diff
          this.enterReviewing(childPath, childState.baseline, '');
        }
        childrenCleaned++;
      }
      if (childrenCleaned > 0) {
        log(() => `onDiskDelete(${basename}): cleaned ${childrenCleaned} child file(s) from deleted directory`);
        this.onStateChanged();
      }
      return;
    }
    // gitBaseline is '' (empty file) or has content — show deletion diff.
    // Pass '' as current content since file no longer exists on disk.
    // enterReviewing will detect isDeleted via !fs.existsSync.
    this.enterReviewing(filePath, gitBaseline, '');
  }

  private async onDiskChange(uri: vscode.Uri): Promise<void> {
    const filePath = normalizePath(uri.fsPath);
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;

    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;
    if (this.stateManager.hasPendingFileSnapshot(filePath)) return;

    const diskRead = await readTextFile(filePath);
    if (!diskRead.ok && diskRead.errorCode === 'ENOENT') {
      return;
    }

    const fileState = this.stateManager.getFile(filePath);

    if (fileState?.status === 'reviewing') {
      // Already has diff — recompute against known baseline
      if (diskRead.ok) {
        this.recomputeHunks(filePath, fileState.baseline, diskRead.content);
      } else {
        this.markReviewingUnavailable(filePath, fileState.baseline, diskRead);
      }
      return;
    }

    const git = this.stateManager.git;
    if (!git) return;

    // External change — compare against hunkwise baseline
    const pendingBaseline = this.stateManager.getPendingBaselineSnapshot(filePath);
    const gitBaseline = pendingBaseline !== undefined ? pendingBaseline : await git.getBaseline(filePath);
    if (!diskRead.ok) {
      if (gitBaseline !== undefined) {
        this.markReviewingUnavailable(filePath, gitBaseline, diskRead);
      }
      return;
    }
    if (gitBaseline === undefined) {
      // No baseline in git. Treat this as a reviewable new file rather than
      // silently adopting it; FileSystemWatcher can miss or reorder create/change
      // events, and silent adoption makes real tool edits look auto-accepted.
      this.enterReviewing(filePath, null, diskRead.content);
      return;
    }
    this.enterReviewing(filePath, gitBaseline, diskRead.content);
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (this._suppressed) return;
    if (!this.stateManager.enabled) return;
    if (e.document.uri.scheme !== 'file') return;
    const filePath = normalizePath(e.document.uri.fsPath);

    if (this.shouldIgnore(filePath)) return;
    if (this.selfEditFiles.has(filePath)) return;

    const fileState = this.stateManager.getFile(filePath);
    if (fileState?.status !== 'reviewing') return;

    // Already has diff — recompute hunks against baseline
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      const latestState = this.stateManager.getFile(filePath);
      if (!latestState || latestState.status !== 'reviewing') return;
      this.recomputeHunks(filePath, latestState.baseline, e.document.getText());
    }, 50);
    this.debounceTimers.set(filePath, timer);
  }

  private enterReviewing(filePath: string, baseline: string | null, current: string): void {
    // codex-only gate: only review files attributed to Codex. An unconfirmed
    // change waits CODEX_GRACE_MS for the Codex signal; if it never arrives the
    // change is silently absorbed into the baseline (see resolveCodexGate).
    if (this.stateManager.codexOnly
      && !this.stateManager.getFile(filePath)
      && !this.codexSignal?.isCodexEdited(filePath)) {
      this.scheduleCodexGate(filePath);
      return;
    }
    this.enterReviewingDirect(filePath, baseline, current);
  }

  private enterReviewingDirect(filePath: string, baseline: string | null, current: string): void {
    if (!canComputeHunks(baseline, current)) {
      this.markReviewingUnavailable(filePath, baseline, { ok: false, reason: 'tooLarge' });
      return;
    }

    const hunks = computeHunks(baseline, current);
    const isNew = baseline === null;
    const isDeleted = !fs.existsSync(filePath) && baseline !== null;
    // Allow 0-hunk entry for new files (null baseline) and deleted files (file gone, nothing to diff)
    if (hunks.length === 0 && !isNew && !isDeleted) return;
    const tag = isNew ? ' (new)' : isDeleted ? ' (deleted)' : '';
    log(() => `reviewing: ${path.basename(filePath)}${tag}`);
    this.stateManager.setFile(filePath, { status: 'reviewing', baseline });
    this.onStateChanged();
  }

  // ── codex-only mode ─────────────────────────────────────────────────────────

  private scheduleCodexGate(filePath: string): void {
    const existing = this.pendingCodexGate.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingCodexGate.delete(filePath);
      void this.resolveCodexGate(filePath).catch(err => log(`resolveCodexGate error: ${err}`));
    }, CODEX_GRACE_MS);
    this.pendingCodexGate.set(filePath, timer);
  }

  private async resolveCodexGate(filePath: string): Promise<void> {
    if (this._suppressed || !this.stateManager.enabled || !this.stateManager.codexOnly) return;
    if (this.codexSignal?.isCodexEdited(filePath)) {
      await this.reviewCodexFile(filePath);
    } else {
      await this.silentlyAccept(filePath);
    }
  }

  /** Enter (or refresh) review for a file confirmed to be edited by Codex. */
  private async reviewCodexFile(filePath: string): Promise<void> {
    filePath = normalizePath(filePath);
    if (this._suppressed || !this.stateManager.enabled) return;
    if (this.shouldIgnore(filePath)) return;

    const existing = this.stateManager.getFile(filePath);
    if (existing?.status === 'reviewing') {
      const diskRead = await readTextFile(filePath);
      if (diskRead.ok) {
        this.recomputeHunks(filePath, existing.baseline, diskRead.content);
      } else {
        this.markReviewingUnavailable(filePath, existing.baseline, diskRead);
      }
      return;
    }

    const git = this.stateManager.git;
    if (!git) return;

    const diskRead = await readTextFile(filePath);
    if (!diskRead.ok) {
      const gitBaseline = await git.getBaseline(filePath);
      if (diskRead.errorCode === 'ENOENT') {
        // Codex deleted the file — show a deletion diff if there's a text baseline
        if (gitBaseline === undefined) return;
        if (textLooksBinary(gitBaseline)) {
          this.markReviewingUnavailable(filePath, '', { ok: false, reason: 'unreadable' });
        } else {
          this.enterReviewingDirect(filePath, gitBaseline, '');
        }
        return;
      }
      if (gitBaseline !== undefined) {
        this.markReviewingUnavailable(filePath, gitBaseline, diskRead);
      }
      return;
    }

    const pendingBaseline = this.stateManager.getPendingBaselineSnapshot(filePath);
    const gitBaseline = pendingBaseline !== undefined ? pendingBaseline : await git.getBaseline(filePath);
    this.enterReviewingDirect(filePath, gitBaseline ?? null, diskRead.content);
  }

  /** Absorb a non-Codex change into the baseline without reviewing it. */
  private async silentlyAccept(filePath: string): Promise<void> {
    filePath = normalizePath(filePath);
    if (!this.stateManager.enabled) return;
    if (this.shouldIgnore(filePath)) return;

    const diskRead = await readTextFile(filePath);
    if (diskRead.ok) {
      this.stateManager.snapshotFile(filePath, diskRead.content);
      return;
    }
    if (diskRead.errorCode === 'ENOENT') {
      // Non-Codex deletion — accept by dropping the baseline.
      this.stateManager.removeFile(filePath);
      return;
    }
    // Binary / oversized — absorb current bytes as the baseline.
    this.stateManager.snapshotFileBytes(filePath);
  }

  /** Called when the Codex signal file reports newly-edited paths. */
  onCodexSignal(paths: string[]): void {
    if (this._suppressed || !this.stateManager.enabled || !this.stateManager.codexOnly) return;
    for (const p of paths) {
      const norm = normalizePath(p);
      const timer = this.pendingCodexGate.get(norm);
      if (timer) {
        clearTimeout(timer);
        this.pendingCodexGate.delete(norm);
      }
      void this.reviewCodexFile(norm).catch(err => log(`reviewCodexFile error: ${err}`));
    }
  }

  private recomputeHunks(filePath: string, baseline: string | null, current: string): void {
    if (!canComputeHunks(baseline, current)) {
      this.markReviewingUnavailable(filePath, baseline, { ok: false, reason: 'tooLarge' });
      return;
    }

    const hunks = computeHunks(baseline, current);
    if (hunks.length === 0) {
      // No diff remaining — exit reviewing.
      // For null-baseline (new) files with empty current, keep reviewing
      // so the user can still accept/discard.
      if (baseline === null && current === '') {
        this.onStateChanged();
        return;
      }
      this.stateManager.exitReviewing(filePath);
    } else if (this.stateManager.getFile(filePath)?.diffUnavailable) {
      this.stateManager.setFile(filePath, { status: 'reviewing', baseline }, true);
    }
    this.onStateChanged();
  }

  private markReviewingUnavailable(filePath: string, baseline: string | null, read: Extract<TextFileReadResult, { ok: false }>): void {
    log(() => `reviewing: ${path.basename(filePath)} (${read.reason}, file-level)`);
    this.stateManager.setFile(filePath, {
      status: 'reviewing',
      baseline,
      baselineIsBinary: baseline !== null,
      diffUnavailable: true,
      diffUnavailableReason: read.reason,
    }, true);
    this.onStateChanged();
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const timer of this.diskChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.diskChangeTimers.clear();
    for (const timer of this.pendingCodexGate.values()) {
      clearTimeout(timer);
    }
    this.pendingCodexGate.clear();
    this.pendingUserDeletes.clear();
    this.pendingRenameOldPaths.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
