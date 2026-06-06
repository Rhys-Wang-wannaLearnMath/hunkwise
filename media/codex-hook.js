#!/usr/bin/env node
'use strict';
// hunkwise Codex hook
// ---------------------
// Installed by hunkwise as a Codex CLI `PostToolUse` command hook. Codex pipes a
// JSON payload on stdin after each tool call. This script records the raw edit
// command into a signal file (codex-edits.jsonl) sitting next to itself, which
// hunkwise watches to decide which files were changed by Codex.
//
// The script is intentionally tiny and dependency-free: all patch parsing lives
// in hunkwise so it can be improved without users reinstalling the hook. Any
// failure here is swallowed so it can never disrupt the Codex session.
const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) { input += chunk; });
process.stdin.on('end', function () {
  try {
    const payload = JSON.parse(input || '{}');
    const toolInput = (payload && payload.tool_input) || {};
    const record = {
      ts: Date.now(),
      tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : '',
      cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
      command: typeof toolInput.command === 'string' ? toolInput.command : '',
    };
    if (record.command) {
      fs.appendFileSync(path.join(__dirname, 'codex-edits.jsonl'), JSON.stringify(record) + '\n');
    }
  } catch (_err) {
    // Never let hook failures affect the Codex session.
  }
  try { process.stdout.write('{}'); } catch (_err) { /* ignore */ }
});
