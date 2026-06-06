import * as fs from 'fs';
import * as path from 'path';
import { normalizePath } from './pathNormalize';
import { parseEditedFilesFromCommand } from './codexPatchParse';
import { log } from './log';

interface SignalRecord {
  ts?: number;
  tool_name?: string;
  cwd?: string;
  command?: string;
}

/**
 * Watches the Codex edit signal file (`.vscode/hunkwise/codex-edits.jsonl`),
 * which the installed Codex `PostToolUse` hook appends to. Maintains the set of
 * files Codex has edited so the FileWatcher can, in codex-only mode, review
 * those and silently absorb everything else.
 *
 * The file is read incrementally by byte offset (append-only). On start the
 * offset jumps to EOF so stale signals from a previous session are not replayed
 * — reviewing state for unaccepted Codex edits is already restored from the
 * hunkwise baseline by StateManager.load().
 */
export class CodexSignal {
  private signalPath: string;
  private workspaceRoot: string | undefined;
  private edited: Map<string, number> = new Map();
  private offset = 0;
  private watcher: fs.FSWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private onEdits: ((paths: string[]) => void) | undefined;
  private started = false;

  constructor(
    hunkwiseDir: string,
    workspaceRoot: string | undefined,
    onEdits?: (paths: string[]) => void
  ) {
    this.signalPath = path.join(hunkwiseDir, 'codex-edits.jsonl');
    this.workspaceRoot = workspaceRoot ? normalizePath(workspaceRoot) : undefined;
    this.onEdits = onEdits;
  }

  /** Absolute path of the signal file the Codex hook appends to. */
  get filePath(): string {
    return this.signalPath;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.offset = fs.statSync(this.signalPath).size;
    } catch {
      this.offset = 0;
    }
    this.startWatch();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopWatch();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.edited.clear();
    this.offset = 0;
  }

  isCodexEdited(filePath: string): boolean {
    return this.edited.has(normalizePath(filePath));
  }

  /** Forget a path after it has been accepted/discarded so later non-Codex edits aren't reviewed. */
  markConsumed(filePath: string): void {
    this.edited.delete(normalizePath(filePath));
  }

  private startWatch(): void {
    this.stopWatch();
    const dir = path.dirname(this.signalPath);
    const base = path.basename(this.signalPath);
    try {
      this.watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        // Some platforms omit filename; in that case read unconditionally.
        if (filename && filename !== base) return;
        this.scheduleRead();
      });
    } catch (err) {
      log(`codexSignal: watch failed: ${err}`);
    }
    // Catch anything appended between the initial stat and the watch starting.
    this.scheduleRead();
  }

  private stopWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private scheduleRead(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.readNew();
    }, 50);
  }

  private isInsideWorkspace(normPath: string): boolean {
    if (!this.workspaceRoot) return true;
    return normPath === this.workspaceRoot || normPath.startsWith(this.workspaceRoot + path.sep);
  }

  private readNew(): void {
    let size: number;
    try {
      size = fs.statSync(this.signalPath).size;
    } catch {
      // File removed/missing — reset so a future recreate is read from the start.
      this.offset = 0;
      return;
    }
    if (size < this.offset) this.offset = 0; // truncated or recreated
    if (size === this.offset) return;

    let buf: Buffer;
    try {
      const fd = fs.openSync(this.signalPath, 'r');
      try {
        buf = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      log(`codexSignal: read failed: ${err}`);
      return;
    }
    this.offset = size;

    let text = buf.toString('utf8');
    // Hold back a trailing partial line — an append may be mid-flight.
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) {
      this.offset -= Buffer.byteLength(text, 'utf8');
      return;
    }
    const remainder = text.slice(lastNl + 1);
    if (remainder) this.offset -= Buffer.byteLength(remainder, 'utf8');
    text = text.slice(0, lastNl + 1);

    const newPaths: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: SignalRecord;
      try {
        rec = JSON.parse(line) as SignalRecord;
      } catch {
        continue;
      }
      if (typeof rec.command !== 'string' || !rec.command) continue;
      const ts = typeof rec.ts === 'number' ? rec.ts : Date.now();
      for (const file of parseEditedFilesFromCommand(rec.command, rec.cwd ?? '')) {
        const norm = normalizePath(file);
        if (!this.isInsideWorkspace(norm)) continue;
        this.edited.set(norm, ts);
        if (!newPaths.includes(norm)) newPaths.push(norm);
      }
    }

    if (newPaths.length > 0 && this.onEdits) {
      log(`codexSignal: ${newPaths.length} file(s) edited by Codex`);
      try {
        this.onEdits(newPaths);
      } catch (err) {
        log(`codexSignal: onEdits error: ${err}`);
      }
    }
  }
}
