const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, 'public', 'audio', 'cache');
const DYNAMIC_DIR = path.join(__dirname, 'public', 'audio', 'dynamic');

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(DYNAMIC_DIR, { recursive: true });

// Dynamic per-call files are meant to live only a few minutes (see the setTimeout
// below) - if the process crashed or was restarted before a file's timer fired, this
// clears the leftovers on the next startup instead of needing a cron/scheduler.
for (const file of fs.readdirSync(DYNAMIC_DIR)) {
  fs.unlinkSync(path.join(DYNAMIC_DIR, file));
}

const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';

// H4 hardening: per-call TTS files can contain caller PII (name, address, order
// details), so their URLs are HMAC-signed with a short expiry (see
// getDynamicAudioUrl / verifyDynamicToken). Twilio fetches <Play> media within a
// few seconds, so 120s is generous. DYNAMIC_FILE_TTL_MS (the on-disk lifetime, was
// 5 minutes) is dropped to match: once the signed URL is dead there's no legitimate
// reason for the file to still exist, and a leaked URL then fails twice over
// (expired signature AND missing file). The startup sweep and the per-file
// setTimeout below are unchanged apart from this shorter constant.
const DYNAMIC_URL_TTL_MS = 2 * 60 * 1000;
const DYNAMIC_FILE_TTL_MS = 2 * 60 * 1000;

// Same fallback as server.js's session secret, so both sides of the HMAC agree even
// when SESSION_SECRET is unset in local dev. Outside development server.js refuses to
// start without a real SESSION_SECRET (H3), so this fallback is dev-only in practice.
const AUDIO_SIGNING_SECRET = process.env.SESSION_SECRET || 'dev-secret';

// HMAC over "<filename>:<expiresAt>" - binds the token to one specific file and one
// expiry instant, so it can't be moved to another file or extended.
function signDynamicToken(filename, expiresAt) {
  return crypto
    .createHmac('sha256', AUDIO_SIGNING_SECRET)
    .update(`${filename}:${expiresAt}`)
    .digest('hex');
}

// True only for a well-formed, correctly-signed, not-yet-expired token. Every
// malformed or failing case returns false the same way - the caller (the guarded
// /audio/dynamic route in server.js) turns any false into an identical generic 404,
// so a probe can't distinguish "bad signature" from "expired" from "no such file".
function verifyDynamicToken(filename, exp, sig) {
  if (!filename || !exp || !sig) {
    return false;
  }
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return false;
  }
  const expected = signDynamicToken(filename, expiresAt);
  const given = String(sig);
  if (given.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// Lower-bitrate MP3 than ElevenLabs' default (mp3_44100_128) - smaller file means both
// faster generation and a faster fetch when Twilio retrieves it for <Play>. Phone audio
// is already low-fidelity (Twilio's own codec), so the quality difference isn't audible
// on a call.
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_22050_32';

async function callElevenLabsTTS(text) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    throw new Error('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not configured.');
  }

  const startedAt = Date.now();
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({ text, model_id: MODEL_ID })
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs TTS request failed: ${response.status} ${response.statusText}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  // See the matching [latency] log in server.js - this is the other half of a turn's
  // time budget, generation only (doesn't include Twilio then fetching the file back
  // over the ngrok tunnel for <Play>).
  console.log(`[latency] ElevenLabs generation: ${Date.now() - startedAt}ms (${text.length} chars)`);
  return audio;
}

function buildUrl(req, relPath) {
  return `${req.protocol}://${req.get('host')}/${relPath}`;
}

// Static lines (greeting, farewells, error messages) are identical on every call, so
// they're generated once per unique text and reused forever after - the cache key is a
// hash of the text itself, so two call sites with the same wording automatically share
// one file, and edited wording just produces a new file rather than serving stale audio.
async function getCachedAudioUrl(text, req) {
  const filename = `${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}.mp3`;
  const filePath = path.join(CACHE_DIR, filename);

  if (!fs.existsSync(filePath)) {
    const audio = await callElevenLabsTTS(text);
    fs.writeFileSync(filePath, audio);
  }

  return buildUrl(req, `audio/cache/${filename}`);
}

// CafeBot's actual reply is different every turn, so it's always generated fresh and
// never cached. The file is deleted a couple of minutes later, well after Twilio has
// fetched it for <Play> - unref() so the timer can't keep the process alive or block
// --watch restarts. The returned URL carries an HMAC-signed, ~120s expiry token that
// the guarded /audio/dynamic route in server.js checks before serving (H4 hardening).
async function getDynamicAudioUrl(text, req, callSid) {
  const safeCallSid = String(callSid).replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = `${safeCallSid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`;
  const filePath = path.join(DYNAMIC_DIR, filename);

  const audio = await callElevenLabsTTS(text);
  fs.writeFileSync(filePath, audio);

  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, DYNAMIC_FILE_TTL_MS).unref();

  const expiresAt = Date.now() + DYNAMIC_URL_TTL_MS;
  const sig = signDynamicToken(filename, expiresAt);
  return buildUrl(req, `audio/dynamic/${filename}?exp=${expiresAt}&sig=${sig}`);
}

// Speaks `text` into `container` (a Twilio VoiceResponse or a <Gather> node - both
// expose .say()/.play()) via ElevenLabs-generated audio, falling back to Twilio's own
// <Say> if ElevenLabs is unavailable for any reason so a call never breaks.
async function speak(container, text, { req, cache = false, callSid } = {}) {
  try {
    const url = cache
      ? await getCachedAudioUrl(text, req)
      : await getDynamicAudioUrl(text, req, callSid);
    container.play(url);
  } catch (err) {
    console.error('ElevenLabs TTS failed, falling back to Twilio <Say>:', err.message);
    container.say(text);
  }
}

module.exports = { speak, signDynamicToken, verifyDynamicToken, DYNAMIC_DIR };
