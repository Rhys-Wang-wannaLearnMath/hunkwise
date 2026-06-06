import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot, gitGetBaseline,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher,
} from './helpers';
import { acceptFileByPath } from '../../commands';

/** Simulate the Codex hook recording an apply_patch edit of the given paths. */
function appendCodexSignal(root: string, relPaths: string[]): void {
  const signalPath = path.join(root, '.vscode', 'hunkwise', 'codex-edits.jsonl');
  fs.mkdirSync(path.dirname(signalPath), { recursive: true });
  const command = '*** Begin Patch\n'
    + relPaths.map(r => `*** Update File: ${r}\n@@\n+x\n`).join('')
    + '*** End Patch\n';
  const record = { ts: Date.now(), tool_name: 'apply_patch', cwd: root, command };
  fs.appendFileSync(signalPath, JSON.stringify(record) + '\n');
}

suite('hunkwise codex-only integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try {
      const sm = getStateManager();
      sm?.setCodexOnly(false);
    } catch { /* ignore */ }
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('non-Codex change is silently absorbed into the baseline, not reviewed', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'user-edit.txt');
    const rel = path.relative(root, filePath);

    writeFileExternally(filePath, 'original\n');
    await enableHunkwise();
    await waitForCondition(() => gitGetBaseline(root, rel) === 'original\n', 5000);

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    sm.setCodexOnly(true);

    // User edits the file; no Codex signal is emitted for it.
    writeFileExternally(filePath, 'original\nuser change\n');
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');
    await (fw as any).onDiskChange(vscode.Uri.file(filePath));

    // After the grace window the change should be absorbed into the baseline
    // and never appear in review.
    await waitForCondition(
      () => !sm.getFile(filePath) && gitGetBaseline(root, rel) === 'original\nuser change\n',
      6000
    );
    assert.ok(!sm.getFile(filePath), 'non-Codex change must not enter review in codex-only mode');
    assert.strictEqual(
      gitGetBaseline(root, rel),
      'original\nuser change\n',
      'non-Codex change should be silently accepted as the new baseline'
    );
  });

  test('Codex-signaled change enters review against the original baseline', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'codex-edit.txt');
    const rel = path.relative(root, filePath);

    writeFileExternally(filePath, 'original\n');
    await enableHunkwise();
    await waitForCondition(() => gitGetBaseline(root, rel) === 'original\n', 5000);

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    sm.setCodexOnly(true);

    // Codex edits the file, then its hook records the edit in the signal file.
    writeFileExternally(filePath, 'original\ncodex change\n');
    appendCodexSignal(root, [rel]);

    await waitForCondition(() => sm.getFile(filePath)?.status === 'reviewing', 8000);
    assert.strictEqual(
      sm.getFile(filePath)?.baseline,
      'original\n',
      'Codex edit should be reviewed against the pre-edit baseline'
    );
  });

  test('accepting a Codex file forgets attribution so later user edits are not reviewed', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'codex-then-user.txt');
    const rel = path.relative(root, filePath);

    writeFileExternally(filePath, 'original\n');
    await enableHunkwise();
    await waitForCondition(() => gitGetBaseline(root, rel) === 'original\n', 5000);

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    sm.setCodexOnly(true);

    // Codex edits → reviewed
    writeFileExternally(filePath, 'codex v1\n');
    appendCodexSignal(root, [rel]);
    await waitForCondition(() => sm.getFile(filePath)?.status === 'reviewing', 8000);

    // Accept it
    acceptFileByPath(sm, filePath, () => {});
    await waitForCondition(() => !sm.getFile(filePath), 5000);
    await waitForCondition(() => gitGetBaseline(root, rel) === 'codex v1\n', 5000);

    // Now the user edits the same file with no Codex signal → must be absorbed,
    // proving the Codex attribution was cleared on accept.
    writeFileExternally(filePath, 'codex v1\nuser\n');
    const fw = getFileWatcher();
    assert.ok(fw, 'FileWatcher should be available');
    await (fw as any).onDiskChange(vscode.Uri.file(filePath));

    await waitForCondition(
      () => !sm.getFile(filePath) && gitGetBaseline(root, rel) === 'codex v1\nuser\n',
      6000
    );
    assert.ok(!sm.getFile(filePath), 'post-accept user edit must not enter review');
    assert.strictEqual(gitGetBaseline(root, rel), 'codex v1\nuser\n');
  });

  test('normal mode (codexOnly off) still reviews any change', async () => {
    const root = getWorkspaceRoot();
    const filePath = path.join(root, 'normal-mode.txt');
    const rel = path.relative(root, filePath);

    writeFileExternally(filePath, 'original\n');
    await enableHunkwise();
    await waitForCondition(() => gitGetBaseline(root, rel) === 'original\n', 5000);

    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    // Integration tests run with HUNKWISE_DEFAULT_CODEX_ONLY=0; explicitly off here

    writeFileExternally(filePath, 'original\nplain change\n');
    const fw = getFileWatcher();
    await (fw as any).onDiskChange(vscode.Uri.file(filePath));

    await waitForCondition(() => sm.getFile(filePath)?.status === 'reviewing', 5000);
    assert.strictEqual(sm.getFile(filePath)?.baseline, 'original\n');
  });
});
