# native-hunkwise

<!-- markdownlint-disable MD033 -->
<p align="center">
  <img src="media/icon.png" width="128" alt="hunkwise logo">
</p>

<p align="center"><em>Your future self will thank you. Or blame you. It depends on the diff.</em></p>
<!-- markdownlint-enable MD033 -->

Per-hunk accept/discard for any VS Code workspace change, built on VS Code's native inline diff editor and CodeLens.

[Chinese README](README.zh.md)

AI coding tools such as [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://github.com/anomalyco/opencode), Codex CLI, and other agent-driven workflows can edit many files outside the normal Git UI. **hunkwise** gives those changes an IDE-native review surface: enable it, let tools work, then accept or discard each hunk before the edits become the new baseline.

The repository is named **native-hunkwise** because this version uses VS Code's native diff surface. The extension still appears as **hunkwise** (`molon.hunkwise`) so existing commands, settings, and installs remain compatible.

![snapshot](media/snapshot.png)

## Features

- Tracks workspace file changes from AI agents, scripts, VS Code extensions, and manual edits.
- Shows `Previous`, `Next`, `Accept Hunk`, and `Discard Hunk` CodeLens actions near each changed block.
- Opens review targets in VS Code's native inline diff editor, using the editor's built-in green/red rendering.
- Provides a hunkwise panel for pending files, hunk summaries, per-file actions, and accept/discard all.
- Tracks new files, deleted files, and file-level changes for binary or very large files.
- Persists review state across VS Code restarts in a private internal git repo.
- Honors `.gitignore`, custom ignore patterns, and an optional code/document file allowlist.
- Supports optional Codex-only tracking through a Codex CLI hook.
- Does not require VS Code proposed APIs.

## Requirements

- VS Code 1.90.0 or newer.
- `git` available on `PATH`; hunkwise uses git internally to store baselines.
- Node.js 18 or newer and npm when installing from source or developing locally.

## Installation

The current install path is source-based. The easiest route is to ask an AI coding tool to run the bundled install skill:

```text
Run this skill: https://github.com/Rhys-Wang-wannaLearnMath/native-hunkwise/blob/main/skills/install-hunkwise/SKILL.md
```

Manual source install:

```bash
git clone https://github.com/Rhys-Wang-wannaLearnMath/native-hunkwise.git
cd native-hunkwise
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
code --install-extension hunkwise-*.vsix --force
```

Use `code-insiders --install-extension hunkwise-*.vsix --force` for VS Code Insiders. Fully quit and reopen VS Code after installing or reinstalling the extension.

## Quick Start

1. Open a workspace folder in VS Code.
2. Open the **hunkwise** panel.
3. Click **Enable for this project**. hunkwise snapshots the current workspace as the baseline.
4. Let an AI tool, script, extension, or manual edit change files.
5. Review pending changes in the editor CodeLens actions, the native inline diff, or the hunkwise panel.
6. Accept changes you want to keep; discard changes you want to restore to the baseline.

Disable hunkwise from **Settings** in the panel. Disabling clears the internal baseline repo and pending review state for the project.

## Reviewing Changes

- Click files or hunks in the hunkwise panel to open the review target.
- Use CodeLens actions in normal editors or hunkwise diff tabs:
  `Previous | Hunk N/M | Next | Accept Hunk | Discard Hunk`
- Use panel actions to accept or discard one hunk, one file, or every pending file.
- Deleted files open as a diff against the stored baseline so they can be accepted as deleted or restored.
- New files can be accepted into the baseline or discarded from disk.
- Binary, unreadable, and too-large files fall back to file-level accept/discard.

Tip: drag the hunkwise panel and your AI chat panel into the same VS Code panel group to keep chat and review side by side as tabs.

## Commands

| Command | Description |
| ------- | ----------- |
| `hunkwise: Enable` | Enable hunkwise and snapshot the workspace. |
| `hunkwise: Disable` | Disable hunkwise and clear tracked state. |
| `hunkwise: Settings` | Open the hunkwise settings panel. |
| `hunkwise: Refresh State` | Rebuild pending review state from the current baseline and disk contents. |
| `hunkwise: Undo Review Action` | Undo the last hunkwise accept/discard action for the active review target. |
| `hunkwise: Previous Change` | Jump to the previous pending hunk. |
| `hunkwise: Next Change` | Jump to the next pending hunk. |
| `hunkwise: Install Codex Hook` | Install or update the Codex CLI hook used by Codex-only mode. |

When a hunkwise review action can be undone, `Ctrl+Z` / `Cmd+Z` is routed to `hunkwise: Undo Review Action`; otherwise normal VS Code undo behavior is preserved.

## Settings

Project settings are stored in `.vscode/hunkwise/settings.json` and can be changed from the hunkwise settings panel.

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `ignorePatterns` | `[".git"]` | gitignore-style patterns excluded from tracking. On macOS, `".DS_Store"` is also included by default. |
| `respectGitignore` | `true` | Skip files ignored by the workspace `.gitignore`. |
| `clearOnBranchSwitch` | `false` | Clear pending hunks and resnapshot baselines when the current git branch changes. |
| `autoEnable` | `false` | Enable hunkwise automatically when the project opens. |
| `useDiffEditor` | `true` | Open panel file and hunk clicks in VS Code's native inline diff editor. |
| `showInlineDecorations` | `true` | Show normal-editor CodeLens actions and added-line highlights. |
| `quoteRotationInterval` | `30` | Rotate idle-screen quotes every N minutes; `0` disables rotation. |
| `codexOnly` | `true` | Review only changes attributed to Codex CLI through the installed hook. |
| `trackCodeDocsOnly` | `false` | Track only code/document-like files from the extension allowlist. |
| `trackedExtensions` | built-in list | Extensions or exact filenames used when `trackCodeDocsOnly` is enabled. |

The internal `.vscode/hunkwise/` directory is always excluded from tracking. On enable, hunkwise also adds `.vscode/hunkwise/` to your workspace `.gitignore`.

## Codex-Only Mode

Codex-only mode is **on by default**. It is useful when you want hunkwise to review Codex CLI edits while silently accepting edits made by you, other tools, or background processes. Turn it off in **Settings** if you want classic review for every change.

To use it:

1. Enable hunkwise (**Only track Codex CLI edits** is already on).
2. Open **Settings** in the hunkwise panel.
3. Click **Install** under **Codex hook**.
4. Run `/hooks` in Codex and trust the installed hook.

The hook is registered in `<workspace>/.codex/hooks.json` and writes edit signals into `.vscode/hunkwise/`. If Codex-only mode is enabled without an installed and trusted hook, Codex edits will not be attributed and hunkwise may have nothing to review.

## How It Works

### Baseline Tracking

When hunkwise is enabled, it snapshots workspace files into a private git repository at `.vscode/hunkwise/git/`. This repo stores baselines: the content of each tracked file at the moment hunkwise starts tracking or last accepted a change.

The internal repo uses the workspace as its work tree but keeps git metadata inside `.vscode/hunkwise/`. It does not touch your project's own `.git` directory and works even in projects that are not git repositories.

When a tracked file changes, hunkwise diffs the current content against the stored baseline to produce hunks. Accepting a hunk updates the baseline. Discarding a hunk restores that part of the file to the baseline.

### Change Detection

hunkwise watches disk changes and VS Code document changes. This catches edits from scripts, AI agents, editor extensions, and VS Code document APIs, including changes that may not appear as simple filesystem writes.

### Rename and Delete Handling

- Manual rename through VS Code Explorer or APIs migrates the baseline to the new path.
- Manual delete through VS Code Explorer or APIs removes the baseline and does not create a review item.
- External delete by a tool or script shows a deletion review item so you can accept the delete or restore the file.

### Ignore Rules

Files can be excluded through custom `ignorePatterns`, `.gitignore`, and the optional code/document allowlist. When ignore rules change, hunkwise removes baselines for newly ignored files and snapshots newly allowed files as clean baselines to avoid flooding the review panel with old content.

### State Persistence

Review state survives VS Code restarts. On activation, hunkwise reads the internal git baseline and compares it with current disk contents to restore pending reviews.

## Development

```bash
npm install
npm run compile
npm run watch
npm test
npm run test:integration
```

- `npm run compile` compiles the TypeScript extension.
- `npm run watch` runs the TypeScript compiler in watch mode.
- `npm test` runs unit tests with Node's built-in `node:test` runner.
- `npm run test:integration` runs VS Code extension-host integration tests through `@vscode/test-cli`.

See [FAQ.md](FAQ.md) for common behavior notes.
