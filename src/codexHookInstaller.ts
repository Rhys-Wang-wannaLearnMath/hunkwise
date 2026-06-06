import * as fs from 'fs';
import * as path from 'path';

export interface CodexHookInstallResult {
  status: 'installed' | 'updated' | 'alreadyPresent';
  scriptPath: string;
  hooksJsonPath: string;
}

const SCRIPT_BASENAME = 'codex-hook.js';
const HOOK_MATCHER = 'apply_patch|Edit|Write|Bash';
const STATUS_MESSAGE = 'hunkwise: recording Codex edits';

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

  const command = `node "${scriptPath}"`;
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
  return { status, scriptPath, hooksJsonPath };
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
