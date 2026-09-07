#!/usr/bin/env node
/**
 * Create the Ed25519 licence signing key.
 *
 * Node rather than openssl, because macOS ships LibreSSL, whose `genpkey` has no
 * ed25519 algorithm — the openssl one-liner fails with "Algorithm ed25519 not
 * found" on a stock Mac. Node's crypto has supported it since 12.
 *
 *   node tools/make-signing-key.mjs
 *
 * Writes the private key to ~/.preflight/signing.pem (0600) and the public half to
 * acap/app/src/licence-key.pub, which IS committed — it verifies, it cannot sign.
 *
 * Refuses to overwrite an existing private key. Replacing it invalidates every
 * licence already issued.
 */

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIV_DIR = join(homedir(), '.preflight');
const PRIV = join(PRIV_DIR, 'signing.pem');
const PUB = join(REPO, 'acap/app/src/licence-key.pub');

if (existsSync(PRIV)) {
    console.error(`A signing key already exists at ${PRIV}.`);
    console.error('Refusing to overwrite it: a new key invalidates every licence already issued.');
    console.error('Delete it deliberately if that is really what you want.');
    process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

mkdirSync(PRIV_DIR, { recursive: true });
chmodSync(PRIV_DIR, 0o700);
writeFileSync(PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

mkdirSync(dirname(PUB), { recursive: true });
writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }));

console.log(`Private key  ${PRIV}   (0600 — back this up where you keep passwords)`);
console.log(`Public key   ${PUB}   (safe to commit)`);
console.log('\nLose the private key and every issued licence stops verifying: new public key,');
console.log('new ACAP build, every customer re-keyed. Back it up now, not later.');
