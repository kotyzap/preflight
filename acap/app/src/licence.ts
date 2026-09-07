/**
 * Licence gate.
 *
 * Two decisions are encoded here, and both are business decisions rather than
 * technical ones, so they live in one small file that is easy to find and change.
 *
 * 1. WHAT IS PAID. The free tier answers the safety question — how many cameras
 *    roll back — and the licence names the applications and unlocks the report.
 *    The reasoning: the CLI is public and does everything, so gating *information*
 *    only inconveniences the buyer who would not have cloned a repo anyway. What
 *    is worth money is the deliverable an integrator bills for, and not having to
 *    set anything up. See FREE_TIER below to change the line.
 *
 * 2. HOW A KEY IS VERIFIED. Offline, by signature. Cameras routinely live on
 *    networks with no route to the internet — often exactly the VMS networks this
 *    is sold into — so a key that phones home would fail for the best customers.
 *    A key is a signed statement about a device, checked locally against a public
 *    key compiled into the app.
 *
 * Verification is Ed25519 via node:crypto — short keys, and node's `verify(null, …)`
 * form rather than createVerify('SHA256'), which does not support Ed25519 at all.
 */

import { verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScannedCamera } from './scan';

/**
 * The public half of the signing key, read from a file beside the compiled code.
 *
 * A file rather than a string constant so the build does not have to rewrite
 * source, and because a public key in git is harmless — it verifies, it cannot
 * sign. The private half lives on the maintainer's machine and nowhere else; see
 * tools/README.md.
 */
function publicKey(): string | null {
    for (const p of [join(__dirname, 'licence-key.pub'), join(__dirname, '..', 'licence-key.pub')]) {
        if (!existsSync(p)) continue;
        const text = readFileSync(p, 'utf8').trim();
        // A failed `openssl pkey` leaves a zero-byte file behind, and existsSync
        // says yes to it. An empty or non-PEM file is no key at all: report that
        // rather than letting verify() throw and blame the customer's key.
        if (text.includes('BEGIN PUBLIC KEY')) return text;
    }
    return null;
}

export type Licence = { valid: boolean; subject: string | null; reason: string };

/**
 * A key looks like:  PF1.<base64url payload>.<base64url signature>
 * where payload is JSON: { subject, serials?: string[], expires?: ISO date }
 *
 * Dot-separated, not hyphen-separated. base64url's alphabet includes `-`, so a
 * hyphen separator is ambiguous: a greedy match splits at the last hyphen in the
 * signature and the payload parses as garbage. A valid key read as "malformed"
 * — found by testing a real signed key rather than a hand-written one.
 */
export function verifyKey(key: string): Licence {
    const k = (key ?? '').trim();
    if (!k) return { valid: false, subject: null, reason: 'no key' };

    const m = /^PF1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(k);
    if (!m) return { valid: false, subject: null, reason: 'not a Preflight licence key' };

    let payload: { subject?: string; expires?: string };
    try {
        payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    } catch {
        return { valid: false, subject: null, reason: 'malformed key' };
    }

    if (payload.expires && new Date(payload.expires) < new Date()) {
        return { valid: false, subject: payload.subject ?? null, reason: 'licence expired' };
    }

    const pub = publicKey();
    if (!pub) {
        // Fail closed. A build with no public key cannot verify anything, and
        // treating that as "licensed" would ship the paid tier to everyone.
        return { valid: false, subject: payload.subject ?? null, reason: 'this build cannot verify licences' };
    }

    try {
        const ok = verify(null, Buffer.from(m[1]), pub, Buffer.from(m[2], 'base64url'));
        return ok
            ? { valid: true, subject: payload.subject ?? null, reason: 'ok' }
            : { valid: false, subject: payload.subject ?? null, reason: 'signature does not match' };
    } catch {
        return { valid: false, subject: null, reason: 'signature check failed' };
    }
}

/**
 * Is this key bound to this camera?
 *
 * A key with no `serials` works anywhere, which is what a site licence should do.
 * A key that names serials only works on those cameras, so it cannot be passed
 * between fleets. Checked against the camera the ACAP runs on.
 */
export function boundToDevice(key: string, ownSerial: string | null): boolean {
    const m = /^PF1\.([A-Za-z0-9_-]+)\./.exec((key ?? '').trim());
    if (!m) return false;
    try {
        const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
        if (!Array.isArray(p.serials) || p.serials.length === 0) return true;
        return ownSerial ? p.serials.some((s: string) => s.toUpperCase() === ownSerial.toUpperCase()) : false;
    } catch {
        return false;
    }
}

export function licenceState(key: string): Licence {
    return verifyKey(key);
}

/**
 * What the free tier shows.
 *
 * Verdicts and counts, yes — the safety answer is never withheld, and the public
 * page promises exactly that. Application names and the per-rule detail are the
 * work list, and that is what the licence unlocks.
 */
export const FREE_TIER = {
    verdicts: true,
    counts: true,
    applicationNames: false,
    findingDetail: false,
    report: false,
};

/**
 * Strip what the current tier is not entitled to, without lying about totals.
 *
 * IMPORTANT: compute every summary from the UNREDACTED results and redact only
 * what is sent. Redaction removes the per-application findings, so a count taken
 * afterwards reports zero applications to fix while the same response tells the
 * reader two of them will roll the camera back. bootstrap.ts summarises first for
 * exactly this reason; anything that recomputes totals from the redacted copy is
 * a bug, and a dishonest one.
 */
export function redactForTier(cams: ScannedCamera[], licensed: boolean): ScannedCamera[] {
    if (licensed) return cams;

    return cams.map((c) => {
        if (!c.result) return c;
        const blockingApps = new Set(
            c.result.findings.filter((f) => f.application && f.severity === 'blocking').map((f) => f.application)
        );
        return {
            ...c,
            result: {
                ...c.result,
                // Counts stay honest; the reader still learns this camera rolls back
                // and how many applications are responsible. Which ones is the paid part.
                findings: blockingApps.size
                    ? [
                          {
                              rule: 'A2',
                              severity: 'blocking' as const,
                              message:
                                  `${blockingApps.size} installed application${blockingApps.size === 1 ? '' : 's'} ` +
                                  'will fail re-installation and roll this camera back. Add a licence key to see ' +
                                  'which, and what to do about each.',
                          },
                          ...c.result.findings.filter((f) => !f.application),
                      ]
                    : c.result.findings.filter((f) => !f.application),
            },
        };
    });
}
