/**
 * Run once to generate VAPID keys:
 *   node worker/generate-keys.mjs
 *
 * Then:
 *   1. Copy VAPID_PUBLIC_KEY into app.js (the VAPID_PUBLIC_KEY constant)
 *   2. Run:  wrangler secret put VAPID_PRIVATE_JWK
 *      and paste the VAPID_PRIVATE_JWK value when prompted
 */

import { webcrypto } from 'node:crypto';
const { subtle, getRandomValues } = webcrypto;

const keyPair = await subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);

const privateJwk = await subtle.exportKey('jwk', keyPair.privateKey);
const publicRaw  = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

console.log('\n=== VAPID Keys ===\n');
console.log('VAPID_PUBLIC_KEY (paste into app.js):');
console.log(b64url(publicRaw));
console.log('\nVAPID_PRIVATE_JWK (run: wrangler secret put VAPID_PRIVATE_JWK):');
console.log(JSON.stringify(privateJwk));
console.log('\nVAPID_SUBJECT (edit to match your contact email):');
console.log('mailto:admin@example.com');
