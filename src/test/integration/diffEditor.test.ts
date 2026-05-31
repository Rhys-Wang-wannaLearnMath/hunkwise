import * as vscode from 'vscode';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher,
  getReviewPanel,
} from './helpers';
import { acceptHunk, discardHunk } from '../../commands';
import { computeHunks, hunkId } from '../../diffEngine';

suite('hunkwise diff editor integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    // Close all editors to clean up diff tabs
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  /**
   * Helper: create a file, enable hunkwise, then modify externally to produce hunks.
   */
  async function setupReviewingFile(filename: string, baseline: string, modified: string): Promise<string> {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, filename);

    writeFileExternally(filePath, baseline);
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) === baseline, 5000);

    writeFileExternally(filePath, modified);

    const sm = getStateManager();
    await waitForCondition(() => sm.getFile(filePath)?.status === 'reviewing', 5000);

    return filePath;
  }

  // ── useDiffEditor setting ──────────────────────────────────────────────────

  test('useDiffEditor setting persists and defaults to true', async () => {
    await enableHunkwise();
    const sm = getStateManager();
    assert.strictEqual(sm.useDiffEditor, true, 'useDiffEditor should default to true');

    sm.setUseDiffEditor(false);
    assert.strictEqual(sm.useDiffEditor, false);

    sm.setUseDiffEditor(true);
    assert.strictEqual(sm.useDiffEditor, true);
  });

  test('showInlineDecorations setting persists and defaults to true', async () => {
    await enableHunkwise();
    const sm = getStateManager();
    assert.strictEqual(sm.showInlineDecorations, true, 'showInlineDecorations should default to true');

    sm.setShowInlineDecorations(false);
    assert.strictEqual(sm.showInlineDecorations, false);

    sm.setShowInlineDecorations(true);
    assert.strictEqual(sm.showInlineDecorations, true);
  });

  test('openDiffEditor switches native diff editor to inline mode', async () => {
    const filePath = await setupReviewingFile(
      'native-inline-diff.txt',
      'line 1\nline 2\n',
      'line 1\nchanged line 2\n'
    );
    const uri = vscode.Uri.file(filePath);
    const config = vscode.workspace.getConfiguration('diffEditor', uri);
    const inspected = config.inspect<boolean>('renderSideBySide');

    await config.update('renderSideBySide', true, vscode.ConfigurationTarget.Workspace);
    try {
      const panel = getReviewPanel();
      assert.ok(panel, 'ReviewPanel should be available');
      await (panel as any).openDiffEditor(filePath);
      await sleep(500);

      assert.strictEqual(
        vscode.workspace.getConfiguration('diffEditor', uri).get('renderSideBySide'),
        false,
        'Hunkwise diff editor should switch VS Code native diff to inline mode'
      );
    } finally {
      await config.update('renderSideBySide', inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('openDiffEditor fully expands native inline diff', async () => {
    const filePath = await setupReviewingFile(
      'native-inline-expanded.txt',
      [
        'top\n',
        ...Array.from({ length: 40 }, (_, i) => `unchanged ${i}\n`),
        'old middle\n',
        ...Array.from({ length: 40 }, (_, i) => `tail ${i}\n`),
      ].join(''),
      [
        'top\n',
        ...Array.from({ length: 40 }, (_, i) => `unchanged ${i}\n`),
        'new middle\n',
        ...Array.from({ length: 40 }, (_, i) => `tail ${i}\n`),
      ].join('')
    );
    const uri = vscode.Uri.file(filePath);
    const config = vscode.workspace.getConfiguration('diffEditor', uri);
    const sideBySide = config.inspect<boolean>('renderSideBySide');
    const hideUnchanged = config.inspect<boolean>('hideUnchangedRegions.enabled');

    await config.update('renderSideBySide', true, vscode.ConfigurationTarget.Workspace);
    await config.update('hideUnchangedRegions.enabled', true, vscode.ConfigurationTarget.Workspace);
    try {
      const panel = getReviewPanel();
      assert.ok(panel, 'ReviewPanel should be available');
      await (panel as any).openDiffEditor(filePath);
      await sleep(500);

      const nextConfig = vscode.workspace.getConfiguration('diffEditor', uri);
      assert.strictEqual(nextConfig.get('renderSideBySide'), false);
      assert.strictEqual(
        nextConfig.get('hideUnchangedRegions.enabled'),
        false,
        'Hunkwise native inline diff should show all unchanged regions by default'
      );
    } finally {
      await config.update('renderSideBySide', sideBySide?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await config.update('hideUnchangedRegions.enabled', hideUnchanged?.workspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('openDiffEditor enables native diff CodeLens controls', async () => {
    const filePath = await setupReviewingFile(
      'native-diff-codelens.txt',
      'line 1\nline 2\n',
      'line 1\nchanged line 2\n'
    );
    const uri = vscode.Uri.file(filePath);
    const config = vscode.workspace.getConfiguration('diffEditor', uri);
    const codeLens = config.inspect<boolean>('codeLens');
    const sideBySide = config.inspect<boolean>('renderSideBySide');
    const sm = getStateManager();
    const previousShowInlineDecorations = sm.showInlineDecorations;

    sm.setShowInlineDecorations(false);
    await config.update('codeLens', false, vscode.ConfigurationTarget.Workspace);
    await config.update('renderSideBySide', false, vscode.ConfigurationTarget.Workspace);
    try {
      const panel = getReviewPanel();
      assert.ok(panel, 'ReviewPanel should be available');
      await (panel as any).openDiffEditor(filePath);
      await sleep(500);

      assert.strictEqual(
        vscode.workspace.getConfiguration('diffEditor', uri).get('codeLens'),
        true,
        'Hunkwise native diff should enable VS Code diff editor CodeLens controls'
      );

      const codeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider', uri
      );
      const hunkwiseLenses = (codeLenses ?? []).filter(
        l => l.command?.command === 'hunkwise.codeLensAcceptHunk'
          || l.command?.command === 'hunkwise.codeLensDiscardHunk'
          || l.command?.command === 'hunkwise.previousHunk'
          || l.command?.command === 'hunkwise.nextHunk'
          || l.command?.command === 'hunkwise.noop'
      );
      assert.strictEqual(hunkwiseLenses.length, 5, 'Native diff should expose navigation count and Accept/Discard CodeLens controls');
      assert.ok(hunkwiseLenses.some(l => l.command?.title === 'Hunk 1/1'), 'Native diff CodeLens should show current/total count');
    } finally {
      sm.setShowInlineDecorations(previousShowInlineDecorations);
      await config.update('codeLens', codeLens?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await config.update('renderSideBySide', sideBySide?.workspaceValue, vscode.ConfigurationTarget.Workspace);
    }
  });

  // ── textDocuments scheme filtering ────────────────────────────────────────

  test('acceptHunk finds doc by file scheme even when baseline doc exists', async () => {
    const filePath = await setupReviewingFile(
      'scheme-test.txt',
      'line 1\nline 2\nline 3\n',
      'line 1\nMODIFIED\nline 3\n'
    );

    const sm = getStateManager();
    const fileState = sm.getFile(filePath);
    assert.ok(fileState);

    // Open a hunkwise diff to ensure hunkwise-baseline document exists in textDocuments
    const baselineUri = vscode.Uri.file(filePath).with({ scheme: 'hunkwise-baseline' });
    const currentUri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('vscode.diff', baselineUri, currentUri, 'test diff');
    await sleep(500);

    // Now accept the hunk — should work despite baseline doc being open
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.ok(hunks.length > 0, 'Should have at least one hunk');

    acceptHunk(sm, filePath, hunkId(hunks[0]), () => {});
    await sleep(200);

    // Should have processed (not skipped due to scheme mismatch)
    const updated = sm.getFile(filePath);
    // Either file exited reviewing (last hunk) or baseline was updated
    if (updated) {
      const remaining = computeHunks(updated.baseline, doc.getText());
      assert.ok(remaining.length < hunks.length, 'Hunk count should decrease after accept');
    }
  });

  // ── closeStaleTabs ────────────────────────────────────────────

  test('accepting last hunk closes hunkwise diff tab', async () => {
    const filePath = await setupReviewingFile(
      'auto-close.txt',
      'original\n',
      'modified\n'
    );

    const sm = getStateManager();
    const fileState = sm.getFile(filePath)!;

    // Open hunkwise diff tab
    const baselineUri = vscode.Uri.file(filePath).with({ scheme: 'hunkwise-baseline' });
    const currentUri = vscode.Uri.file(filePath);
    await vscode.commands.executeCommand('vscode.diff', baselineUri, currentUri, 'test diff');
    await sleep(500);

    // Verify diff tab exists
    const hasDiffTab = () => {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputTextDiff
            && tab.input.original.scheme === 'hunkwise-baseline'
            && tab.input.modified.fsPath === filePath) {
            return true;
          }
        }
      }
      return false;
    };
    assert.ok(hasDiffTab(), 'Diff tab should exist before accept');

    const hunks = computeHunks(fileState.baseline, 'modified\n');
    assert.strictEqual(hunks.length, 1);

    // Accept via the extension's wired callback (simulating CodeLens)
    const ext = vscode.extensions.getExtension('molon.hunkwise');
    assert.ok(ext?.isActive);

    // Use the CodeLens command which wires closeStaleTabs
    await vscode.commands.executeCommand('hunkwise.codeLensAcceptHunk', filePath, hunkId(hunks[0]));
    await sleep(1000);

    // File should exit reviewing
    const updated = sm.getFile(filePath);
    assert.ok(!updated || updated.status !== 'reviewing', 'Should exit reviewing');

    // Diff tab should be closed
    assert.ok(!hasDiffTab(), 'Diff tab should be closed after last hunk accepted');
  });

  test('panel acceptAll closes stale hunkwise diff tab', async () => {
    const filePath = await setupReviewingFile(
      'panel-accept-all-close.txt',
      'before\n',
      'after\n'
    );

    const panel = getReviewPanel();
    assert.ok(panel, 'ReviewPanel should be available');
    await (panel as any).openDiffEditor(filePath);
    await sleep(500);

    const hasDiffTab = () => {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputTextDiff
            && tab.input.original.scheme === 'hunkwise-baseline'
            && tab.input.modified.fsPath === filePath) {
            return true;
          }
        }
      }
      return false;
    };
    assert.ok(hasDiffTab(), 'Diff tab should exist before panel acceptAll');

    await (panel as any).handleMessage({ command: 'acceptAll' });
    await sleep(1000);

    assert.ok(!getStateManager().getFile(filePath), 'File should exit reviewing after panel acceptAll');
    assert.ok(!hasDiffTab(), 'Diff tab should close after panel acceptAll');
  });

  // ── CodeLens visibility ────────────────────────────────────────────────────

  test('CodeLens appears in normal editor as stable action surface', async () => {
    const filePath = await setupReviewingFile(
      'codelens-test.txt',
      'line 1\n',
      'changed line 1\n'
    );

    // Open normal editor — Accept/Discard CodeLens should be present as the
    // stable fallback action surface.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
    await sleep(300);

    // Get CodeLens from the provider
    const codeLenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider', vscode.Uri.file(filePath)
    );

    const hunkwiseLenses = (codeLenses ?? []).filter(
      l => l.command?.command === 'hunkwise.codeLensAcceptHunk'
        || l.command?.command === 'hunkwise.codeLensDiscardHunk'
        || l.command?.command === 'hunkwise.previousHunk'
        || l.command?.command === 'hunkwise.nextHunk'
        || l.command?.command === 'hunkwise.noop'
    );
    assert.strictEqual(hunkwiseLenses.length, 5, 'Navigation count and Accept/Discard CodeLens should be visible in normal editor');
    assert.ok(hunkwiseLenses.some(l => l.command?.title === 'Hunk 1/1'), 'Hunk count CodeLens should show current/total');
  });
});
