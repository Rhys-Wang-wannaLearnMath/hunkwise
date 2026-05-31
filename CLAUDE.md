# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run compile          # compile TypeScript to out/
npm run watch            # watch mode compilation
npm test                 # compile test config + run unit tests
npm run test:integration # compile + run VSCode integration tests
```

To run a single unit test file:
```bash
tsc -p ./tsconfig.test.json && node --test out-test/test/diffEngine.test.js
```

Unit tests use Node's built-in `node:test` runner. Integration tests use `@vscode/test-cli` with Mocha in a real VSCode extension host (config: `.vscode-test.mjs`, workspace: `src/test/integration/workspace/`).

## Architecture

hunkwise is a VSCode extension that provides per-hunk Accept/Discard controls for file changes from AI tools, scripts, VSCode extensions, and manual edits. It uses VSCode's native inline diff editor plus CodeLens and does not require proposed APIs.

### Core data flow

1. **`FileWatcher`** monitors workspace file changes via VSCode's `FileSystemWatcher` and `onDidChangeTextDocument`. Tracked content changes enter review mode unless they are explicitly marked as self-edits by hunkwise review commands.

2. **`StateManager`** holds in-memory `Map<filePath, FileState>` where `FileState = { status: 'reviewing' | 'idle', baseline: string }`. All mutations are synchronously reflected in memory and asynchronously queued to git via a serial `gitQueue` promise chain.

3. **`HunkwiseGit`** persists baselines in a private git repo at `.vscode/hunkwise/git/` using `GIT_DIR=<hunkwiseDir>/git GIT_WORK_TREE=<workspaceRoot>`. The repo always has at most one commit (each mutation does `--amend`). Settings live in `.vscode/hunkwise/settings.json`.

4. **`DiffEngine`** (`diffEngine.ts`) computes hunks by calling `Diff.diffLines(baseline, current)` from the `diff` npm package. Hunk IDs are stable strings derived from position (`newStart:newLines:oldStart:oldLines`).

5. **`DecorationManager`** provides lightweight normal-editor fallback visuals:
   - A green line decoration on added lines
   - No deleted-line webview insets; native inline diff handles red/green diff rendering

   Per-hunk controls are provided by **`DiffCodeLensProvider`** in native inline diff tabs and normal editors.

6. **`ReviewPanel`** (`reviewPanel.ts`) is the sidebar webview panel showing all pending files with batch actions. Panel file/hunk clicks open VSCode native inline diff by default. It communicates with the extension via `vscode.postMessage`.

### Key behaviors

- **Self-edit suppression**: Before programmatically writing a file (discard/accept), `fileWatcher.markSelfEdit(filePath)` is called so the watcher ignores the resulting disk event.
- **Baseline update on accept hunk**: Accepting a single hunk splices the accepted lines into `fileState.baseline` so subsequent diffs remain correct.
- **Baseline as the single source of truth**: Whether a file is "new" or "existing" is determined solely by whether it has a baseline in hunkwise git — not by file content, encoding, or binary detection. `baseline === null` means new file (not tracked in git); `baseline === ''` means existing empty file; `baseline === <string>` means existing file with content. This distinction must be consistent across all code paths (`onDiskCreate`, `load`, `rebuildState`, `collectUntrackedFiles`).
- **Deleted file support**: If a file is externally deleted, its baseline is preserved and shown in a diff view via the `hunkwise-baseline:` content provider.
- **Persistence across restarts**: On `activate()`, `StateManager.load()` checks if `.vscode/hunkwise/git/` exists (enabled state), then reads all baselines from `git ls-tree HEAD` + `git show :path`. Files on disk that are not tracked in hunkwise git are detected as new files (`baseline: null`) via `collectUntrackedFiles()`.
- **Rename/delete handling**: `onWillRenameFiles` migrates state+git before the actual rename; `onDidRenameFiles` triggers UI refresh after. Manual deletes (via VSCode) silently remove the baseline; external deletes produce a deletion hunk.
- **Git queue serialization**: All git write operations (`snapshot`, `removeFile`, `renameFile`, `snapshotBatch`) go through `StateManager.gitQueue` to prevent concurrent index/commit operations. Use `stateManager.snapshotFile()` from FileWatcher, never call `git.snapshot()` directly.
- **syncIgnoreState**: When `.gitignore` or `ignorePatterns` change, `syncIgnoreState()` both adds newly-allowed files and removes newly-ignored files from the git repo. It awaits the full `gitQueue` before returning.
- **`--force-remove` for git index**: `git update-index --remove` only removes files missing from disk — use `--force-remove` to unconditionally remove from the index even if the file exists on disk.

### Files that can be tested without VSCode

`tsconfig.test.json` compiles only `diffEngine.ts`, `hunkwiseGit.ts`, `gitignoreManager.ts`, and the test files — these have no `vscode` dependency and run in plain Node.

### Integration tests

`tsconfig.integration.json` compiles to `out-integration/`. Tests run in a real VSCode instance via `.vscode-test.mjs`. Test workspace is at `src/test/integration/workspace/`. Each test `setup()` cleans the workspace and `teardown()` disables hunkwise.
