import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTextFileSync } from '../fileContent';

function withTmpFile(name: string, content: string | Buffer, fn: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunkwise-file-content-'));
  try {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('readTextFileSync', () => {
  it('reads utf8 text', () => {
    withTmpFile('a.txt', 'hello\nworld\n', filePath => {
      const read = readTextFileSync(filePath);
      assert.equal(read.ok, true);
      if (read.ok) assert.equal(read.content, 'hello\nworld\n');
    });
  });

  it('reads utf16le text with BOM', () => {
    const text = 'hello\n世界\n';
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    withTmpFile('utf16.txt', buffer, filePath => {
      const read = readTextFileSync(filePath);
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.encoding, 'utf16le');
        assert.equal(read.content, text);
      }
    });
  });

  it('rejects binary files', () => {
    withTmpFile('a.bin', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]), filePath => {
      const read = readTextFileSync(filePath);
      assert.equal(read.ok, false);
      if (!read.ok) assert.equal(read.reason, 'binary');
    });
  });

  it('rejects files over the configured byte limit', () => {
    withTmpFile('large.txt', 'abcdef', filePath => {
      const read = readTextFileSync(filePath, 3);
      assert.equal(read.ok, false);
      if (!read.ok) assert.equal(read.reason, 'tooLarge');
    });
  });
});
