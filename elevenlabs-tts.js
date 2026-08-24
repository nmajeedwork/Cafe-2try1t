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
const DYNAMIC_FILE_TTL_MS = 5 * 60 * 1000;

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
// never cached. The file is deleted a few minutes later, well after Twilio has fetched
// it for <Play> - unref() so the timer can't keep the process alive or block --watch restarts.
async function getDynamicAudioUrl(text, req, callSid) {
  const safeCallSid = String(callSid).replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = `${safeCallSid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`;
  const filePath = path.join(DYNAMIC_DIR, filename);

  const audio = await callElevenLabsTTS(text);
  fs.writeFileSync(filePath, audio);

  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, DYNAMIC_FILE_TTL_MS).unref();

  return buildUrl(req, `audio/dynamic/${filename}`);
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

module.exports = { speak };
