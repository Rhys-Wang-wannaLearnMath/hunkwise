import * as fs from 'fs';

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

export type TextFileReadResult =
  | { ok: true; content: string; byteLength: number; encoding: 'utf8' | 'utf16le' | 'utf16be' }
  | { ok: false; reason: 'binary' | 'tooLarge' | 'unreadable'; byteLength?: number; errorCode?: string };

export function textLooksBinary(content: string): boolean {
  const sample = content.slice(0, 8192);
  let controlCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    if (code < 7 || (code > 14 && code < 32)) controlCount++;
  }
  if (sample.length > 0 && controlCount / sample.length > 0.1) return true;

  const replacementCount = sample.split('\ufffd').length - 1;
  return replacementCount > Math.max(8, sample.length * 0.01);
}

function decodeTextBuffer(buffer: Buffer): { content: string; encoding: 'utf8' | 'utf16le' | 'utf16be' } | undefined {
  if (buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf) {
    return { content: buffer.subarray(3).toString('utf8'), encoding: 'utf8' };
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { content: buffer.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const b = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = b;
    }
    return { content: swapped.toString('utf16le'), encoding: 'utf16be' };
  }

  const sampleLength = Math.min(buffer.length, 8192);
  let controlCount = 0;
  for (let i = 0; i < sampleLength; i++) {
    const byte = buffer[i];
    if (byte === 0) return undefined;
    if (byte < 7 || (byte > 14 && byte < 32)) controlCount++;
  }
  if (sampleLength > 0 && controlCount / sampleLength > 0.1) return undefined;

  const content = buffer.toString('utf8');
  if (textLooksBinary(content)) return undefined;

  return { content, encoding: 'utf8' };
}

function readTextBuffer(buffer: Buffer, maxBytes: number): TextFileReadResult {
  if (buffer.byteLength > maxBytes) {
    return { ok: false, reason: 'tooLarge', byteLength: buffer.byteLength };
  }

  const decoded = decodeTextBuffer(buffer);
  if (!decoded) {
    return { ok: false, reason: 'binary', byteLength: buffer.byteLength };
  }

  return { ok: true, content: decoded.content, byteLength: buffer.byteLength, encoding: decoded.encoding };
}

export async function readTextFile(filePath: string, maxBytes: number = MAX_TEXT_FILE_BYTES): Promise<TextFileReadResult> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (err: any) {
    return { ok: false, reason: 'unreadable', errorCode: err?.code };
  }

  if (!stat.isFile()) {
    return { ok: false, reason: 'unreadable' };
  }
  if (stat.size > maxBytes) {
    return { ok: false, reason: 'tooLarge', byteLength: stat.size };
  }

  try {
    return readTextBuffer(await fs.promises.readFile(filePath), maxBytes);
  } catch (err: any) {
    return { ok: false, reason: 'unreadable', byteLength: stat.size, errorCode: err?.code };
  }
}

export function readTextFileSync(filePath: string, maxBytes: number = MAX_TEXT_FILE_BYTES): TextFileReadResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err: any) {
    return { ok: false, reason: 'unreadable', errorCode: err?.code };
  }

  if (!stat.isFile()) {
    return { ok: false, reason: 'unreadable' };
  }
  if (stat.size > maxBytes) {
    return { ok: false, reason: 'tooLarge', byteLength: stat.size };
  }

  try {
    return readTextBuffer(fs.readFileSync(filePath), maxBytes);
  } catch (err: any) {
    return { ok: false, reason: 'unreadable', byteLength: stat.size, errorCode: err?.code };
  }
}
