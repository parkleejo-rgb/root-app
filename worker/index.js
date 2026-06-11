/**
 * Root Push Worker
 * Handles Web Push subscriptions and sends scheduled notifications.
 *
 * Secrets (set via `wrangler secret put`):
 *   VAPID_PRIVATE_JWK  — JWK JSON string for the VAPID EC private key
 *   VAPID_SUBJECT      — mailto: or https: contact URI, e.g. "mailto:admin@example.com"
 *
 * KV binding: SUBS
 * Env vars (set in wrangler.toml [vars] or as secrets):
 *   VAPID_PUBLIC_KEY   — base64url uncompressed P-256 public key (safe to commit as var)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Entry points ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    try {
      if (request.method === 'POST') {
        if (url.pathname === '/push/subscribe')    return handleSubscribe(request, env);
        if (url.pathname === '/push/unsubscribe')  return handleUnsubscribe(request, env);
        if (url.pathname === '/push/update-prefs') return handleUpdatePrefs(request, env);
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }
  },

  async scheduled(event, env) {
    await sendScheduledNotifications(env);
  },
};

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleSubscribe(request, env) {
  const body = await request.json();
  const { subscription, prefs } = body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return json({ error: 'Invalid subscription' }, 400);
  }
  const key = await subKey(subscription.endpoint);
  await env.SUBS.put(key, JSON.stringify({ subscription, prefs: prefs || {} }));
  return json({ ok: true });
}

async function handleUnsubscribe(request, env) {
  const { endpoint } = await request.json();
  if (!endpoint) return json({ error: 'Missing endpoint' }, 400);
  const key = await subKey(endpoint);
  await env.SUBS.delete(key);
  return json({ ok: true });
}

async function handleUpdatePrefs(request, env) {
  const { endpoint, prefs } = await request.json();
  if (!endpoint) return json({ error: 'Missing endpoint' }, 400);
  const key  = await subKey(endpoint);
  const data = await env.SUBS.get(key, 'json');
  if (!data) return json({ error: 'Subscription not found' }, 404);
  data.prefs = prefs;
  await env.SUBS.put(key, JSON.stringify(data));
  return json({ ok: true });
}

// ─── Scheduled notification sender ───────────────────────────────────────────

async function sendScheduledNotifications(env) {
  const now  = new Date();
  const list = await env.SUBS.list();

  await Promise.allSettled(list.keys.map(async ({ name: key }) => {
    // Skip ephemeral fired-flag entries
    if (key.startsWith('fired_')) return;

    const data = await env.SUBS.get(key, 'json');
    if (!data?.subscription || !data?.prefs) return;

    const { subscription, prefs } = data;

    // Compute user's local time using their stored UTC offset (minutes)
    const tzOffset  = typeof prefs.tzOffset === 'number' ? prefs.tzOffset : 0;
    const localDate = new Date(now.getTime() + tzOffset * 60000);
    const localHour = localDate.getUTCHours();
    const localMin  = localDate.getUTCMinutes();
    const localDay  = localDate.getUTCDay(); // 0=Sun
    const dateStr   = localDate.toISOString().slice(0, 10);

    const notifications = [];

    // Streak protection — fire at 7pm local (once per day)
    if (prefs.streakProtection && localHour === 19) {
      const firedKey = `fired_${key}_${dateStr}_streak`;
      if (!(await env.SUBS.get(firedKey))) {
        notifications.push({
          title: 'Root',
          body:  "Don't let your streak slip tonight. Check your habits.",
          tag:   'streak',
        });
        await env.SUBS.put(firedKey, '1', { expirationTtl: 86400 });
      }
    }

    // Weekly weigh-in — Sunday 9am local
    if (prefs.weighIn && localDay === 0 && localHour === 9) {
      const firedKey = `fired_${key}_${dateStr}_weighin`;
      if (!(await env.SUBS.get(firedKey))) {
        notifications.push({
          title: 'Root',
          body:  'Weekly weigh-in — log it while you\'re thinking about it.',
          tag:   'weighin',
        });
        await env.SUBS.put(firedKey, '1', { expirationTtl: 86400 });
      }
    }

    // Bedtime nudge — 10pm local
    if (prefs.bedtime && localHour === 22) {
      const firedKey = `fired_${key}_${dateStr}_bedtime`;
      if (!(await env.SUBS.get(firedKey))) {
        notifications.push({
          title: 'Root',
          body:  'Bedtime — have you checked your habits for today?',
          tag:   'bedtime',
        });
        await env.SUBS.put(firedKey, '1', { expirationTtl: 86400 });
      }
    }

    // Morning check-in — user-configured time
    if (prefs.morningCheckin && prefs.morningTime) {
      const [targetH, targetM] = prefs.morningTime.split(':').map(Number);
      // Match the half-hour window that contains the target time
      const windowStart = targetH * 60 + targetM;
      const nowMins     = localHour * 60 + localMin;
      if (nowMins >= windowStart && nowMins < windowStart + 30) {
        const firedKey = `fired_${key}_${dateStr}_morning`;
        if (!(await env.SUBS.get(firedKey))) {
          notifications.push({
            title: 'Root',
            body:  'Good morning. How are your habits shaping up today?',
            tag:   'morning',
          });
          await env.SUBS.put(firedKey, '1', { expirationTtl: 86400 });
        }
      }
    }

    for (const notif of notifications) {
      await sendPush(env, subscription, notif).catch(err => {
        // 410 Gone = subscription expired/unsubscribed — clean up
        if (err?.status === 410) env.SUBS.delete(key);
        else console.error('Push send failed:', err);
      });
    }
  }));
}

// ─── Web Push send (RFC 8291 + VAPID) ────────────────────────────────────────

async function sendPush(env, subscription, payload) {
  const payloadStr = JSON.stringify(payload);
  const encrypted  = await encryptPayload(subscription, payloadStr);

  const vapidHeader = await createVapidHeader(
    env,
    subscription.endpoint,
  );

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Authorization':    vapidHeader,
      'TTL':              '86400',
      'Urgency':          'normal',
    },
    body: encrypted,
  });

  if (!response.ok && response.status !== 201) {
    const err = new Error(`Push failed: ${response.status}`);
    err.status = response.status;
    throw err;
  }
}

// ─── VAPID JWT ────────────────────────────────────────────────────────────────

async function createVapidHeader(env, endpoint) {
  const privateJwk   = JSON.parse(env.VAPID_PRIVATE_JWK);
  const publicKeyB64 = env.VAPID_PUBLIC_KEY;
  const subject      = env.VAPID_SUBJECT || 'mailto:admin@example.com';
  const audience     = new URL(endpoint).origin;
  const exp          = Math.floor(Date.now() / 1000) + 43200;

  const header  = b64url(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(te(JSON.stringify({ aud: audience, exp, sub: subject })));
  const input   = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    'jwk', privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te(input))
  );

  return `vapid t=${input}.${b64url(sig)},k=${publicKeyB64}`;
}

// ─── RFC 8291 payload encryption ─────────────────────────────────────────────

async function encryptPayload(subscription, payloadStr) {
  const plaintext  = te(payloadStr);
  const p256dh     = b64d(subscription.keys.p256dh);
  const authSecret = b64d(subscription.keys.auth);

  // Ephemeral server key pair
  const serverKP = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const serverPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', serverKP.publicKey)
  );

  // ECDH shared secret
  const clientPub = await crypto.subtle.importKey(
    'raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPub }, serverKP.privateKey, 256)
  );

  // RFC 8291 §3.3: derive IKM
  const keyInfo = cat(te('WebPush: info\0'), p256dh, serverPubRaw);
  const ikm     = await hkdf(sharedSecret, authSecret, keyInfo, 32);

  // RFC 8188: random salt → derive CEK + nonce
  const salt  = crypto.getRandomValues(new Uint8Array(16));
  const cek   = await hkdf(ikm, salt, te('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, te('Content-Encoding: nonce\0'), 12);

  // AES-128-GCM encrypt (plaintext padded with \x02 delimiter)
  const padded    = cat(plaintext, new Uint8Array([0x02]));
  const cekKey    = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, padded)
  );

  // RFC 8188 content-encoding header: salt(16) | rs(4 BE) | keyid_len(1) | keyid(65)
  const header = new Uint8Array(16 + 4 + 1 + serverPubRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = serverPubRaw.length;
  header.set(serverPubRaw, 21);

  return cat(header, ciphertext);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function te(s) { return new TextEncoder().encode(s); }

function b64url(buf) {
  let s = '';
  for (const b of buf instanceof Uint8Array ? buf : new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64d(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const raw = atob(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function cat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out   = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function hkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8)
  );
}

async function subKey(endpoint) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', te(endpoint)));
  return Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
