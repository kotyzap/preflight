/**
 * ONVIF WS-Discovery.
 *
 * Why this exists: every other check in this application needs an Administrator
 * account on the camera it is checking, and on a real fleet you will not have one
 * for every camera. Those cameras came back as "responded, credentials refused" —
 * a row with an address and nothing else, which is not an inventory.
 *
 * WS-Discovery answers with the model and name of a device *without any
 * credentials at all*, so an unreachable camera still lands in the report as
 * "M3085-V, could not be checked" rather than as a bare IP address.
 *
 * NOTE ON THE READ-ONLY PROMISE. Everything else here is an HTTP GET. This is
 * one UDP multicast datagram to the standard ONVIF discovery group — the same
 * probe every VMS and every discovery tool on the network sends, and the same one
 * Axis's own IP Utility sends. It asks devices to describe themselves; it changes
 * nothing. It is surfaced by `status` alongside the HTTP endpoints so the claim
 * stays checkable, because "read-only" has to mean the whole application, not
 * just the part that was convenient.
 */

import * as dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';

/** The ONVIF discovery group and port. Fixed by the specification. */
export const DISCOVERY = { group: '239.255.255.250', port: 3702, transport: 'UDP' } as const;

export type OnvifDevice = {
    host: string;
    /** Model, from the `onvif://…/hardware/` scope. The useful part. */
    hardware: string | null;
    /** Friendly name, from the `onvif://…/name/` scope. Often "AXIS <model>". */
    name: string | null;
    manufacturer: string | null;
    /** The device service URL the device advertises. */
    xaddr: string | null;
};

function probeMessage(): string {
    // WS-Discovery Probe for ONVIF devices. Kept as one line per element so the
    // shape is readable; whitespace between elements is insignificant in SOAP.
    return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"' +
        ' xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"' +
        ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"' +
        ' xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
        '<e:Header>' +
        `<w:MessageID>uuid:${randomUUID()}</w:MessageID>` +
        '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>' +
        '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>' +
        '</e:Header>' +
        '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>' +
        '</e:Envelope>'
    );
}

/** Pull one `onvif://www.onvif.org/<kind>/<value>` scope out of the Scopes element. */
function scope(scopes: string[], kind: string): string | null {
    const prefix = `/${kind}/`;
    for (const s of scopes) {
        const i = s.indexOf(prefix);
        if (i === -1) continue;
        const raw = s.slice(i + prefix.length);
        if (!raw) continue;
        try {
            // Scopes are URIs, so a model with a space arrives as %20.
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    }
    return null;
}

/**
 * Parse a ProbeMatch response.
 *
 * Namespace prefixes are not fixed by the spec — devices use d:, wsdd:, tds:,
 * or none at all — so element names are matched with an optional prefix rather
 * than a literal one. A prefix-sensitive parser silently finds nothing on
 * whichever vendor chose differently.
 */
export function parseProbeMatch(xml: string, host: string): OnvifDevice | null {
    if (!/ProbeMatch/i.test(xml)) return null;

    const el = (name: string) =>
        new RegExp(`<(?:[\\w-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i').exec(xml)?.[1]?.trim() ??
        null;

    const scopes = (el('Scopes') ?? '').split(/\s+/).filter(Boolean);
    const xaddrs = (el('XAddrs') ?? '').split(/\s+/).filter(Boolean);

    const hardware = scope(scopes, 'hardware');
    const name = scope(scopes, 'name');
    const manufacturer = scope(scopes, 'manufacturer');

    // A device that matched but published no scopes still tells us it exists and
    // speaks ONVIF, which is worth more than nothing on an unreachable address.
    return { host, hardware, name, manufacturer, xaddr: xaddrs[0] ?? null };
}

/**
 * Send the probe and collect answers.
 *
 * Resolves after `timeoutMs` with everything that replied, keyed by the address
 * the reply came *from* — not by the XAddrs the device advertises, which on a
 * multi-homed device can name an interface this camera cannot reach.
 *
 * Never rejects. Discovery is an enrichment: a camera without multicast on its
 * network should get a slightly poorer report, not a failed scan.
 */
export function discover(ownAddress: string | null, timeoutMs = 4000): Promise<Map<string, OnvifDevice>> {
    return new Promise((resolve) => {
        const found = new Map<string, OnvifDevice>();
        let socket: dgram.Socket;
        try {
            socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        } catch {
            return resolve(found);
        }

        const finish = () => {
            try {
                socket.close();
            } catch {
                /* already closed */
            }
            resolve(found);
        };

        socket.on('error', finish);

        socket.on('message', (buf, rinfo) => {
            const dev = parseProbeMatch(buf.toString('utf8'), rinfo.address);
            // First answer wins: a device may reply to both probes below.
            if (dev && !found.has(dev.host)) found.set(dev.host, dev);
        });

        socket.bind(() => {
            try {
                socket.setMulticastTTL(1);
                // Pin the outgoing interface. A camera with more than one address
                // otherwise probes whichever the kernel picks, which is not
                // necessarily the network the operator is asking about.
                if (ownAddress) socket.setMulticastInterface(ownAddress);
            } catch {
                /* not fatal — the default interface is usually right */
            }

            const send = () => {
                const msg = Buffer.from(probeMessage());
                socket.send(msg, 0, msg.length, DISCOVERY.port, DISCOVERY.group, () => {
                    /* a send error is a network without multicast; the timeout handles it */
                });
            };

            send();
            // UDP is lossy and some devices rate-limit discovery. One dropped
            // datagram should not cost a camera its model number.
            const again = setTimeout(send, Math.min(1200, timeoutMs / 3));
            const done = setTimeout(finish, timeoutMs);
            again.unref?.();
            done.unref?.();
        });
    });
}
