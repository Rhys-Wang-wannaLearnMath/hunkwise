import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { normalizePath } from './pathNormalize';

const execFileAsync = promisify(execFile);

export interface Settings {
  settingsVersion?: number;
  ignorePatterns: string[];
  respectGitignore: boolean;
  clearOnBranchSwitch: boolean;
  autoEnable?: boolean;
  quoteRotationInterval: number;
  useDiffEditor: boolean;
  showInlineDecorations: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  settingsVersion: 2,
  ignorePatterns: process.platform === 'darwin' ? ['.git', '.DS_Store'] : ['.git'],
  respectGitignore: true,
  clearOnBranchSwitch: false,
  autoEnable: false,
  quoteRotationInterval: 30,
  useDiffEditor: true,
  showInlineDecorations: true,
};

/**
 * Manages all hunkwise persistent state via:
 *   .vscode/hunkwise/settings.json  — enabled flag + ignorePatterns
 *   .vscode/hunkwise/git/           — private git repo storing baselines
 *
 * The git repo uses the workspace root as its work tree but keeps all git
 * metadata inside the hunkwise directory, so it never touches the project's
 * own .git and works even when the project has no git at all.
 *
 *   GIT_DIR       = <hunkwiseDir>/git
 *   GIT_WORK_TREE = <workspaceRoot>
 *
 * Each tracked file has exactly one entry in the single HEAD commit.
 * Every mutation (snapshot / remove) rewrites that commit via --amend so
 * the repo always has at most one commit and stays compact.
 */
export class HunkwiseGit {
  private hunkwiseDir: string;
  private gitDir: string;
  private workTree: string;
  private gitInitialized = false;
  private destroyed = false;
  private initPromise: Promise<void> | undefined;
  private log: (message: string) => void;

  constructor(hunkwiseDir: string, workspaceRoot: string, logger?: (message: string) => void) {
    this.hunkwiseDir = hunkwiseDir;
    this.gitDir = path.join(hunkwiseDir, 'git');
    this.workTree = workspaceRoot;
    this.log = logger ?? ((msg: string) => console.warn(`[hunkwise] ${msg}`));
  }

  // ── env / low-level git ───────────────────────────────────────────────────

  private get env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workTree,
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: this.workTree,
      env: this.env,
      maxBuffer: 10 * 1024 * 1024, // 10 MB — default 1 MB is too small for large files
    });
    return stdout;
  }

  private async gitBuffer(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.quotepath=false', ...args],
        {
          cwd: this.workTree,
          env: this.env,
          encoding: 'buffer',
          maxBuffer: 100 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(stderr?.length ? new Error(stderr.toString('utf-8')) : err);
            return;
          }
          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        }
      );
    });
  }

  private async hashObject(content: string | Buffer): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        'git',
        ['hash-object', '-w', '--stdin'],
        { env: this.env },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
      );
      if (Buffer.isBuffer(content)) {
        child.stdin!.end(content);
      } else {
        child.stdin!.end(content, 'utf-8');
      }
    });
  }

  private async stageBlob(rel: string, hash: string, mode: string = '100644'): Promise<void> {
    await this.git(['update-index', '--add', '--cacheinfo', `${mode},${hash},${rel}`]);
  }

  // ── settings.json ─────────────────────────────────────────────────────────

  private get settingsPath(): string {
    return path.join(this.hunkwiseDir, 'settings.json');
  }

  loadSettings(): Settings {
    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const legacyInlineDiffDefault = parsed.settingsVersion === undefined && parsed.useDiffEditor === false;
      return {
        settingsVersion: DEFAULT_SETTINGS.settingsVersion,
        ignorePatterns: parsed.ignorePatterns ?? [...DEFAULT_SETTINGS.ignorePatterns],
        respectGitignore: parsed.respectGitignore ?? DEFAULT_SETTINGS.respectGitignore,
        clearOnBranchSwitch: parsed.clearOnBranchSwitch ?? DEFAULT_SETTINGS.clearOnBranchSwitch,
        autoEnable: parsed.autoEnable ?? DEFAULT_SETTINGS.autoEnable,
        quoteRotationInterval: (typeof parsed.quoteRotationInterval === 'number' && Number.isFinite(parsed.quoteRotationInterval) && parsed.quoteRotationInterval >= 0)
          ? parsed.quoteRotationInterval
          : DEFAULT_SETTINGS.quoteRotationInterval,
        useDiffEditor: legacyInlineDiffDefault
          ? DEFAULT_SETTINGS.useDiffEditor
          : (typeof parsed.useDiffEditor === 'boolean'
            ? parsed.useDiffEditor
            : DEFAULT_SETTINGS.useDiffEditor),
        showInlineDecorations: typeof parsed.showInlineDecorations === 'boolean'
          ? parsed.showInlineDecorations
          : DEFAULT_SETTINGS.showInlineDecorations,
      };
    } catch {
      return { ...DEFAULT_SETTINGS, ignorePatterns: [...DEFAULT_SETTINGS.ignorePatterns] };
    }
  }

  saveSettings(settings: Settings): void {
    try {
      fs.mkdirSync(this.hunkwiseDir, { recursive: true });
      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (err) {
      this.log(`saveSettings failed: ${err}`);
    }
  }

  /**
   * Merge defaults into existing settings.json.
   * Fields already present are kept; missing fields are added.
   * Returns the resulting settings.
   */
  mergeDefaultSettings(defaults: Settings): Settings {
    const existing = fs.existsSync(this.settingsPath) ? this.loadSettings() : ({} as Partial<Settings>);
    const merged: Settings = { ...defaults, ...existing };
    this.saveSettings(merged);
    return merged;
  }

  // ── git init ──────────────────────────────────────────────────────────────

  async initGit(): Promise<void> {
    if (this.destroyed || this.gitInitialized) return;
    // Serialize concurrent calls — only one init runs at a time
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitGit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

  private async doInitGit(): Promise<void> {
    // Check for a valid git repo: HEAD file must exist. If the directory
    // exists but HEAD is missing, the repo is corrupted (e.g. interrupted
    // init). Re-initialize from scratch in that case.
    const headPath = path.join(this.gitDir, 'HEAD');
    if (!fs.existsSync(this.gitDir) || !fs.existsSync(headPath)) {
      if (fs.existsSync(this.gitDir)) {
        this.log('initGit: corrupted git dir detected (HEAD missing), re-initializing');
        try {
          fs.rmSync(this.gitDir, { recursive: true, force: true });
        } catch (err) {
          this.log(`initGit: failed to remove corrupted git dir: ${err}`);
          throw err;
        }
      }
      if (this.destroyed) return;
      fs.mkdirSync(this.gitDir, { recursive: true });
      await this.git(['init']);
      if (this.destroyed) return;
      await this.git(['config', 'user.email', 'hunkwise@localhost']);
      if (this.destroyed) return;
      await this.git(['config', 'user.name', 'hunkwise']);
    }
    if (this.destroyed) return;
    this.gitInitialized = true;
  }

  private async hasHead(): Promise<boolean> {
    try {
      await this.git(['rev-parse', 'HEAD']);
      return true;
    } catch {
      // Expected when repo has no commits yet
      return false;
    }
  }

  // ── snapshot / remove ─────────────────────────────────────────────────────

  /**
   * Write content into the git index for filePath (no commit).
   * Use commit() to persist.
   */
  async snapshot(filePath: string, content: string): Promise<void> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      const hash = await this.hashObject(content);
      await this.stageBlob(rel, hash);
      await this.commit();
    } catch (err) {
      this.log(`snapshot failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /**
   * Snapshot the current file bytes from disk. This is used for binary or
   * oversized files where line-review text content is unavailable.
   */
  async snapshotFile(filePath: string): Promise<void> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      const hash = (await this.git(['hash-object', '-w', '--', rel])).trim();
      await this.stageBlob(rel, hash);
      await this.commit();
    } catch (err) {
      this.log(`snapshotFile failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /**
   * Rename a file (or all files under a directory) in the git index and commit.
   * Reuses existing blob hashes — no content re-hashing needed.
   */
  async renameFile(oldFilePath: string, newFilePath: string): Promise<void> {
    await this.initGit();
    const oldRel = normalizePath(path.relative(this.workTree, oldFilePath));
    const newRel = normalizePath(path.relative(this.workTree, newFilePath));
    try {
      // ls-files returns all entries matching the path (a single file or all files under a directory)
      const lsOut = await this.git(['ls-files', '--stage', '--', oldRel]);
      const lines = lsOut.trim().split('\n').filter(Boolean);
      if (lines.length === 0) return; // not tracked — nothing to rename

      // Parse all matching entries
      const entries: { mode: string; hash: string; entryRel: string }[] = [];
      for (const line of lines) {
        const m = line.match(/^(\d+) ([0-9a-f]+) \d+\t(.+)$/);
        if (!m) continue;
        entries.push({ mode: m[1], hash: m[2], entryRel: normalizePath(m[3]) });
      }
      if (entries.length === 0) return;

      // Remove all old entries
      const oldPaths = entries.map(e => e.entryRel);
      const CHUNK = 200;
      for (let i = 0; i < oldPaths.length; i += CHUNK) {
        await this.git(['update-index', '--force-remove', '--', ...oldPaths.slice(i, i + CHUNK)]);
      }

      // Add entries with new paths — replace oldRel prefix with newRel
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ mode, hash, entryRel }) => {
          const suffix = entryRel === oldRel ? '' : entryRel.slice(oldRel.length);
          const renamed = newRel + suffix;
          return ['--add', '--cacheinfo', `${mode},${hash},${renamed}`];
        });
        await this.git(['update-index', ...cacheArgs]);
      }
      await this.commit();
    } catch (err) {
      this.log(`renameFile failed (${path.relative(this.workTree, oldFilePath)} → ${path.relative(this.workTree, newFilePath)}): ${err}`);
      throw err;
    }
  }

  /**
   * Remove a file's baseline from the git index and commit.
   */
  async removeFile(filePath: string): Promise<void> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      const lsOut = await this.git(['ls-files', '--stage', '--', rel]);
      if (!lsOut.trim()) return; // not tracked — nothing to remove
      await this.git(['update-index', '--force-remove', '--', rel]);
      await this.commit();
    } catch (err) {
      this.log(`removeFile failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /**
   * Snapshot multiple files at once — writes all blobs to index then commits once.
   * Much faster than calling snapshot() per file.
   */
  async snapshotBatch(files: { filePath: string; content: string }[]): Promise<void> {
    if (files.length === 0) return;
    await this.initGit();
    try {
      // Hash all blobs in parallel, then stage all at once and commit once
      const entries = await Promise.all(
        files.map(async ({ filePath, content }) => {
          const rel = normalizePath(path.relative(this.workTree, filePath));
          return { rel, hash: await this.hashObject(content) };
        })
      );
      // Stage all entries, chunked to avoid OS argument length limits
      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ rel, hash }) => ['--add', '--cacheinfo', `100644,${hash},${rel}`]);
        await this.git(['update-index', ...cacheArgs]);
      }
      await this.commit();
    } catch (err) {
      this.log(`snapshotBatch failed (${files.length} files): ${err}`);
    }
  }

  /**
   * Snapshot current file bytes for many files and commit once. Missing or
   * unreadable files are skipped so a single transient file does not prevent
   * the rest of a workspace snapshot.
   */
  async snapshotFileBatch(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.initGit();
    try {
      const entries = (await Promise.all(
        filePaths.map(async filePath => {
          const rel = normalizePath(path.relative(this.workTree, filePath));
          try {
            const hash = (await this.git(['hash-object', '-w', '--', rel])).trim();
            return { rel, hash };
          } catch (err) {
            this.log(`snapshotFileBatch skipped ${rel}: ${err}`);
            return undefined;
          }
        })
      )).filter((entry): entry is { rel: string; hash: string } => !!entry);

      const CHUNK = 100;
      for (let i = 0; i < entries.length; i += CHUNK) {
        const cacheArgs = entries.slice(i, i + CHUNK).flatMap(({ rel, hash }) => ['--add', '--cacheinfo', `100644,${hash},${rel}`]);
        await this.git(['update-index', ...cacheArgs]);
      }
      if (entries.length > 0) await this.commit();
    } catch (err) {
      this.log(`snapshotFileBatch failed (${filePaths.length} files): ${err}`);
    }
  }

  /**
   * Remove multiple files from the git index in a single operation and commit once.
   * Much faster than calling removeFile() per file.
   */
  async removeFileBatch(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.initGit();
    try {
      const rels = filePaths.map(fp => normalizePath(path.relative(this.workTree, fp)));
      // Chunk to avoid exceeding OS argument length limits (~250KB on macOS)
      const CHUNK = 200;
      for (let i = 0; i < rels.length; i += CHUNK) {
        await this.git(['update-index', '--force-remove', '--', ...rels.slice(i, i + CHUNK)]);
      }
      await this.commit();
    } catch (err) {
      this.log(`removeFileBatch failed (${filePaths.length} files): ${err}`);
    }
  }

  private async commit(): Promise<void> {
    if (await this.hasHead()) {
      await this.git(['commit', '--amend', '--no-edit', '--allow-empty']);
    } else {
      await this.git(['commit', '-m', 'hunkwise baselines']);
    }
  }

  /**
   * Return the baseline content for a file from the git index, or undefined if not tracked.
   * Reads from index (not HEAD) so newly staged files are immediately visible.
   */
  async getBaseline(filePath: string): Promise<string | undefined> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      return await this.git(['show', `:${rel}`]);
    } catch {
      return undefined;
    }
  }

  async hasBaseline(filePath: string): Promise<boolean> {
    return (await this.getBaselineObjectId(filePath)) !== undefined;
  }

  async getBaselineObjectId(filePath: string): Promise<string | undefined> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      const lsOut = await this.git(['ls-files', '--stage', '--', rel]);
      const line = lsOut.trim().split('\n').find(Boolean);
      const m = line?.match(/^\d+ ([0-9a-f]+) \d+\t.+$/);
      return m?.[1];
    } catch {
      return undefined;
    }
  }

  async isFileContentUnchanged(filePath: string): Promise<boolean | undefined> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    const baselineObjectId = await this.getBaselineObjectId(filePath);
    if (!baselineObjectId) return undefined;
    try {
      const diskObjectId = (await this.git(['hash-object', '--', rel])).trim();
      return diskObjectId === baselineObjectId;
    } catch {
      return false;
    }
  }

  async restoreFile(filePath: string): Promise<void> {
    await this.initGit();
    const rel = normalizePath(path.relative(this.workTree, filePath));
    try {
      const content = await this.gitBuffer(['show', `:${rel}`]);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content);
    } catch (err) {
      this.log(`restoreFile failed for ${rel}: ${err}`);
      throw err;
    }
  }

  /**
   * Return absolute paths of all files currently tracked in HEAD.
   */
  async listTrackedFiles(): Promise<string[]> {
    await this.initGit();
    try {
      const out = await this.git(['ls-tree', 'HEAD', '--name-only', '-r']);
      return out
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(rel => normalizePath(path.join(this.workTree, rel)));
    } catch {
      return [];
    }
  }

  // ── destroy ───────────────────────────────────────────────────────────────

  /** Remove only the git directory (called on disable). settings.json is preserved. */
  destroyGit(): void {
    this.gitInitialized = false;
    this.destroyed = true;
    if (fs.existsSync(this.gitDir)) {
      try {
        fs.rmSync(this.gitDir, { recursive: true, force: true });
      } catch (err) {
        this.log(`destroyGit failed: ${err}`);
      }
    }
  }
}
