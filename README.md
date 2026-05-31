# native-hunkwise

<!-- markdownlint-disable MD033 -->
<p align="center">
  <img src="media/icon.png" width="128" alt="hunkwise logo">
</p>

<p align="center"><em>Your future self will thank you. Or blame you. It depends on the diff.</em></p>
<!-- markdownlint-enable MD033 -->

Per-hunk Accept/Discard for any file change in VSCode, built on native inline diff.

AI coding tools like [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://github.com/anomalyco/opencode), and other CLI/plugin-based assistants lack a native IDE — unlike Cursor, Windsurf, or Copilot, they have no built-in way to review changes hunk by hunk.

**native-hunkwise** is the native-diff refactor of hunkwise. The GitHub project is now `native-hunkwise`, while the VSCode extension still appears as **hunkwise** so existing commands, settings, and installs remain compatible.

This refactor removes the old custom webview/editor-inset diff rendering path and uses VSCode's native inline diff editor plus CodeLens for hunk navigation and Accept/Discard actions.

![snapshot](media/snapshot.png)

## Features

- Tracks file changes from any source (AI tools, scripts, manual edits)
- Per-hunk `Previous | Hunk 1/N | Next | Accept Hunk | Discard Hunk` CodeLens actions in the editor and native inline diff
- Native inline diff uses VSCode's built-in green/red change rendering
- Sidebar panel lists all pending files with hunk details and batch actions
- New files and deleted files are tracked and displayed
- State persisted across VSCode restarts via a lightweight internal git repo
- Respects `.gitignore` and custom ignore patterns

## Installation

hunkwise no longer depends on proposed VSCode APIs; the review view is built on VSCode's native inline diff editor and CodeLens.

Just tell your AI tool:

> Run this skill: <https://github.com/Rhys-Wang-wannaLearnMath/native-hunkwise/blob/main/skills/install-hunkwise/SKILL.md>

## Usage

### Enable hunkwise

Click **Enable** in the hunkwise sidebar panel. hunkwise will snapshot all current workspace files as baselines.

### Automatic tracking

Once enabled, any external tool (AI assistant, script, etc.) that writes to a file will automatically trigger review mode for that file.

### Reviewing changes

- Click `Accept` or `Discard` above each hunk in the editor or native inline diff
- Use the **hunkwise** sidebar panel to:
  - See all files with pending changes
  - Accept or discard individual hunks
  - Accept or discard all changes in a file
  - Accept or discard all changes across all files
- Click a file name in the panel to open it
- Deleted files show a diff view with the original content

### Disable hunkwise

Open **Settings** (gear icon in the panel title bar) and click **Disable** at the bottom. All tracked state is cleared.

### Tip: Stack with Chat panel

You can drag both the hunkwise panel and the Claude Code panel into the Chat panel to stack them as tabs in the same panel group — keeping Claude Code chat and hunk review at a glance.

## Commands

| Command | Description |
| ------- | ----------- |
| `hunkwise: Enable` | Enable hunkwise and snapshot the workspace |
| `hunkwise: Disable` | Disable hunkwise and clear all state |
| `hunkwise: Settings` | Open the settings panel |

## Settings

Settings are stored in `.vscode/hunkwise/settings.json` and can be changed via the settings panel:

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `ignorePatterns` | `[".git"]` | Glob patterns to exclude from tracking |
| `respectGitignore` | `true` | Whether to honor `.gitignore` rules |
| `clearOnBranchSwitch` | `false` | Automatically clear all pending hunks when git branch changes |
| `autoEnable` | `false` | Automatically enable hunkwise when this project is opened |
| `useDiffEditor` | `true` | Open panel file/hunk clicks in VSCode's native inline diff editor |
| `showInlineDecorations` | `true` | Show normal-editor added-line highlights and CodeLens actions |

## .gitignore

When enabled, hunkwise automatically adds `.vscode/hunkwise/` to your `.gitignore`.

## How it works

### Baseline tracking

When hunkwise is enabled, it snapshots all workspace files into a private git repository at `.vscode/hunkwise/git/`. This repo stores **baselines** — the content of each file at the moment hunkwise starts tracking. The repo always has exactly one commit (each mutation does `--amend`).

When a tracked file changes, hunkwise diffs the current content against the stored baseline to produce hunks. Accepting a hunk updates the baseline; discarding a hunk restores the baseline content.

### Change detection

hunkwise treats saved changes from scripts, AI tools, VSCode extensions, and the editor as reviewable changes. This avoids missing tool-generated edits that are applied through VSCode's document APIs rather than direct disk writes.

### File rename and delete handling

- **Manual rename** (via VSCode explorer/API): hunkwise migrates the baseline to the new path. No spurious deletion hunk is shown.
- **Manual delete** (via VSCode explorer/API): hunkwise removes the baseline. No deletion hunk is shown.
- **External delete** (tool deletes a file): Shows a deletion hunk so you can review and restore if needed.

### Ignore rules

Files can be excluded from tracking via two mechanisms:

1. **ignorePatterns** in `.vscode/hunkwise/settings.json` — custom patterns (default: `[".git"]`, plus `".DS_Store"` on macOS)
2. **`.gitignore`** — when `respectGitignore` is true (default), workspace `.gitignore` rules are honored

When ignore rules change (`.gitignore` modified, or patterns updated via settings), hunkwise automatically:

- Removes baselines for files that are now ignored
- Adds baselines for files that are newly allowed

### State persistence

All baseline data is stored in the git repo and survives VSCode restarts. On reactivation, hunkwise reads baselines from `git ls-tree HEAD` + `git show :path` to restore in-memory state.

## Development

```bash
npm run compile          # compile TypeScript
npm run watch            # watch mode
npm test                 # run unit tests (node:test runner)
npm run test:integration # run VSCode integration tests
```

Unit tests cover `diffEngine`, `hunkwiseGit`, and `gitignoreManager`. They run with Node's built-in test runner and require no additional dependencies.

Integration tests run in a real VSCode extension host via `@vscode/test-cli` and cover rename/delete handling, .gitignore sync, file watching, and enable/disable lifecycle.
