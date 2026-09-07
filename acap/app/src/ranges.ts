/**
 * What gets scanned, said out loud.
 *
 * Two problems, one file.
 *
 * 1. SILENT SCOPE. The sweep covers one /24 — the camera's own. A site with a
 *    hundred cameras across a /22 got one quarter scanned and the other three
 *    quarters were simply absent from the report. Not flagged, not counted:
 *    absent. A tool whose whole promise is "no camera is silently omitted"
 *    cannot omit three quarters of a site without saying so.
 *
 * 2. NO WAY TO WIDEN IT. Even an operator who knows about the other subnets had
 *    no way to include them.
 *
 * So the scan now produces a plan — the exact ranges and the exact address
 * count — which is stored with the results, shown under the table, and printed
 * in the customer report. The operator can add ranges, and what they added is
 * part of the record.
 *
 * The /24 default stays the default. A camera is not a network scanner, and
 * sweeping a /16 from one because it happened to be reachable is how this
 * application ends up on a security team's list rather than in their toolkit.
 */

/**
 * Total addresses one scan may cover.
 *
 * 4096 is sixteen /24s: enough for any single site an integrator manages from
 * one camera, and far short of anything that looks like network reconnaissance.
 * At the default concurrency, and 6s for an address that is dropped rather than
 * refused, the ceiling is also roughly half an hour — past which nobody is
 * watching anyway.
 */
export const MAX_HOSTS = 4096;

/** Addresses a single added range may contribute. A /22 is 1022; a /21 is not allowed. */
export const MAX_RANGE_HOSTS = 1024;

export type Range = { label: string; hosts: string[] };
export type Plan = {
    ranges: Range[];
    hosts: string[];
    /** Things the operator needs to know about their own request. */
    warnings: string[];
};

const toInt = (ip: string): number | null => {
    const p = ip.trim().split('.');
    if (p.length !== 4) return null;
    let n = 0;
    for (const s of p) {
        if (!/^\d{1,3}$/.test(s)) return null;
        const v = Number(s);
        if (v > 255) return null;
        n = (n << 8) | v;
    }
    return n >>> 0;
};

const toIp = (n: number): string =>
    `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;

/**
 * Parse one operator-typed range.
 *
 * Accepts CIDR (`10.0.5.0/24`) and a plain span (`10.0.5.10-10.0.5.60`), because
 * people write both and rejecting one of them just produces a support email. A
 * /31 or /32 is taken literally rather than having its network and broadcast
 * addresses stripped, since someone typing `10.0.5.7/32` means that address.
 */
export function parseRange(text: string): Range | { error: string } {
    const t = text.trim();
    if (!t) return { error: 'empty' };

    const span = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(t);
    if (span) {
        const a = toInt(span[1]);
        const b = toInt(span[2]);
        if (a === null || b === null) return { error: `${t} is not a pair of IPv4 addresses` };
        if (b < a) return { error: `${t} runs backwards` };
        const count = b - a + 1;
        if (count > MAX_RANGE_HOSTS) {
            return { error: `${t} is ${count} addresses; ${MAX_RANGE_HOSTS} is the most in one range` };
        }
        const hosts: string[] = [];
        for (let n = a; n <= b; n++) hosts.push(toIp(n));
        return { label: `${toIp(a)}–${toIp(b)}`, hosts };
    }

    const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(t);
    if (!cidr) return { error: `${t} is not a range — use 10.0.5.0/24 or 10.0.5.10-10.0.5.60` };
    const base = toInt(cidr[1]);
    const bits = Number(cidr[2]);
    if (base === null || bits < 0 || bits > 32) return { error: `${t} is not a valid CIDR range` };

    const size = 2 ** (32 - bits);
    if (size > MAX_RANGE_HOSTS + 2) {
        return { error: `/${bits} is ${size} addresses; /${32 - Math.log2(MAX_RANGE_HOSTS + 2) + 1 | 0} or narrower, please` };
    }

    const net = bits === 0 ? 0 : (base & (0xffffffff << (32 - bits))) >>> 0;
    const hosts: string[] = [];
    if (size <= 2) {
        // /31 and /32: the addresses mean themselves.
        for (let i = 0; i < size; i++) hosts.push(toIp((net + i) >>> 0));
    } else {
        for (let i = 1; i < size - 1; i++) hosts.push(toIp((net + i) >>> 0));
    }
    return { label: `${toIp(net)}/${bits}`, hosts };
}

/**
 * Build the scan plan: this camera's /24, plus anything the operator added.
 *
 * Duplicates are removed across ranges — overlapping ranges are a normal typing
 * mistake, and checking the same camera twice would double the time and produce
 * two rows for one device. The plan keeps its ranges in the order given so the
 * report reads the way the operator thinks about the site.
 */
export function planScan(ownAddress: string, ownNetmask: string, extra: string[] = []): Plan {
    const warnings: string[] = [];
    const seen = new Set<string>();
    const ranges: Range[] = [];

    const add = (label: string, hosts: string[]) => {
        const fresh = hosts.filter((h) => !seen.has(h));
        for (const h of fresh) seen.add(h);
        if (fresh.length) ranges.push({ label, hosts: fresh });
        return fresh.length;
    };

    const oct = ownAddress.split('.').map(Number);
    const mask = ownNetmask.split('.').map(Number);
    if (oct.length === 4 && !oct.some(Number.isNaN)) {
        const bits = mask.length === 4 && !mask.some(Number.isNaN)
            ? mask.reduce((n, b) => n + (b >>> 0).toString(2).split('1').length - 1, 0)
            : 24;
        if (bits < 24) {
            // The clamp that used to be invisible. Say it, and say what to do.
            warnings.push(
                `This camera's network is a /${bits}, which is wider than the /24 scanned by default. ` +
                    'Cameras outside ' +
                    `${oct[0]}.${oct[1]}.${oct[2]}.0/24 are not included — add the other ranges below if you want them.`
            );
        }
        const local = parseRange(`${oct[0]}.${oct[1]}.${oct[2]}.0/24`);
        if (!('error' in local)) add(`${local.label} (this camera's network)`, local.hosts);
    }

    for (const text of extra) {
        if (!text.trim()) continue;
        const r = parseRange(text);
        if ('error' in r) {
            warnings.push(`Skipped "${text.trim()}": ${r.error}`);
            continue;
        }
        if (seen.size + r.hosts.length > MAX_HOSTS) {
            warnings.push(
                `Skipped ${r.label}: it would take the scan past ${MAX_HOSTS} addresses, which is the limit ` +
                    'for one scan from one camera.'
            );
            continue;
        }
        const added = add(r.label, r.hosts);
        if (added === 0) warnings.push(`${r.label} was already covered by another range.`);
    }

    return { ranges, hosts: [...seen], warnings };
}

/** One line for the UI and the report: what was actually looked at. */
export function describePlan(p: { ranges: { label: string; hosts?: string[] }[]; addresses: number }): string {
    if (!p.ranges.length) return 'No addresses were scanned.';
    const names = p.ranges.map((r) => r.label).join(', ');
    return `Scanned ${p.addresses} address${p.addresses === 1 ? '' : 'es'}: ${names}.`;
}
