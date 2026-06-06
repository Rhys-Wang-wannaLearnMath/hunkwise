import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface CodexHookInstallResult {
  status: 'installed' | 'updated' | 'alreadyPresent';
  scriptPath: string;
  hooksJsonPath: string;
  /** Interpreter baked into the hook command. */
  interpreter: string;
  /** False when no absolute node binary could be located (command falls back to bare `node`). */
  nodeResolved: boolean;
}

const SCRIPT_BASENAME = 'codex-hook.js';
const HOOK_MATCHER = 'apply_patch|Edit|Write|Bash';
const STATUS_MESSAGE = 'hunkwise: recording Codex edits';

function canExecute(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isWorkingNode(p: string): boolean {
  try {
    execFileSync(p, ['-v'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an absolute path to a working `node` binary. Codex runs PostToolUse
 * hooks with a sanitized environment whose PATH usually omits Homebrew/nvm
 * locations, so a bare `node` command fails with exit 127. Baking the absolute
 * path makes the hook work regardless of how Codex spawns it.
 */
export function resolveNodePath(): string | undefined {
  // 1. The current interpreter, if it is actually node (not the Electron host).
  const exec = process.execPath;
  if (exec && /(^|[\\/])node(\.exe)?$/i.test(path.basename(exec)) && isWorkingNode(exec)) {
    return exec;
  }

  // 2. Common absolute locations (fast filesystem checks, no subprocess).
  const home = os.homedir();
  const candidates: string[] = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    path.join(home, '.volta', 'bin', 'node'),
    path.join(home, '.local', 'bin', 'node'),
  ];

  const pushLatest = (dir: string, toBin: (v: string) => string) => {
    try {
      const versions = fs.readdirSync(dir).sort();
      if (versions.length > 0) candidates.push(toBin(versions[versions.length - 1]));
    } catch {
      // directory absent — ignore
    }
  };
  pushLatest(path.join(home, '.nvm', 'versions', 'node'), v => path.join(home, '.nvm', 'versions', 'node', v, 'bin', 'node'));
  pushLatest(path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), v => path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions', v, 'installation', 'bin', 'node'));

  for (const c of candidates) {
    if (canExecute(c) && isWorkingNode(c)) return c;
  }

  // 3. Ask a login shell (loads nvm/homebrew PATH). Slower, so it runs last.
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('where', ['node'], { encoding: 'utf-8', timeout: 5000 });
      const line = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      if (line && isWorkingNode(line)) return line;
    } catch {
      // not found
    }
  } else {
    const shell = process.env.SHELL || '/bin/zsh';
    for (const args of [['-lic', 'command -v node'], ['-lc', 'command -v node']]) {
      try {
        const out = execFileSync(shell, args, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        const line = out.split('\n').map(s => s.trim()).filter(Boolean).pop();
        if (line && path.isAbsolute(line) && isWorkingNode(line)) return line;
      } catch {
        // try next form
      }
    }
  }

  return undefined;
}

/** Build the hook command, preferring an absolute node path over a bare `node`. */
function buildHookCommand(scriptPath: string): { command: string; interpreter: string; nodeResolved: boolean } {
  const resolved = resolveNodePath();
  const interpreter = resolved ?? 'node';
  return { command: `"${interpreter}" "${scriptPath}"`, interpreter, nodeResolved: resolved !== undefined };
}

/** Extract the interpreter (first token) from a stored hook command. */
function interpreterOf(command: string): string {
  const trimmed = command.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end !== -1) return trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/)[0] ?? '';
}

/** A hook command is healthy when its interpreter is an absolute path that still exists. */
function isHealthyCommand(command: string): boolean {
  const interp = interpreterOf(command);
  return path.isAbsolute(interp) && fs.existsSync(interp);
}

interface HooksFile {
  hooks?: { PostToolUse?: unknown[] };
  [key: string]: unknown;
}

function readHooksFile(hooksJsonPath: string): HooksFile {
  if (!fs.existsSync(hooksJsonPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as HooksFile;
  } catch {
    // Corrupt/non-JSON — start fresh rather than clobbering silently is risky, but
    // a hooks.json that doesn't parse can't be honored by Codex anyway.
  }
  return {};
}

function isHunkwiseHandler(handler: unknown): handler is { command: string } {
  return !!handler
    && typeof handler === 'object'
    && typeof (handler as { command?: unknown }).command === 'string'
    && (handler as { command: string }).command.includes(SCRIPT_BASENAME);
}

/**
 * Copy the bundled hook script into the hunkwise dir and register it as a Codex
 * `PostToolUse` command hook in `<workspace>/.codex/hooks.json` (merging, never
 * clobbering, any existing hooks). The user must still run `/hooks` in Codex to
 * trust the new hook before it executes.
 */
export function installCodexHook(
  extensionPath: string,
  workspaceRoot: string,
  hunkwiseDir: string
): CodexHookInstallResult {
  const src = path.join(extensionPath, 'media', SCRIPT_BASENAME);
  const scriptPath = path.join(hunkwiseDir, SCRIPT_BASENAME);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.copyFileSync(src, scriptPath);

  const codexDir = path.join(workspaceRoot, '.codex');
  const hooksJsonPath = path.join(codexDir, 'hooks.json');
  fs.mkdirSync(codexDir, { recursive: true });

  const { command, interpreter, nodeResolved } = buildHookCommand(scriptPath);
  const root = readHooksFile(hooksJsonPath);
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) {
    root.hooks = {};
  }
  if (!Array.isArray(root.hooks.PostToolUse)) root.hooks.PostToolUse = [];
  const groups = root.hooks.PostToolUse as Array<{ matcher?: string; hooks?: unknown[] }>;

  let existing: { command: string } | undefined;
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const handler of group.hooks) {
      if (isHunkwiseHandler(handler)) {
        existing = handler;
        break;
      }
    }
    if (existing) break;
  }

  let status: CodexHookInstallResult['status'];
  if (existing) {
    if (existing.command === command) {
      status = 'alreadyPresent';
    } else {
      existing.command = command;
      status = 'updated';
    }
  } else {
    groups.push({
      matcher: HOOK_MATCHER,
      hooks: [{ type: 'command', command, statusMessage: STATUS_MESSAGE }],
    });
    status = 'installed';
  }

  fs.writeFileSync(hooksJsonPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
  return { status, scriptPath, hooksJsonPath, interpreter, nodeResolved };
}

/**
 * Repair an already-installed hook whose command is broken — e.g. a bare `node`
 * that fails with exit 127 under Codex's sanitized PATH, or an absolute
 * interpreter that no longer exists (node upgraded/removed). Returns the install
 * result when a repair was performed, or undefined when no action was needed.
 */
export function repairCodexHookIfNeeded(
  extensionPath: string,
  workspaceRoot: string,
  hunkwiseDir: string
): CodexHookInstallResult | undefined {
  const hooksJsonPath = path.join(workspaceRoot, '.codex', 'hooks.json');
  const root = readHooksFile(hooksJsonPath);
  const groups = root.hooks?.PostToolUse;
  if (!Array.isArray(groups)) return undefined;

  let command: string | undefined;
  for (const group of groups) {
    const handlers = (group as { hooks?: unknown[] })?.hooks;
    if (!Array.isArray(handlers)) continue;
    for (const handler of handlers) {
      if (isHunkwiseHandler(handler)) { command = handler.command; break; }
    }
    if (command !== undefined) break;
  }

  if (command === undefined) return undefined; // not installed — nothing to repair
  if (isHealthyCommand(command)) return undefined; // already absolute + existing
  return installCodexHook(extensionPath, workspaceRoot, hunkwiseDir);
}

/** Whether a hunkwise Codex hook is registered in `<workspace>/.codex/hooks.json`. */
export function isCodexHookInstalled(workspaceRoot: string): boolean {
  const hooksJsonPath = path.join(workspaceRoot, '.codex', 'hooks.json');
  const root = readHooksFile(hooksJsonPath);
  const groups = root.hooks?.PostToolUse;
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    const handlers = (group as { hooks?: unknown[] })?.hooks;
    if (!Array.isArray(handlers)) continue;
    if (handlers.some(isHunkwiseHandler)) return true;
  }
  return false;
}
