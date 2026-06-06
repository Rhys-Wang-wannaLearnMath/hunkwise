import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

// Logging is on by default so behavior is unchanged. Set HUNKWISE_LOG=0 (or
// false/off) to silence all extension logging. When disabled, lazy log messages
// (passed as thunks on hot paths) are never even built, so logging costs zero.
let enabled = !/^(0|false|off)$/i.test(process.env.HUNKWISE_LOG ?? '');

export function initLog(): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Hunkwise');
  }
}

export function setLogEnabled(value: boolean): void {
  enabled = value;
}

export function isLogEnabled(): boolean {
  return enabled;
}

// Accepts a plain string or a thunk. Use the thunk form on hot paths so the
// (often expensive) message interpolation is skipped entirely when disabled.
export function log(message: string | (() => string)): void {
  if (!enabled || !channel) return;
  const text = typeof message === 'function' ? message() : message;
  channel.appendLine(`[${new Date().toISOString()}] ${text}`);
}
