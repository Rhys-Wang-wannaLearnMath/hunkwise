import * as vscode from 'vscode';
import * as path from 'path';
import assert from 'assert';
import {
  getWorkspaceRoot,
  sleep, waitForCondition, enableHunkwise, disableHunkwise,
  writeFileExternally, cleanWorkspace, getStateManager, getFileWatcher,
} from './helpers';

suite('hunkwise file-type filtering integration', function () {
  this.timeout(30000);

  setup(function () {
    cleanWorkspace();
  });

  teardown(async function () {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    try {
      const sm = getStateManager();
      sm?.setTrackCodeDocsOnly(false);
    } catch { /* ignore */ }
    try { await disableHunkwise(); } catch { /* ignore */ }
    cleanWorkspace();
  });

  test('default (off): all file types are tracked', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');

    const lockFile = path.join(root, 'deps.lock');
    writeFileExternally(lockFile, 'lockdata\n');
    const fw = getFileWatcher();
    await (fw as any).onDiskCreate(vscode.Uri.file(lockFile));

    await waitForCondition(() => sm.getFile(lockFile)?.status === 'reviewing', 8000);
    assert.ok(sm.getFile(lockFile), 'with filtering off, any file type should be reviewed');
  });

  test('trackCodeDocsOnly: allowlisted files reviewed, others ignored', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    sm.setTrackCodeDocsOnly(true);
    await sleep(300);

    const tsFile = path.join(root, 'code.ts');
    const lockFile = path.join(root, 'pkg.lock');
    writeFileExternally(tsFile, 'export const x = 1;\n');
    writeFileExternally(lockFile, 'lockdata\n');

    const fw = getFileWatcher();
    await (fw as any).onDiskCreate(vscode.Uri.file(tsFile));
    await (fw as any).onDiskCreate(vscode.Uri.file(lockFile));

    await waitForCondition(() => sm.getFile(tsFile)?.status === 'reviewing', 8000);
    assert.ok(sm.getFile(tsFile), 'allowlisted .ts file should be reviewed');
    await sleep(500);
    assert.ok(!sm.getFile(lockFile), 'non-allowlisted .lock file should be ignored');
  });

  test('custom trackedExtensions allowlist is honored', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    // Only track .lock; .ts becomes ignored.
    sm.setTrackedExtensions(['lock']);
    sm.setTrackCodeDocsOnly(true);
    await sleep(300);

    const lockFile = path.join(root, 'x.lock');
    const tsFile = path.join(root, 'y.ts');
    writeFileExternally(lockFile, 'a\n');
    writeFileExternally(tsFile, 'b\n');

    const fw = getFileWatcher();
    await (fw as any).onDiskCreate(vscode.Uri.file(lockFile));
    await (fw as any).onDiskCreate(vscode.Uri.file(tsFile));

    await waitForCondition(() => sm.getFile(lockFile)?.status === 'reviewing', 8000);
    assert.ok(sm.getFile(lockFile), 'custom-allowlisted .lock should be reviewed');
    await sleep(500);
    assert.ok(!sm.getFile(tsFile), '.ts not in custom allowlist should be ignored');
  });

  test('exact filename allowlist entry (Dockerfile) is honored', async () => {
    const root = getWorkspaceRoot();
    await enableHunkwise();
    const sm = getStateManager();
    assert.ok(sm, 'StateManager should be available');
    sm.setTrackCodeDocsOnly(true);
    await sleep(300);

    const dockerfile = path.join(root, 'Dockerfile');
    writeFileExternally(dockerfile, 'FROM node:20\n');
    const fw = getFileWatcher();
    await (fw as any).onDiskCreate(vscode.Uri.file(dockerfile));

    await waitForCondition(() => sm.getFile(dockerfile)?.status === 'reviewing', 8000);
    assert.ok(sm.getFile(dockerfile), 'Dockerfile (exact name in allowlist) should be reviewed');
  });
});
