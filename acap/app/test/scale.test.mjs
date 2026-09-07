/**
 * What a big fleet costs.
 *
 * Not a benchmark — a ceiling. The question this answers is the one an operator
 * asks before running this on somebody's site: does a hundred cameras make the
 * camera it runs on fall over? The numbers below are small, and the value of the
 * test is that they stay small when someone adds a field to a finding.
 *
 * Measured on hardware shapes: a Q1656 with 13 applications produces 15
 * findings, which is the worst real case seen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../dist/engine.js';
import { summarise, parseApplications } from '../dist/scan.js';

// A realistic list.cgi: 13 applications, none declaring compatibility, all
// unsigned — i.e. every one of them a finding. Synthetic so the test does not
// depend on bench captures, which are deliberately not in git.
const xml =
    '<reply result="ok">' +
    Array.from({ length: 13 }, (_, i) =>
        `<application Name="app_number_${i}" NiceName="Application Number ${i}" Vendor="Some Vendor" ` +
        `Version="1.${i}.0" ApplicationID="4144${i}" Status="Running" SignatureStatus="Unknown"></application>`
    ).join('') +
    '</reply>';

const apps = parseApplications(xml);

const params = new Map([
    ['brand.prodnbr', 'Q1656'],
    ['properties.firmware.version', '12.11.77'],
    ['properties.system.architecture', 'aarch64'],
    ['network.http.authenticationpolicy', 'recommended'],
    ['system.boagrouppolicy.admin', 'password'],
    ['network.upnp.enabled', 'yes'],
]);
const lookup = { get: (n) => params.get(n.replace(/^root\./i, '').toLowerCase()), size: params.size };

function fleet(n) {
    return Array.from({ length: n }, (_, i) => ({
        host: `10.0.${Math.floor(i / 254)}.${(i % 254) + 1}`,
        reachable: true, product: 'Q1656', firmware: '12.11.77', architecture: 'aarch64',
        serial: 'B8A44F27EA44', onvif: { hardware: 'Q1656', name: 'AXIS Q1656' },
        result: evaluate({ targetOsMajor: 13, firmware: { raw: '12.11.77' }, architecture: 'aarch64',
            productNumber: 'Q1656', apps, params: lookup }),
    }));
}

test('13 applications produce per-application findings, not one lump', () => {
    const r = fleet(1)[0].result;
    const named = new Set(r.findings.filter((f) => f.application).map((f) => f.application));
    assert.equal(named.size, 13, 'every application should be named separately');
    assert.equal(r.appCount, 13);
});

test('250 cameras stay well inside what a camera can hold', () => {
    const cams = fleet(250);
    const bytes = JSON.stringify({ at: new Date().toISOString(), cameras: cams }).length;
    // Measured at ~0.9 MB. 3 MB is the line where this stops being obviously
    // safe to keep in memory and write to flash on every scan.
    assert.ok(bytes < 3 * 1024 * 1024, `results.json is ${(bytes / 1048576).toFixed(2)} MB`);
    // Per camera, so the failure names the cause rather than the total.
    const per = bytes / cams.length;
    assert.ok(per < 12 * 1024, `${(per / 1024).toFixed(1)} KB per camera — a finding grew`);
});

test('the summary is counts only, so it does not grow with the fleet', () => {
    const s = summarise(fleet(250));
    assert.equal(s.cameras, 250);
    assert.equal(s.rollback, 250);
    // This is what /status polls during a scan; it must stay a handful of numbers.
    assert.ok(JSON.stringify(s).length < 200, 'summary must not carry per-camera data');
    assert.ok(Object.values(s).every((v) => typeof v === 'number'));
});
