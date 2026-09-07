/**
 * Subnet scan.
 *
 * Runs on one camera and probes the rest of that camera's /24. Read-only
 * throughout: it lists applications and reads parameters, which is what any Axis
 * management tool does. Nothing is written to any device.
 *
 * An application that installs on one camera and probes the others is,
 * structurally, lateral movement, and a security team will read it that way.
 * Three properties are therefore load-bearing and must not be quietly relaxed:
 * every camera request is a GET, the endpoint list below is the complete set of
 * paths this app will ever touch, and the source is public so that claim is
 * checkable. The one non-GET is the ONVIF discovery probe in onvif.ts — a single
 * UDP multicast datagram asking devices to describe themselves — and it is
 * declared next to the endpoints rather than tucked away.
 */

import * as os from 'node:os';
import { evaluate, Finding, PreflightResult } from './engine';
import { Credentials, parseParams, vapixGet } from './vapix';
import { DISCOVERY, OnvifDevice } from './onvif';

/** The complete set of VAPIX paths this application requests. All GET, all read-only. */
export const ENDPOINTS = [
    '/axis-cgi/param.cgi?action=list&group=Brand,Properties',
    '/axis-cgi/param.cgi?action=list&group=System.BoaGroupPolicy,Network.HTTP,Network.UPnP,Image',
    '/axis-cgi/applications/list.cgi',
] as const;

/** The non-HTTP thing this application does, declared alongside the endpoints. */
export const DISCOVERY_PROBE = {
    ...DISCOVERY,
    what: 'ONVIF WS-Discovery Probe — asks devices to state their model. No credentials, no change.',
} as const;

export type ScannedCamera = {
    host: string;
    reachable: boolean;
    product: string | null;
    firmware: string | null;
    architecture: string | null;
    serial: string | null;
    result: PreflightResult | null;
    /** Why the application list is missing, when it is. */
    note?: string;
    /** Model and name learned from ONVIF discovery, which needs no credentials. */
    onvif?: { hardware: string | null; name: string | null } | null;
};

export type ScanProgress = {
    done: number;
    total: number;
    found: number;
    running: boolean;
    /** Which stage the operator is watching, so the progress text can say so. */
    phase?: 'discovering' | 'scanning' | 'done';
};

/**
 * The camera's own IPv4 network, read from the OS rather than over VAPIX.
 *
 * The app runs on the camera, so the interface list is right there — no
 * credentials, no round-trip, and it cannot be wrong about its own address.
 */
export function ownNetwork(): { address: string; netmask: string } | null {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        if (/^(lo|docker|veth)/.test(name)) continue;
        for (const a of addrs ?? []) {
            if (a.family === 'IPv4' && !a.internal) return { address: a.address, netmask: a.netmask };
        }
    }
    return null;
}

/**
 * Hosts to probe.
 *
 * Deliberately capped at a /24. A camera is not the right place to sweep a /16,
 * and an app that tries would look far more like a network scanner than a
 * compatibility check.
 */
export function hostsFor(address: string, netmask: string): string[] {
    const oct = address.split('.').map(Number);
    const mask = netmask.split('.').map(Number);
    if (oct.length !== 4 || mask.some((m) => Number.isNaN(m))) return [];

    const bits = mask.reduce((n, b) => n + (b >>> 0).toString(2).split('1').length - 1, 0);
    if (bits < 24) {
        // Wider than a /24: scan only the local /24 around this camera.
        // This camera is included: it is a camera on the network like any other,
        // and it is the one whose report the operator is reading.
        return Array.from({ length: 254 }, (_, i) => `${oct[0]}.${oct[1]}.${oct[2]}.${i + 1}`);
    }
    const size = 2 ** (32 - bits);
    const base = ((oct[0] << 24) | (oct[1] << 16) | (oct[2] << 8) | oct[3]) >>> 0;
    const net = (base & (0xffffffff << (32 - bits))) >>> 0;
    const out: string[] = [];
    for (let i = 1; i < size - 1; i++) {
        const n = (net + i) >>> 0;
        out.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
    }
    return out;
}

/** Pull the application list out of list.cgi without an XML dependency. */
export function parseApplications(xml: string) {
    const apps: {
        name: string;
        niceName: string | null;
        version: string | null;
        signatureStatus: string | null;
        compatibleOsVersions: { min: string | null; max: string | null }[] | null;
        resources: { name: string; used: boolean | null }[] | null;
    }[] = [];

    // Each <application …> … </application>, or the self-closing form that AXIS
    // OS 10 emits. Both appear in the wild; the 10.12 bench camera used the latter.
    for (const m of xml.matchAll(/<application\b([^>]*?)(\/>|>([\s\S]*?)<\/application>)/g)) {
        const attrs = m[1];
        const inner = m[3] ?? '';
        const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`, 'i').exec(attrs)?.[1] ?? null;
        const name = attr('Name');
        if (!name) continue;

        const ranges = [...inner.matchAll(/<VersionRange>([\s\S]*?)<\/VersionRange>/g)]
            .map((r) => ({
                min: /<Min>([^<]*)<\/Min>/.exec(r[1])?.[1] ?? null,
                max: /<Max>([^<]*)<\/Max>/.exec(r[1])?.[1] ?? null,
            }))
            .filter((r) => r.min !== null || r.max !== null);

        const resources = [...inner.matchAll(/<Resource\b([^>]*)\/?>/g)]
            .map((r) => ({
                name: /\bname="([^"]*)"/i.exec(r[1])?.[1] ?? '',
                used: /\bused="(yes|true)"/i.test(r[1]) ? true : /\bused="(no|false)"/i.test(r[1]) ? false : null,
            }))
            .filter((r) => r.name !== '');

        apps.push({
            name,
            niceName: attr('NiceName'),
            version: attr('Version'),
            // Prose docs call it SignatureStatus, the XSD calls it SignedStatus.
            signatureStatus: attr('SignatureStatus') ?? attr('SignedStatus'),
            compatibleOsVersions: ranges.length ? ranges : null,
            resources: resources.length ? resources : null,
        });
    }
    return apps;
}

async function scanHost(
    host: string,
    credentials: Credentials[],
    targetOsMajor: number
): Promise<ScannedCamera | null> {
    // HTTPS first — from AXIS OS 13 port 80 is off by factory default — then HTTP
    // for the older cameras, which are the ones most likely to be at risk.
    for (const origin of [`https://${host}`, `http://${host}`]) {
        // Try each credential set until one is accepted. Fleets are commissioned
        // over years by different people under different password policies, so one
        // password for every camera is the exception. `null` goes first because
        // some paths answer unauthenticated, and trying it costs one request.
        let brand: { status: number; body: string } | null = null;
        let creds: Credentials | null = null;
        for (const candidate of [null, ...credentials]) {
            const r = await vapixGet(origin, ENDPOINTS[0], candidate, 3000);
            if (r.status === 0) break; // nothing is listening; the next origin may be
            brand = r;
            creds = candidate;
            if (r.status !== 401) break;
        }
        if (!brand || brand.status === 0) continue;
        if (brand.status === 401) {
            return {
                host,
                reachable: true,
                product: null,
                firmware: null,
                architecture: null,
                serial: null,
                result: null,
                note:
                    credentials.length === 0
                        ? 'Responded, but no credentials were configured for it.'
                        : `Responded, but none of the ${credentials.length} configured credential sets were accepted.`,
            };
        }
        if (brand.status !== 200 || !/=/.test(brand.body)) continue;

        const p = parseParams(brand.body);
        // Something answered param.cgi that is not an Axis device.
        if (!p.get('Brand.Brand') && !p.get('Brand.ProdNbr')) continue;

        const extra = await vapixGet(origin, ENDPOINTS[1], creds, 3000);
        const merged = parseParams(brand.body + '\n' + (extra.status === 200 ? extra.body : ''));

        let apps = null;
        let note: string | undefined;
        const list = await vapixGet(origin, ENDPOINTS[2], creds, 5000);
        if (list.status === 200 && /<reply/i.test(list.body)) {
            apps = parseApplications(list.body);
        } else {
            note =
                list.status === 401
                    ? 'The application list needs an Administrator account; this one could not read it.'
                    : 'This device did not return an application list.';
        }

        return {
            host,
            reachable: true,
            product: p.get('Brand.ProdNbr') ?? p.get('Brand.ProdFullName') ?? null,
            firmware: p.get('Properties.Firmware.Version') ?? null,
            architecture: p.get('Properties.System.Architecture') ?? null,
            serial: p.get('Properties.System.SerialNumber') ?? null,
            result: evaluate({
                targetOsMajor,
                firmware: { raw: p.get('Properties.Firmware.Version') ?? null },
                architecture: p.get('Properties.System.Architecture') ?? null,
                productNumber: p.get('Brand.ProdNbr') ?? null,
                apps,
                appsUnavailableReason: note,
                params: merged,
            }),
            note,
        };
    }
    return null;
}

/**
 * Sweep the subnet.
 *
 * Concurrency is deliberately modest: this runs on a camera whose CPU is also
 * encoding video, and a scan that degrades the stream is a scan nobody runs twice.
 */
export async function scanSubnet(
    hosts: string[],
    credentials: Credentials[],
    targetOsMajor: number,
    concurrency: number,
    onProgress: (p: ScanProgress) => void
): Promise<ScannedCamera[]> {
    const found: ScannedCamera[] = [];
    let done = 0;
    let i = 0;

    const worker = async () => {
        for (;;) {
            const idx = i++;
            if (idx >= hosts.length) return;
            const cam = await scanHost(hosts[idx], credentials, targetOsMajor).catch(() => null);
            if (cam) found.push(cam);
            done++;
            if (done % 8 === 0 || done === hosts.length) {
                onProgress({ done, total: hosts.length, found: found.length, running: done < hosts.length });
            }
        }
    };

    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    found.sort((a, b) => {
        const na = a.host.split('.').map(Number);
        const nb = b.host.split('.').map(Number);
        return na[3] - nb[3] || na[2] - nb[2] || na[1] - nb[1] || na[0] - nb[0];
    });
    onProgress({ done: hosts.length, total: hosts.length, found: found.length, running: false });
    return found;
}

/**
 * Fold discovery results into the scan.
 *
 * Two jobs, and the second is the one that makes discovery worth having:
 *
 * 1. Enrich. A camera that refused every credential has no model, and an address
 *    on its own is not an inventory row. Discovery supplies the model without
 *    credentials, so it becomes "M3085-V, could not be checked".
 * 2. Add. A device that answered discovery but not the HTTP sweep still exists —
 *    port 80 and 443 closed, HTTPS-only on a non-standard port, a firewall. It
 *    was previously invisible. Silently omitting a camera is the worst thing this
 *    application can do, so it is listed, unchecked and clearly labelled.
 *
 * A discovered model is never treated as a check: `result` stays null and the
 * verdict stays unknown. Absence of evidence is not a pass.
 */
export function mergeOnvif(cams: ScannedCamera[], onvif: Map<string, OnvifDevice>): ScannedCamera[] {
    const out = cams.map((c) => {
        const d = onvif.get(c.host);
        if (!d) return c;
        return {
            ...c,
            product: c.product ?? d.hardware ?? d.name ?? null,
            onvif: { hardware: d.hardware, name: d.name },
        };
    });

    const seen = new Set(cams.map((c) => c.host));
    for (const [host, d] of onvif) {
        if (seen.has(host)) continue;
        out.push({
            host,
            reachable: true,
            product: d.hardware ?? d.name ?? null,
            firmware: null,
            architecture: null,
            serial: null,
            result: null,
            onvif: { hardware: d.hardware, name: d.name },
            note: 'Found by ONVIF discovery but it did not answer on HTTP or HTTPS, so nothing could be checked.',
        });
    }

    out.sort((a, b) => {
        const na = a.host.split('.').map(Number);
        const nb = b.host.split('.').map(Number);
        return na[0] - nb[0] || na[1] - nb[1] || na[2] - nb[2] || na[3] - nb[3];
    });
    return out;
}

/** Fleet totals the free tier is allowed to show. */
export function summarise(cams: ScannedCamera[]) {
    const v = (x: ScannedCamera) => x.result?.verdict;
    return {
        cameras: cams.length,
        rollback: cams.filter((c) => v(c) === 'will-roll-back').length,
        unknown: cams.filter((c) => v(c) === 'unknown' || (c.result?.unknown ?? 0) > 0).length,
        clean: cams.filter((c) => v(c) === 'will-upgrade').length,
        applications: new Set(
            cams.flatMap((c) =>
                (c.result?.findings ?? [])
                    .filter((f: Finding) => f.application && f.severity === 'blocking')
                    .map((f: Finding) => f.application as string)
            )
        ).size,
    };
}
