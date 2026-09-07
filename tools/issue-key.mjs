#!/usr/bin/env node
/**
 * Issue a Preflight licence key.
 *
 * Keys are signed offline and verified offline. Cameras frequently sit on networks
 * with no route to the internet — often exactly the VMS networks this is sold into
 * — so a key that phoned home would fail for the best customers.
 *
 *   PREFLIGHT_SIGNING_KEY=~/.preflight/signing.pem \
 *     node tools/issue-key.mjs --subject "Acme Security" --expires 2027-12-31
 *
 *   # bind to specific cameras, so a key cannot be shared across fleets
 *   ... --serials B8A44F1234AB,B8A44F5678CD
 *
 * The private key never belongs in this repo. .gitignore covers *.pem as a
 * backstop, but keep it somewhere you would keep a password.
 */

import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const arg = (name) => {
    const i = argv.indexOf('--' + name);
    return i > -1 ? argv[i + 1] : undefined;
};

const subject = arg('subject');
if (!subject) {
    console.error('Usage: node tools/issue-key.mjs --subject "<customer>" [--expires YYYY-MM-DD] [--serials A,B]');
    console.error('       PREFLIGHT_SIGNING_KEY must point at the private key.');
    process.exit(1);
}

const keyPath = (process.env.PREFLIGHT_SIGNING_KEY ?? '').replace(/^~/, homedir());
if (!keyPath) {
    console.error('PREFLIGHT_SIGNING_KEY is not set. It must point at the Ed25519 private key.');
    process.exit(1);
}

let privateKey;
try {
    privateKey = readFileSync(keyPath, 'utf8');
} catch (err) {
    console.error(`Cannot read the signing key at ${keyPath}: ${err.message}`);
    process.exit(1);
}

const expires = arg('expires');
if (expires && Number.isNaN(Date.parse(expires))) {
    console.error(`--expires "${expires}" is not a date. Use YYYY-MM-DD.`);
    process.exit(1);
}

const payload = {
    subject,
    ...(expires ? { expires: new Date(expires + 'T23:59:59Z').toISOString() } : {}),
    ...(arg('serials') ? { serials: arg('serials').split(',').map((x) => x.trim()).filter(Boolean) } : {}),
    issued: new Date().toISOString().slice(0, 10),
};

const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
const signature = sign(null, Buffer.from(encoded), privateKey).toString('base64url');
// Dots, not hyphens: base64url contains '-', which makes a hyphen separator ambiguous.
const key = `PF1.${encoded}.${signature}`;

console.log(`\nLicence for: ${subject}`);
if (payload.expires) console.log(`Expires:     ${payload.expires.slice(0, 10)}`);
if (payload.serials) console.log(`Bound to:    ${payload.serials.join(', ')}`);
console.log(`\n${key}\n`);
console.log(`${key.length} characters. Paste it into the ACAP's Licence key field.`);
