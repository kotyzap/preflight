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
 * NOT YET IMPLEMENTED: real signature verification. verifyKey() below is a
 * placeholder that recognises the key format and nothing more. It must not ship
 * as-is, and it is written to fail closed — an unrecognised key is unlicensed.
 */

import { createVerify } from 'node:crypto';
import { ScannedCamera } from './scan';

/**
 * Ed25519/RSA public key that signs licence keys. Replaced at build time with the
 * real one; empty means signature checking is not yet wired, which forces the
 * placeholder path below.
 */
const LICENCE_PUBLIC_KEY = '';

export type Licence = { valid: boolean; subject: string | null; reason: string };

/**
 * A key looks like:  PF1-<base64url payload>-<base64url signature>
 * where payload is JSON: { subject, serials?: string[], expires?: ISO date }
 */
export function verifyKey(key: string): Licence {
    const k = (key ?? '').trim();
    if (!k) return { valid: false, subject: null, reason: 'no key' };

    const m = /^PF1-([A-Za-z0-9_-]+)-([A-Za-z0-9_-]+)$/.exec(k);
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

    if (!LICENCE_PUBLIC_KEY) {
        // Fail closed. A build without a public key cannot verify anything, and
        // treating that as "licensed" would ship the paid tier to everyone.
        return { valid: false, subject: payload.subject ?? null, reason: 'signature checking not configured' };
    }

    try {
        const v = createVerify('SHA256');
        v.update(m[1]);
        v.end();
        const ok = v.verify(LICENCE_PUBLIC_KEY, Buffer.from(m[2], 'base64url'));
        return ok
            ? { valid: true, subject: payload.subject ?? null, reason: 'ok' }
            : { valid: false, subject: payload.subject ?? null, reason: 'signature does not match' };
    } catch {
        return { valid: false, subject: null, reason: 'signature check failed' };
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
