import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { parseEditedFilesFromPatch, parseEditedFilesFromCommand } from '../codexPatchParse';

describe('parseEditedFilesFromPatch', () => {
  it('parses a single Update File', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/foo.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    assert.deepEqual(parseEditedFilesFromPatch(patch), ['src/foo.ts']);
  });

  it('parses Add and Delete File', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a/new.ts',
      '+hello',
      '*** Delete File: a/old.ts',
      '*** End Patch',
    ].join('\n');
    assert.deepEqual(parseEditedFilesFromPatch(patch), ['a/new.ts', 'a/old.ts']);
  });

  it('includes both old path and Move-to target for renames', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/old-name.ts',
      '*** Move to: src/new-name.ts',
      '@@',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n');
    assert.deepEqual(parseEditedFilesFromPatch(patch), ['src/old-name.ts', 'src/new-name.ts']);
  });

  it('parses multiple files in one patch', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '+1',
      '*** Update File: dir/b.ts',
      '+2',
      '*** End Patch',
    ].join('\n');
    assert.deepEqual(parseEditedFilesFromPatch(patch), ['a.ts', 'dir/b.ts']);
  });

  it('parses apply_patch embedded in a Bash heredoc', () => {
    const command = [
      "apply_patch <<'EOF'",
      '*** Begin Patch',
      '*** Update File: src/index.ts',
      '@@',
      '-a',
      '+b',
      '*** End Patch',
      'EOF',
    ].join('\n');
    assert.deepEqual(parseEditedFilesFromPatch(command), ['src/index.ts']);
  });

  it('returns [] for a plain command with no patch', () => {
    assert.deepEqual(parseEditedFilesFromPatch('npm test'), []);
    assert.deepEqual(parseEditedFilesFromPatch(''), []);
  });

  it('tolerates leading whitespace and trailing CR', () => {
    const patch = '  *** Update File: src/foo.ts\r\n+x\r\n';
    assert.deepEqual(parseEditedFilesFromPatch(patch), ['src/foo.ts']);
  });

  it('strips surrounding quotes from paths with spaces', () => {
    const patch = '*** Update File: "src/my file.ts"\n+x\n';
    assert.deepEqual(parseEditedFilesFromPatch(patch), ['src/my file.ts']);
  });
});

describe('parseEditedFilesFromCommand', () => {
  it('resolves relative paths against cwd', () => {
    const patch = '*** Update File: src/foo.ts\n+x\n';
    assert.deepEqual(
      parseEditedFilesFromCommand(patch, '/repo'),
      [path.resolve('/repo', 'src/foo.ts')]
    );
  });

  it('keeps absolute paths as-is', () => {
    const patch = '*** Update File: /abs/foo.ts\n+x\n';
    assert.deepEqual(parseEditedFilesFromCommand(patch, '/repo'), ['/abs/foo.ts']);
  });

  it('de-duplicates repeated paths', () => {
    const patch = [
      '*** Update File: a.ts',
      '+1',
      '*** Update File: a.ts',
      '+2',
    ].join('\n');
    assert.deepEqual(parseEditedFilesFromCommand(patch, '/repo'), [path.resolve('/repo', 'a.ts')]);
  });

  it('returns [] when there is no patch', () => {
    assert.deepEqual(parseEditedFilesFromCommand('ls -la', '/repo'), []);
  });
});
