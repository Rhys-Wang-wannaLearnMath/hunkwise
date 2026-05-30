import * as vscode from 'vscode';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher,
} from './helpers';
import { acceptHunk, discardHunk } from '../../commands';
import { computeHunks, hunkId } from '../../diffEngine';

// ── Test suite ────────────────────────────────────────────────────────────────

suite('hunkwise hunk navigation integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  /**
   * Helper: create a file with baseline content, enable hunkwise, then modify
   * externally to produce multiple hunks. Returns the file path.
   */
  async function setupMultiHunkFile(): Promise<string> {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'multi-hunk.txt');

    // Baseline: 9 lines with clear separation so modifications create distinct hunks
    const baseline = [
      'line 1',
      'line 2',
      'line 3',
      'line 4 separator',
      'line 5 separator',
      'line 6 separator',
      'line 7',
      'line 8',
      'line 9',
    ].join('\n') + '\n';

    writeFileExternally(filePath, baseline);
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    // Wait for baseline to match the original content (not just exist)
    await waitForCondition(() => gitGetBaseline(root, rel) === baseline, 5000);

    // Modify to create 3 distinct hunks:
    // - Hunk 1: change line 1-2
    // - Hunk 2: change line 4-6 (separators)
    // - Hunk 3: change line 8-9
    const modified = [
      'CHANGED line 1',
      'CHANGED line 2',
      'line 3',
      'CHANGED line 4',
      'CHANGED line 5',
      'CHANGED line 6',
      'line 7',
      'CHANGED line 8',
      'CHANGED line 9',
    ].join('\n') + '\n';

    writeFileExternally(filePath, modified);

    const sm = getStateManager();
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    return filePath;
  }

  test('next/previous hunk commands navigate between pending changes', async () => {
    const filePath = await setupMultiHunkFile();
    const sm = getStateManager();
    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'File should be in state');

    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);
    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.ok(hunks.length >= 2, `Expected at least 2 hunks, got ${hunks.length}`);

    const first = new vscode.Position(hunks[0].newStart - 1, 0);
    editor.selection = new vscode.Selection(first, first);

    await vscode.commands.executeCommand('hunkwise.nextHunk');
    assert.strictEqual(editor.selection.active.line, hunks[1].newStart - 1, 'Next should move to second hunk');

    await vscode.commands.executeCommand('hunkwise.previousHunk');
    assert.strictEqual(editor.selection.active.line, hunks[0].newStart - 1, 'Previous should move back to first hunk');
  });

  test('acceptHunk on first hunk keeps cursor in place', async () => {
    const filePath = await setupMultiHunkFile();
    const sm = getStateManager();
    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'File should be in state');

    // Open the file in editor
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);

    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.ok(hunks.length >= 2, `Expected at least 2 hunks, got ${hunks.length}`);

    const firstHunkId = hunkId(hunks[0]);
    const originalLine = hunks[0].newStart - 1;
    const pos = new vscode.Position(originalLine, 0);
    editor.selection = new vscode.Selection(pos, pos);

    // Accept the first hunk
    acceptHunk(sm, filePath, firstHunkId, () => {});
    await sleep(200);

    // Verify the file still has remaining hunks
    const updatedState = sm.getFile(filePath);
    assert.ok(updatedState, 'File should still be tracked');
    assert.strictEqual(updatedState?.status, 'reviewing', 'File should still be in reviewing state');

    // Recompute hunks and verify cursor did not auto-jump to the next hunk.
    const remainingHunks = computeHunks(updatedState!.baseline, doc.getText());
    assert.ok(remainingHunks.length >= 1, `Expected remaining hunks, got ${remainingHunks.length}`);
    const cursorLine = editor.selection.active.line;
    assert.strictEqual(cursorLine, originalLine,
      `Cursor should stay at line ${originalLine}, but is at line ${cursorLine}`);
  });

  test('discardHunk on first hunk keeps cursor in place', async () => {
    const filePath = await setupMultiHunkFile();
    const sm = getStateManager();
    const fw = getFileWatcher();
    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'File should be in state');
    assert.ok(fw, 'FileWatcher should be available');

    // Open the file in editor
    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);

    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.ok(hunks.length >= 2, `Expected at least 2 hunks, got ${hunks.length}`);

    const firstHunkId = hunkId(hunks[0]);
    const originalLine = hunks[0].newStart - 1;
    const pos = new vscode.Position(originalLine, 0);
    editor.selection = new vscode.Selection(pos, pos);

    // Discard the first hunk
    await discardHunk(sm, fw, filePath, firstHunkId, () => {});
    await sleep(200);

    // Verify the file still has remaining hunks
    const updatedState = sm.getFile(filePath);
    assert.ok(updatedState, 'File should still be tracked');
    assert.strictEqual(updatedState?.status, 'reviewing', 'File should still be in reviewing state');

    // Recompute hunks and verify cursor did not auto-jump to the next hunk.
    const updatedDoc = editor.document;
    const remainingHunks = computeHunks(updatedState!.baseline, updatedDoc.getText());
    assert.ok(remainingHunks.length >= 1, `Expected remaining hunks, got ${remainingHunks.length}`);
    const cursorLine = editor.selection.active.line;
    assert.strictEqual(cursorLine, originalLine,
      `Cursor should stay at line ${originalLine}, but is at line ${cursorLine}`);
  });

  test('acceptHunk on last hunk does not jump (exits reviewing)', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'single-hunk.txt');

    // Create a file with a single hunk
    const baseline = 'original line\n';
    writeFileExternally(filePath, baseline);
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    writeFileExternally(filePath, 'modified line\n');

    const sm = getStateManager();
    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    const fileState = sm.getFile(filePath)!;
    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.strictEqual(hunks.length, 1, 'Should have exactly 1 hunk');

    const theHunkId = hunkId(hunks[0]);

    // Accept the only hunk — should exit reviewing, no jump needed
    acceptHunk(sm, filePath, theHunkId, () => {});
    await sleep(200);

    // File should no longer be in reviewing
    const updatedState = sm.getFile(filePath);
    assert.ok(!updatedState || updatedState.status !== 'reviewing',
      'File should exit reviewing after accepting last hunk');
  });

  test('undoReviewAction restores state after accepting a hunk', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'undo-accept.txt');
    const baseline = 'original line\n';
    const modified = 'modified line\n';

    writeFileExternally(filePath, baseline);
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) === baseline, 5000);

    writeFileExternally(filePath, modified);

    const sm = getStateManager();
    await waitForCondition(() => sm.getFile(filePath)?.status === 'reviewing', 5000);

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    const fileState = sm.getFile(filePath)!;
    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.strictEqual(hunks.length, 1, 'Should have exactly 1 hunk');

    acceptHunk(sm, filePath, hunkId(hunks[0]), () => {});
    await waitForCondition(() => !sm.getFile(filePath), 5000);

    await vscode.commands.executeCommand('hunkwise.undoReviewAction');

    await waitForCondition(() => sm.getFile(filePath)?.status === 'reviewing', 5000);
    assert.strictEqual(sm.getFile(filePath)?.baseline, baseline, 'Undo should restore the pre-accept baseline');
    await waitForCondition(() => gitGetBaseline(root, rel) === baseline, 5000);

    const restoredHunks = computeHunks(sm.getFile(filePath)!.baseline, doc.getText());
    assert.strictEqual(restoredHunks.length, 1, 'Accepted hunk should be selectable again after undo');
  });

  test('undoReviewAction can step back through multiple accepted hunks', async () => {
    const filePath = await setupMultiHunkFile();
    const sm = getStateManager();
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    const initialState = sm.getFile(filePath)!;
    const initialBaseline = initialState.baseline;
    const initialHunks = computeHunks(initialBaseline, doc.getText());
    assert.ok(initialHunks.length >= 3, `Expected at least 3 hunks, got ${initialHunks.length}`);

    acceptHunk(sm, filePath, hunkId(initialHunks[0]), () => {});
    const afterFirst = sm.getFile(filePath)!;
    const afterFirstBaseline = afterFirst.baseline;
    assert.notStrictEqual(afterFirstBaseline, initialBaseline, 'First accept should update baseline');

    const hunksAfterFirst = computeHunks(afterFirstBaseline, doc.getText());
    acceptHunk(sm, filePath, hunkId(hunksAfterFirst[0]), () => {});
    const afterSecond = sm.getFile(filePath)!;
    assert.notStrictEqual(afterSecond.baseline, afterFirstBaseline, 'Second accept should update baseline again');

    await vscode.commands.executeCommand('hunkwise.undoReviewAction');
    await waitForCondition(() => sm.getFile(filePath)?.baseline === afterFirstBaseline, 5000);

    await vscode.commands.executeCommand('hunkwise.undoReviewAction');
    await waitForCondition(() => sm.getFile(filePath)?.baseline === initialBaseline, 5000);
  });

  test('discardHunk on last hunk does not jump (exits reviewing)', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'single-hunk-discard.txt');

    const baseline = 'original line\n';
    writeFileExternally(filePath, baseline);
    await enableHunkwise();

    const rel = path.relative(root, filePath);
    await waitForCondition(() => gitGetBaseline(root, rel) !== undefined, 5000);

    writeFileExternally(filePath, 'modified line\n');

    const sm = getStateManager();
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');

    await waitForCondition(() => {
      const f = sm.getFile(filePath);
      return f?.status === 'reviewing';
    }, 5000);

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    const fileState = sm.getFile(filePath)!;
    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.strictEqual(hunks.length, 1, 'Should have exactly 1 hunk');

    const theHunkId = hunkId(hunks[0]);

    // Discard the only hunk — should exit reviewing, no jump needed
    await discardHunk(sm, fw, filePath, theHunkId, () => {});
    await sleep(200);

    // File should no longer be in reviewing
    const updatedState = sm.getFile(filePath);
    assert.ok(!updatedState || updatedState.status !== 'reviewing',
      'File should exit reviewing after discarding last hunk');
  });

  test('acceptHunk on middle hunk keeps cursor in place', async () => {
    const filePath = await setupMultiHunkFile();
    const sm = getStateManager();
    const fileState = sm.getFile(filePath);
    assert.ok(fileState, 'File should be in state');

    const doc = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(doc);

    const hunks = computeHunks(fileState.baseline, doc.getText());
    assert.ok(hunks.length >= 3, `Expected at least 3 hunks, got ${hunks.length}`);

    const middleHunkId = hunkId(hunks[1]);
    const originalLine = hunks[1].newStart - 1;
    const pos = new vscode.Position(originalLine, 0);
    editor.selection = new vscode.Selection(pos, pos);

    // Accept the middle hunk
    acceptHunk(sm, filePath, middleHunkId, () => {});
    await sleep(200);

    // Recompute hunks and verify cursor did not auto-jump.
    const updatedState = sm.getFile(filePath);
    assert.ok(updatedState, 'File should still be tracked');
    const remainingHunks = computeHunks(updatedState!.baseline, doc.getText());
    assert.ok(remainingHunks.length >= 2,
      `Expected at least 2 remaining hunks, got ${remainingHunks.length}`);

    const cursorLine = editor.selection.active.line;
    assert.strictEqual(cursorLine, originalLine,
      `Cursor should stay at line ${originalLine}, but is at line ${cursorLine}`);
  });
});
