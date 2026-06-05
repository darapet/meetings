// ============================================================
//  MEETAI — LIVE CONFIGURATION (credentials embedded)
// ============================================================

// ── Firebase ───────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyABYjReNl31nbC6K-7HyA-BKkD1XVIazQY",
  authDomain:        "darapet-meeting.firebaseapp.com",
  databaseURL:       "https://darapet-meeting-default-rtdb.firebaseio.com",
  projectId:         "darapet-meeting",
  storageBucket:     "darapet-meeting.firebasestorage.app",
  messagingSenderId: "310700176619",
  appId:             "1:310700176619:web:0696c721ba687b570cfaae",
  measurementId:     "G-7BW8H5TSWE"
};

// ── Mistral AI — 5 keys with automatic rotation ────────────
const MISTRAL_API_KEYS = [
  "dHwuSfyXHhcPFgdEhdCPfM3qDVvZZjZG",
  "sILH5fpQExwLmmCCDwCgGhXBO4HMrADU",
  "Z2OL9qxcvcLaKTsog0SeI06NKbphGRyo",
  "9kdzxBCkagzIAQxaXmukgegae9ELK1pH",
  "U2UvNUe802YdkhFfTmlZaoBrthxSopDP"
];

const MISTRAL_MODEL   = "mistral-small-latest";
const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";

// ── Key rotation state ─────────────────────────────────────
let _mistralKeyIndex = 0;

function getMistralKey() {
  return MISTRAL_API_KEYS[_mistralKeyIndex % MISTRAL_API_KEYS.length];
}

function rotateMistralKey() {
  _mistralKeyIndex = (_mistralKeyIndex + 1) % MISTRAL_API_KEYS.length;
}

// ── Call Mistral (auto-rotates on rate-limit) ──────────────
async function callMistral(messages, options = {}) {
  const maxAttempts = MISTRAL_API_KEYS.length;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = getMistralKey();
    try {
      const res = await fetch(MISTRAL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${key}`
        },
        body: JSON.stringify({
          model:       options.model       || MISTRAL_MODEL,
          temperature: options.temperature || 0.4,
          max_tokens:  options.max_tokens  || 1500,
          messages
        })
      });

      if (res.status === 429 || res.status === 503) {
        rotateMistralKey();
        lastError = `Key #${attempt + 1} rate-limited`;
        await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }

      const json = await res.json();
      return json.choices[0].message.content;

    } catch (err) {
      lastError = err.message;
      rotateMistralKey();
    }
  }

  return `❌ AI error: ${lastError}. Please try again.`;
}

// ── WebRTC ICE servers ─────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com" }
  ]
};

const APP_NAME    = "MeetAI";
const APP_VERSION = "1.0.0";
