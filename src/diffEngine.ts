import * as Diff from 'diff';

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removedContent: string[];  // lines from baseline that were removed
  addedContent: string[];    // lines in current content that were added
}

export const MAX_DIFF_INPUT_CHARS = 1_500_000;
export const MAX_DIFF_INPUT_LINES = 50000;
const MAX_CACHED_DIFFS = 12;
const MAX_CACHED_DIFF_CHARS = 300_000;

interface CachedDiff {
  baseline: string | null;
  current: string;
  hunks: ParsedHunk[];
}

// Diff results are requested repeatedly by decorations, CodeLens, navigation,
// and the review panel for the same document version. Keep a deliberately small
// cache so those callers share the expensive diffLines result without retaining
// large editor buffers indefinitely.
const diffCache: CachedDiff[] = [];

function countLines(s: string): number {
  let lines = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

export function canComputeHunks(baseline: string | null, current: string): boolean {
  const base = baseline ?? '';
  if (base.length + current.length > MAX_DIFF_INPUT_CHARS) return false;
  return countLines(base) + countLines(current) <= MAX_DIFF_INPUT_LINES;
}

// Stable id derived from hunk position — same hunk always gets the same id
// within a single review session (no random component needed).
export function hunkId(hunk: ParsedHunk): string {
  return `${hunk.newStart}:${hunk.newLines}:${hunk.oldStart}:${hunk.oldLines}`;
}

export function computeHunks(baseline: string | null, current: string): ParsedHunk[] {
  const cachedIndex = diffCache.findIndex(entry => entry.baseline === baseline && entry.current === current);
  if (cachedIndex !== -1) {
    const [cached] = diffCache.splice(cachedIndex, 1);
    diffCache.push(cached);
    return cached.hunks;
  }

  const changes = Diff.diffLines(baseline ?? '', current);

  const hunks: ParsedHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];

    if (!change.added && !change.removed) {
      // Context lines — advance line counters using count field
      const lineCount = change.count ?? 0;
      oldLine += lineCount;
      newLine += lineCount;
      i++;
      continue;
    }

    // Start of a changed region — collect consecutive added/removed blocks
    const hunkOldStart = oldLine;
    const hunkNewStart = newLine;
    const removed: string[] = [];
    const added: string[] = [];

    while (i < changes.length && (changes[i].added || changes[i].removed)) {
      const c = changes[i];
      // Split into lines; the value ends with \n for most lines
      const lines = c.value.endsWith('\n')
        ? c.value.slice(0, -1).split('\n')
        : c.value.split('\n');

      if (c.removed) {
        removed.push(...lines);
        oldLine += lines.length;
      } else if (c.added) {
        added.push(...lines);
        newLine += lines.length;
      }
      i++;
    }

    if (removed.length > 0 || added.length > 0) {
      hunks.push({
        oldStart: hunkOldStart,
        oldLines: removed.length,
        newStart: hunkNewStart,
        newLines: added.length,
        removedContent: removed,
        addedContent: added,
      });
    }
  }

  if ((baseline?.length ?? 0) + current.length <= MAX_CACHED_DIFF_CHARS) {
    diffCache.push({ baseline, current, hunks });
    if (diffCache.length > MAX_CACHED_DIFFS) diffCache.shift();
  }

  return hunks;
}
