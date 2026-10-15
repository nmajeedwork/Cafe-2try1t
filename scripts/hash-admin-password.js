#!/usr/bin/env node
// Makes the ADMIN_PASSWORD_HASH value for the admin login (D4).
//
//   node scripts/hash-admin-password.js               prints ADMIN_PASSWORD_HASH=...
//   node scripts/hash-admin-password.js --new-secret  also prints ADMIN_SESSION_SECRET=...
//
// The password is typed at a hidden prompt, twice. It is never taken as an argument or from
// a pipe, so it cannot end up in shell history, and nothing is written to disk. Works in a
// Windows cmd or PowerShell window, Windows Terminal, and macOS or Linux terminals. Git Bash
// (mintty) does not give Node a real terminal, so run it from cmd or PowerShell there, or
// prefix it with winpty.
//
// Paste the printed line(s) into Render's environment settings (and into .env if you want
// admin locally), then redeploy. A new hash or secret also ends every existing admin session.

const crypto = require('node:crypto');
const { hashPassword, MAX_PASSWORD_BYTES } = require('../admin');

const MIN_LENGTH = 12;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Reads one line with echo off. Raw mode hands every key straight to us, on Windows too, so
// nothing is shown and Enter, Backspace and Ctrl+C are handled here.
function promptHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    // Arrow and function keys arrive as escape sequences (ESC, then "[" or "O", then
    // parameters, then one final letter or "~"). They are skipped, even when split across reads.
    let escape = 0; // 0: none, 1: just saw ESC, 2: inside the sequence
    const finish = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escape === 1) {
          escape = ch === '[' || ch === 'O' ? 2 : 0;
          continue;
        }
        if (escape === 2) {
          if (ch >= '@' && ch <= '~') escape = 0;
          continue;
        }
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          return fail('Cancelled.');
        }
        if (ch === '\u0008' || ch === '\u007f') {
          value = [...value].slice(0, -1).join('');
        } else if (ch === '\u001b') {
          escape = 1;
        } else if (ch >= ' ') {
          value += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--new-secret');
  if (unknown.length) {
    fail('Usage: node scripts/hash-admin-password.js [--new-secret]\nThe password is asked for at a hidden prompt, never passed as an argument.');
  }
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    fail('This needs an interactive terminal so the password can be typed hidden. Piped input is refused on purpose.\nOn Windows use cmd or PowerShell (in Git Bash, prefix the command with winpty).');
  }

  const first = await promptHidden(`New admin password (at least ${MIN_LENGTH} characters, input hidden): `);
  if ([...first].length < MIN_LENGTH) fail(`Too short: use at least ${MIN_LENGTH} characters.`);
  if (Buffer.byteLength(first) > MAX_PASSWORD_BYTES) fail(`Too long: use at most ${MAX_PASSWORD_BYTES} bytes.`);
  const second = await promptHidden('Type it again: ');
  if (first !== second) fail('The two entries did not match. Nothing was printed.');

  const hash = await hashPassword(first);
  process.stdout.write(`ADMIN_PASSWORD_HASH=${hash}\n`);
  if (args.includes('--new-secret')) {
    process.stdout.write(`ADMIN_SESSION_SECRET=${crypto.randomBytes(32).toString('base64url')}\n`);
  }
}

main().catch((err) => fail(`Failed: ${err.message}`));
