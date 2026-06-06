import * as path from 'path';

// Codex's apply_patch envelope marks each affected file with one of these
// headers. The same markers appear whether Codex calls `apply_patch` directly
// (tool_name === 'apply_patch', command === patch body) or wraps it in a Bash
// heredoc (tool_name === 'Bash', command === shell script containing the patch).
// We therefore scan the raw command text for the markers in both cases.
const FILE_MARKER = /^[ \t]*\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const MOVE_MARKER = /^[ \t]*\*\*\* Move to: (.+)$/gm;

function cleanPatchPath(raw: string): string {
  let p = raw.replace(/\r$/, '').trim();
  if (p.length >= 2
    && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
    p = p.slice(1, -1);
  }
  return p.trim();
}

/**
 * Extract the file paths (relative or absolute, exactly as written in the patch)
 * touched by an apply_patch body. Works on a raw apply_patch envelope or any
 * string that embeds one (e.g. a Bash heredoc). Returns paths in encounter
 * order; Update+Move emits both the old and the new path.
 */
export function parseEditedFilesFromPatch(command: string): string[] {
  const out: string[] = [];
  if (!command) return out;
  let m: RegExpExecArray | null;
  FILE_MARKER.lastIndex = 0;
  while ((m = FILE_MARKER.exec(command)) !== null) {
    const p = cleanPatchPath(m[1]);
    if (p) out.push(p);
  }
  MOVE_MARKER.lastIndex = 0;
  while ((m = MOVE_MARKER.exec(command)) !== null) {
    const p = cleanPatchPath(m[1]);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Resolve the files edited by a Codex tool call to absolute, de-duplicated
 * paths. `command` is `tool_input.command`; `cwd` is the Codex session cwd.
 * Returns [] for commands that don't carry an apply_patch envelope (e.g. a
 * plain `npm test`) — those edits are not tracked.
 */
export function parseEditedFilesFromCommand(command: string, cwd: string): string[] {
  const rels = parseEditedFilesFromPatch(command);
  const base = cwd && cwd.trim() ? cwd : process.cwd();
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rel of rels) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(base, rel);
    if (!seen.has(abs)) {
      seen.add(abs);
      result.push(abs);
    }
  }
  return result;
}
