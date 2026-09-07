/**
 * ACAP entry point: a small HTTP server behind the camera's reverse proxy.
 *
 * AXIS OS assigns the port and proxies /local/preflight/<apiPath> to it, so the
 * server binds process.env.HTTP_PORT and registers routes at bare paths. A
 * hardcoded port is the classic cause of a settings page that 500s while the
 * process is plainly running.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    hostsFor,
    mergeOnvif,
    ownNetwork,
    scanHost,
    ScanProgress,
    ScannedCamera,
    scanSubnet,
    summarise,
    ENDPOINTS,
    DISCOVERY_PROBE,
} from './scan';
import { discover } from './onvif';
import { licenceState, redactForTier } from './licence';

const PORT = parseInt(process.env.HTTP_PORT ?? '32554', 10);
const DATA = process.env.PERSISTENT_DATA_PATH ?? path.join(__dirname, '..', 'localdata');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const RESULTS_FILE = path.join(DATA, 'results.json');
const HTML_DIR = path.join(__dirname, '..', 'html');

/**
 * The running package's version.
 *
 * From manifest.json, not package.json: package.conf's OTHERFILES lists only
 * dist, bin and node_modules, so package.json is not in the .eap at all and
 * reading it gave "unknown" on the camera while working perfectly in dev. The
 * manifest is always in the package — the device itself reads it at install.
 */
const VERSION: string = (() => {
    for (const p of ['manifest.json', path.join('..', 'manifest.json')]) {
        try {
            const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
            const v = m?.acapPackageConf?.setup?.version;
            if (v) return String(v);
        } catch {
            /* try the next location */
        }
    }
    return 'unknown';
})();

type Settings = {
    /**
     * Several credential sets, tried in order per camera.
     *
     * One password for a whole fleet is the exception, not the rule: cameras
     * commissioned in different years, by different installers, under different
     * password policies. A single field made every one of those a "credentials
     * refused" row the operator could do nothing about.
     */
    credentials: { user: string; pass: string }[];
    targetOsMajor: number;
    concurrency: number;
    licenceKey: string;
};

const DEFAULTS: Settings = { credentials: [], targetOsMajor: 13, concurrency: 12, licenceKey: '' };

function readSettings(): Settings {
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const s: Settings = { ...DEFAULTS, ...raw };
        // Settings written by 0.1–0.3 held a single user/pass pair.
        if (!Array.isArray(raw.credentials) && raw.user) s.credentials = [{ user: raw.user, pass: raw.pass ?? '' }];
        s.credentials = (s.credentials ?? []).filter((c) => c && c.user);
        return s;
    } catch {
        return { ...DEFAULTS, credentials: [] };
    }
}

function writeSettings(s: Settings) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

let progress: ScanProgress = { done: 0, total: 0, found: 0, running: false };
let results: ScannedCamera[] = [];
let lastScan: string | null = null;

try {
    const saved = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    results = saved.cameras ?? [];
    lastScan = saved.at ?? null;
} catch {
    /* first run */
}

function json(res: http.ServerResponse, status: number, body: unknown) {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => {
            if (b.length < 64 * 1024) b += c;
        });
        req.on('end', () => resolve(b));
    });
}

async function startScan() {
    if (progress.running) return;
    const s = readSettings();
    const net = ownNetwork();
    if (!net) {
        progress = { done: 0, total: 0, found: 0, running: false };
        return;
    }
    // Including this camera. It is a camera on the network like any other, and it
    // is the one the operator is looking at — leaving it out of its own report was
    // just wrong.
    const hosts = hostsFor(net.address, net.netmask);
    progress = { done: 0, total: hosts.length, found: 0, running: true, phase: 'discovering' };

    // Discovery first, and its result is used even if it is empty. It needs no
    // credentials, so it is the only thing that can say anything at all about a
    // camera whose password nobody has any more.
    const onvif = await discover(net.address).catch(() => new Map());

    progress = { ...progress, found: onvif.size, phase: 'scanning' };

    const scanned = await scanSubnet(hosts, s.credentials, s.targetOsMajor, s.concurrency, (p) => {
        progress = { ...p, phase: 'scanning' };
    });
    results = mergeOnvif(scanned, onvif);
    progress = { done: hosts.length, total: hosts.length, found: results.length, running: false, phase: 'done' };
    lastScan = new Date().toISOString();
    try {
        fs.mkdirSync(DATA, { recursive: true });
        fs.writeFileSync(RESULTS_FILE, JSON.stringify({ at: lastScan, cameras: results }), { mode: 0o600 });
    } catch {
        /* a full flash must not lose the in-memory result */
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Route on the LAST path segment, not on a stripped prefix.
    //
    // The camera's Apache appends the whole original request path to the proxy
    // target, so what arrives here depends on the target's own path. A target of
    // http://localhost:32554/status turned a request for /local/preflight/status
    // into /status/local/preflight/status — which matched no prefix rule and got
    // our own 404, indistinguishable from the camera never having routed it. The
    // manifest now uses a bare origin, and this routes on the basename so the app
    // is correct whichever shape arrives.
    // A trailing slash means the directory itself, not the segment before it:
    // /local/preflight/ must serve the page, not look for an endpoint "preflight".
    const route = url.pathname.endsWith('/')
        ? '/'
        : '/' + (url.pathname.split('/').filter(Boolean).pop() ?? '').replace(/\.cgi$/, '');
    const s = readSettings();
    const lic = licenceState(s.licenceKey);

    try {
        if (route === '/status') {
            const net = ownNetwork();
            return json(res, 200, {
                app: 'preflight',
                // From the package that is actually running, not the page's literal.
                version: VERSION,
                network: net,
                progress,
                lastScan,
                licensed: lic.valid,
                licensedTo: lic.valid ? lic.subject : null,
                endpoints: ENDPOINTS,
                // Declared, not hidden: this is the one thing the app sends that
                // is not an HTTP GET. "Read-only" has to cover all of it.
                discoveryProbe: DISCOVERY_PROBE,
            });
        }

        if (route === '/settings') {
            if (req.method === 'POST') {
                const incoming = JSON.parse((await readBody(req)) || '{}');
                const rows: { user?: unknown; pass?: unknown }[] = Array.isArray(incoming.credentials)
                    ? incoming.credentials
                    : [];
                const next: Settings = {
                    // A blank password means "unchanged", matched by username rather
                    // than by row index — rows move when one is removed, and index
                    // matching would quietly reassign passwords to the wrong user.
                    credentials: rows
                        .map((r) => ({ user: String(r.user ?? '').trim(), pass: String(r.pass ?? '') }))
                        .filter((r) => r.user)
                        .map((r) => ({
                            user: r.user,
                            pass: r.pass || s.credentials.find((o) => o.user === r.user)?.pass || '',
                        }))
                        .slice(0, 12),
                    targetOsMajor: Number(incoming.targetOsMajor ?? s.targetOsMajor) || 13,
                    concurrency: Math.min(32, Math.max(1, Number(incoming.concurrency ?? s.concurrency) || 12)),
                    licenceKey: String(incoming.licenceKey ?? s.licenceKey),
                };
                writeSettings(next);
                return json(res, 200, { ok: true });
            }
            // Never return a stored password, only whether one is set.
            return json(res, 200, {
                credentials: s.credentials.map((c) => ({ user: c.user, hasPass: Boolean(c.pass) })),
                targetOsMajor: s.targetOsMajor,
                concurrency: s.concurrency,
                licenceKey: s.licenceKey,
            });
        }

        if (route === '/scan') {
            void startScan();
            return json(res, 202, { started: true, progress });
        }

        /**
         * Re-check one camera with credentials typed for it.
         *
         * A "credentials refused" row is the one failure the operator can
         * actually fix, and making them go back to the settings panel, add a
         * set, save, and re-sweep 254 addresses to test one guess is a poor
         * trade. This checks that camera and nothing else.
         *
         * The host must already be in the results. Otherwise this endpoint is a
         * general-purpose credential prober pointed at any address on the
         * network, which is exactly the reading of this application that its
         * read-only, published-endpoints design exists to refuse.
         */
        if (route === '/recheck') {
            if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
            const body = JSON.parse((await readBody(req)) || '{}');
            const host = String(body.host ?? '');
            const idx = results.findIndex((c) => c.host === host);
            if (idx === -1) return json(res, 400, { error: 'That address is not in the current scan.' });

            const user = String(body.user ?? '').trim();
            if (!user) return json(res, 400, { error: 'A username is needed.' });
            const creds = { user, pass: String(body.pass ?? '') };

            const found = await scanHost(host, [creds], s.targetOsMajor).catch(() => null);
            if (!found) {
                return json(res, 200, { ok: false, reason: 'It stopped answering. Try again.' });
            }
            // Discovery told us the model without credentials; a failed re-check
            // must not throw that away.
            results[idx] = { ...found, onvif: results[idx].onvif ?? null, product: found.product ?? results[idx].product };

            if (body.remember && !s.credentials.some((c) => c.user === creds.user && c.pass === creds.pass)) {
                writeSettings({ ...s, credentials: [...s.credentials, creds].slice(0, 12) });
            }
            try {
                fs.writeFileSync(RESULTS_FILE, JSON.stringify({ at: lastScan, cameras: results }), { mode: 0o600 });
            } catch {
                /* the in-memory result is what the page reads next */
            }
            return json(res, 200, {
                ok: Boolean(results[idx].result),
                reason: results[idx].result ? null : results[idx].note,
            });
        }

        if (route === '/results') {
            return json(res, 200, {
                at: lastScan,
                progress,
                summary: summarise(results),
                licensed: lic.valid,
                cameras: redactForTier(results, lic.valid),
            });
        }

        if (route === '/report') {
            if (!lic.valid) {
                return json(res, 402, {
                    error: 'The detailed report needs a licence key.',
                    summary: summarise(results),
                });
            }
            // Rendered by the same report module the CLI uses.
            const { renderReport } = require('./report');
            const html = renderReport({
                cameras: results.map((c) => ({
                    camera: c.host + (c.product ? ` (${c.product})` : ''),
                    reachable: c.reachable,
                    product: c.product,
                    firmware: c.firmware,
                    architecture: c.architecture,
                    result: c.result,
                })),
                targetOsMajor: s.targetOsMajor,
                rulesetVersion: require('./rules.json').rulesetVersion,
                generated: new Date(),
                sourceUrl: 'https://preflight.4xs.dev',
            });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
        }

        // Static settings UI.
        const file = route === '/' || route === '/index.html' ? 'index.html' : path.basename(route);
        const full = path.join(HTML_DIR, file);
        if (full.startsWith(HTML_DIR) && fs.existsSync(full)) {
            const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
            res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
            return res.end(fs.readFileSync(full));
        }

        return json(res, 404, { error: 'not found', route });
    } catch (err) {
        return json(res, 500, { error: (err as Error).message });
    }
});

server.listen(PORT, () => console.log(`preflight: listening on ${PORT}, data in ${DATA}`));

// runMode=respawn restarts us; exit cleanly so a settings save is not a crash.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
