// scripts/generate-apple-secret.mjs
//
// Mints APPLE_CLIENT_SECRET.
//
// Apple is the one provider whose "secret" is not a string you copy out of a
// dashboard: it wants a JWT signed with the ES256 private key from your
// developer account, and it expires after at most 6 months. So this is a
// recurring ops chore, not one-time setup — put a reminder in the calendar for
// whatever expiry you pick.
//
// Usage:
//   node scripts/generate-apple-secret.mjs \
//     --team-id ABCDE12345 \
//     --key-id XYZ9876543 \
//     --client-id com.example.imposter.web \
//     --key ./AuthKey_XYZ9876543.p8 \
//     [--months 6]
//
// Where to find each value in the Apple Developer portal:
//   team-id    Membership → Team ID.
//   key-id     Certificates, Identifiers & Profiles → Keys → the key you made
//              with "Sign in with Apple" enabled.
//   key        The .p8 file that key downloads exactly once. Keep it out of
//              git — only the generated JWT belongs in .env.
//   client-id  Identifiers → your *Services ID* (e.g. com.example.imposter.web),
//              NOT the App ID. This is also APPLE_CLIENT_ID.
//
// No dependencies: node's crypto signs ES256 directly, given the raw r||s
// encoding JWS requires rather than the DER wrapper OpenSSL defaults to.

import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MAX_MONTHS = 6; // Apple's hard ceiling.

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fail(message) {
  console.error(`✖ ${message}`);
  console.error('\nRun with --help to see the required flags.');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n')
    .filter((line) => line.startsWith('//'))
    .map((line) => line.replace(/^\/\/ ?/, ''))
    .join('\n'));
  process.exit(0);
}

const teamId = args['team-id'] ?? process.env.APPLE_TEAM_ID;
const keyId = args['key-id'] ?? process.env.APPLE_KEY_ID;
const clientId = args['client-id'] ?? process.env.APPLE_CLIENT_ID;
const keyPath = args.key ?? process.env.APPLE_PRIVATE_KEY_PATH;
const months = Number(args.months ?? MAX_MONTHS);

if (!teamId) fail('Missing --team-id (Apple Developer → Membership → Team ID).');
if (!keyId) fail('Missing --key-id (the id of your Sign in with Apple key).');
if (!clientId) fail('Missing --client-id (your Services ID, not the App ID).');
if (!keyPath) fail('Missing --key (path to the AuthKey_*.p8 file).');
if (!Number.isFinite(months) || months < 1 || months > MAX_MONTHS) {
  fail(`--months must be between 1 and ${MAX_MONTHS}; Apple rejects anything longer.`);
}

let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
} catch (error) {
  fail(`Could not read a private key from ${keyPath}: ${error.message}`);
}

if (privateKey.asymmetricKeyType !== 'ec') {
  fail(`${keyPath} is not an EC key — Apple's .p8 keys are P-256. Check you grabbed the right file.`);
}

const now = Math.floor(Date.now() / 1000);
const exp = now + Math.round(months * 30 * 24 * 60 * 60);

const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
const payload = {
  iss: teamId,
  iat: now,
  exp,
  aud: 'https://appleid.apple.com',
  sub: clientId,
};

const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

// JWS wants the signature as raw r||s. Node calls that encoding ieee-p1363;
// the default (der) produces a token Apple silently rejects as invalid_client.
const signature = cryptoSign('sha256', Buffer.from(signingInput), {
  key: privateKey,
  dsaEncoding: 'ieee-p1363',
});

const token = `${signingInput}.${base64url(signature)}`;

console.log('\nAdd these two lines to .env (and to your host\'s env vars):\n');
console.log(`APPLE_CLIENT_ID=${clientId}`);
console.log(`APPLE_CLIENT_SECRET=${token}`);
console.log(`\nExpires ${new Date(exp * 1000).toISOString()} — regenerate before then or Apple sign-in starts failing with invalid_client.\n`);
