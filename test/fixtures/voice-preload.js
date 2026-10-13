// Loaded with `node --require` into the server child processes started by
// test/d3-voice.test.js. It makes those servers safe to run with zero spend:
//
//   1. Outbound network is loopback only. Any http, https or fetch request to another
//      host fails before a socket is opened, so no real Anthropic, ElevenLabs, Twilio or
//      database call can happen even if a key were somehow present.
//   2. ElevenLabs requests never succeed, so no fake audio is ever written into the real
//      public/audio cache. FAKE_TTS=hang-replies makes per-turn replies (texts starting
//      "ack" or "OK") hang until the caller's own timeout aborts them, for the H5 timeout
//      checks. Everything else fails at once, which falls back to Twilio <Say>.
//   3. db.js is replaced by a stub whose loadStock returns FAKE_SOLD_OUT (a JSON array of
//      menu names) as out-of-stock rows, so stock state can be set without a database.
//
// Holds no secrets. The child's environment is built from scratch by the test.

const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const Module = require('node:module');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostOf(args) {
  const first = args[0];
  if (typeof first === 'string') return new URL(first).hostname;
  if (first instanceof URL) return first.hostname;
  if (first && typeof first === 'object') return first.hostname || first.host || 'localhost';
  return 'localhost';
}

for (const mod of [http, https]) {
  for (const fn of ['request', 'get']) {
    const original = mod[fn];
    mod[fn] = function guarded(...args) {
      const host = String(hostOf(args)).replace(/:\d+$/, '');
      if (!LOOPBACK.has(host)) {
        throw new Error(`[voice-preload] blocked outbound request to ${host}`);
      }
      return original.apply(this, args);
    };
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.hostname === 'api.elevenlabs.io') {
    let text = '';
    try {
      text = JSON.parse(init.body).text || '';
    } catch {
      // not JSON, treated as a static line
    }
    if (process.env.FAKE_TTS === 'hang-replies' && /^(ack|OK)/.test(text)) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    throw new Error('[voice-preload] fake ElevenLabs is unavailable');
  }
  if (!LOOPBACK.has(url.hostname)) {
    throw new Error(`[voice-preload] blocked outbound fetch to ${url.hostname}`);
  }
  return originalFetch(input, init);
};

const dbPath = path.join(__dirname, '..', '..', 'db.js');
const stub = new Module(dbPath);
stub.filename = dbPath;
stub.loaded = true;
stub.exports = {
  loadStock: async () =>
    JSON.parse(process.env.FAKE_SOLD_OUT || '[]').map((name) => ({ item_name: name, in_stock: false }))
};
require.cache[dbPath] = stub;
