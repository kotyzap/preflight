/**
 * Minimal VAPIX client for talking to *other* cameras on the network.
 *
 * Deliberately dependency-free — the .eap already bundles a Node runtime and
 * every megabyte lands on camera flash, so this uses only node:http/https.
 *
 * Authentication is negotiated, never assumed. The bench on 2026-09-06 found
 * both an AXIS OS 12.11 and a 10.12 camera refusing digest (401) and accepting
 * basic over HTTPS (200) — an earlier version of the probe hardcoded digest and
 * reported every rule as a false negative. So: try basic, then digest, and
 * remember which worked per host.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';

export type Credentials = { user: string; pass: string };

export type FetchResult = { status: number; body: string };

/** Cameras ship self-signed certificates; refusing them would refuse every camera. */
const AGENT = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

function request(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number
): Promise<FetchResult & { headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(
            {
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                method: 'GET',
                headers,
                agent: u.protocol === 'https:' ? AGENT : undefined,
                timeout: timeoutMs,
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => {
                    // A camera answering with a huge body is a camera we do not
                    // want to buffer: nothing we read is larger than this.
                    if (body.length < 512 * 1024) body += c;
                });
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
            }
        );
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });
}

function basicHeader(c: Credentials): string {
    return 'Basic ' + Buffer.from(`${c.user}:${c.pass}`).toString('base64');
}

/**
 * RFC 7616 digest, honouring the `algorithm` directive.
 *
 * Modern AXIS OS challenges with MD5 **or SHA-256**; an MD5-only client gets a
 * silent 401 that looks exactly like a wrong password.
 */
function digestHeader(c: Credentials, challenge: string, method: string, uri: string): string | null {
    const parts: Record<string, string> = {};
    for (const m of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
        parts[m[1].toLowerCase()] = m[2] ?? m[3];
    }
    if (!parts.realm || !parts.nonce) return null;

    const algo = (parts.algorithm ?? 'MD5').toUpperCase();
    const hash = (s: string) => createHash(algo.startsWith('SHA-256') ? 'sha256' : 'md5').update(s).digest('hex');

    const cnonce = randomBytes(8).toString('hex');
    const nc = '00000001';
    const ha1 = hash(`${c.user}:${parts.realm}:${c.pass}`);
    const ha2 = hash(`${method}:${uri}`);
    const qop = parts.qop?.split(',')[0].trim();
    const response = qop
        ? hash(`${ha1}:${parts.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        : hash(`${ha1}:${parts.nonce}:${ha2}`);

    let h =
        `Digest username="${c.user}", realm="${parts.realm}", nonce="${parts.nonce}", ` +
        `uri="${uri}", response="${response}", algorithm=${parts.algorithm ?? 'MD5'}`;
    if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    if (parts.opaque) h += `, opaque="${parts.opaque}"`;
    return h;
}

export type AuthMode = 'none' | 'basic' | 'digest';

/** What worked for a host last time, so the whole scan does not re-negotiate. */
const authCache = new Map<string, AuthMode>();

/**
 * GET a VAPIX path, negotiating authentication.
 *
 * Returns status 0 for a host that did not answer at all, which the sweep reads
 * as "not a camera here" rather than as an error worth reporting.
 */
export async function vapixGet(
    origin: string,
    path: string,
    creds: Credentials | null,
    timeoutMs = 4000
): Promise<FetchResult> {
    const url = origin + path;
    const cached = authCache.get(origin);

    const attempt = async (mode: AuthMode): Promise<FetchResult & { headers?: http.IncomingHttpHeaders }> => {
        const headers: Record<string, string> = { Accept: '*/*', Connection: 'close' };
        if (mode === 'basic' && creds) headers.Authorization = basicHeader(creds);
        return request(url, headers, timeoutMs);
    };

    try {
        // Unauthenticated first when we have no credentials, or when that is what
        // worked before. basicdeviceinfo.cgi answers without auth on much firmware.
        const first = await attempt(cached && cached !== 'none' ? cached : 'none');
        if (first.status !== 401 || !creds) return { status: first.status, body: first.body };

        const basic = await attempt('basic');
        if (basic.status !== 401) {
            authCache.set(origin, 'basic');
            return { status: basic.status, body: basic.body };
        }

        const challenge = String(basic.headers?.['www-authenticate'] ?? '');
        if (/digest/i.test(challenge)) {
            const h = digestHeader(creds, challenge, 'GET', new URL(url).pathname + new URL(url).search);
            if (h) {
                const dig = await request(url, { Authorization: h, Accept: '*/*', Connection: 'close' }, timeoutMs);
                if (dig.status !== 401) authCache.set(origin, 'digest');
                return { status: dig.status, body: dig.body };
            }
        }
        return { status: 401, body: '' };
    } catch {
        return { status: 0, body: '' };
    }
}

/** Parse `root.Group.Key=value` lines into a case-insensitive lookup. */
export function parseParams(body: string) {
    const map = new Map<string, string>();
    for (const line of body.split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i < 1) continue;
        map.set(line.slice(0, i).replace(/^root\./i, '').toLowerCase(), line.slice(i + 1));
    }
    return {
        get(name: string) {
            return map.get(name.replace(/^root\./i, '').toLowerCase());
        },
        size: map.size,
    };
}
