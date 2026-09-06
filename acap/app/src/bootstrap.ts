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
import { hostsFor, ownNetwork, ScanProgress, ScannedCamera, scanSubnet, summarise, ENDPOINTS } from './scan';
import { licenceState, redactForTier } from './licence';

const PORT = parseInt(process.env.HTTP_PORT ?? '32554', 10);
const DATA = process.env.PERSISTENT_DATA_PATH ?? path.join(__dirname, '..', 'localdata');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const RESULTS_FILE = path.join(DATA, 'results.json');
const HTML_DIR = path.join(__dirname, '..', 'html');

type Settings = {
    user: string;
    pass: string;
    targetOsMajor: number;
    concurrency: number;
    licenceKey: string;
};

const DEFAULTS: Settings = { user: '', pass: '', targetOsMajor: 13, concurrency: 12, licenceKey: '' };

function readSettings(): Settings {
    try {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    } catch {
        return { ...DEFAULTS };
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
    const hosts = hostsFor(net.address, net.netmask);
    progress = { done: 0, total: hosts.length, found: 0, running: true };

    const creds = s.user ? { user: s.user, pass: s.pass } : null;
    results = await scanSubnet(hosts, creds, s.targetOsMajor, s.concurrency, (p) => {
        progress = p;
    });
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
    const route = url.pathname.replace(/^\/local\/preflight\//, '/').replace(/^\/+/, '/');
    const s = readSettings();
    const lic = licenceState(s.licenceKey);

    try {
        if (route === '/status.cgi') {
            const net = ownNetwork();
            return json(res, 200, {
                app: 'preflight',
                network: net,
                progress,
                lastScan,
                licensed: lic.valid,
                licensedTo: lic.valid ? lic.subject : null,
                endpoints: ENDPOINTS,
            });
        }

        if (route === '/settings.cgi') {
            if (req.method === 'POST') {
                const incoming = JSON.parse((await readBody(req)) || '{}');
                const next: Settings = {
                    user: String(incoming.user ?? s.user),
                    // An empty password field means "unchanged", so saving other
                    // settings does not silently wipe stored credentials.
                    pass: incoming.pass ? String(incoming.pass) : s.pass,
                    targetOsMajor: Number(incoming.targetOsMajor ?? s.targetOsMajor) || 13,
                    concurrency: Math.min(32, Math.max(1, Number(incoming.concurrency ?? s.concurrency) || 12)),
                    licenceKey: String(incoming.licenceKey ?? s.licenceKey),
                };
                writeSettings(next);
                return json(res, 200, { ok: true });
            }
            // Never return the stored password, only whether one is set.
            return json(res, 200, {
                user: s.user,
                hasPass: Boolean(s.pass),
                targetOsMajor: s.targetOsMajor,
                concurrency: s.concurrency,
                licenceKey: s.licenceKey,
            });
        }

        if (route === '/scan.cgi') {
            void startScan();
            return json(res, 202, { started: true, progress });
        }

        if (route === '/results.cgi') {
            return json(res, 200, {
                at: lastScan,
                progress,
                summary: summarise(results),
                licensed: lic.valid,
                cameras: redactForTier(results, lic.valid),
            });
        }

        if (route === '/report.cgi') {
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
