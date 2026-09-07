/**
 * The rule whose false positive costs a purchase order.
 *
 * Every other rule here errs toward "unverified" because a false all-clear is
 * the expensive mistake. This one is the other way round: saying "no upgrade
 * path" about a camera that has one tells somebody to replace working hardware.
 * So these tests care as much about what it does NOT claim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradePath, normaliseModel, os13ThirtyTwoBitModels, OS13_32BIT_PRODUCTS, osMajor } from '../dist/os13.js';
import { evaluate } from '../dist/engine.js';
import { parseApplications } from '../dist/scan.js';

test('64-bit hardware always has a path, whatever the model says', () => {
    for (const a of ['aarch64', 'AArch64', 'arm64']) {
        assert.equal(upgradePath(a, 'Q1656', 12), 'has-path');
        assert.equal(upgradePath(a, null, null), 'has-path', 'architecture alone settles it for 64-bit');
    }
});

test('a 32-bit product on Axis’s list has a path', () => {
    // ARTPEC-7 / i.MX6SX: these DO get AXIS OS 13 and face the real ABI break.
    for (const m of ['Q6075', 'Q6075-SE', 'M5000-G', 'P7304', 'F9114-B', 'M7116', 'I8016-LVE']) {
        assert.equal(upgradePath('armv7hf', m, 12), 'has-path', `${m} is on the list`);
        assert.equal(upgradePath('armv7hf', m, 10), 'has-path', 'the list wins over the firmware track');
    }
});

test('a 32-bit camera absent from the list AND still on AXIS OS 10 has no path', () => {
    // The camera that started this: armv7hf, absent from the list, on 10.12 — so
    // it was never offered AXIS OS 11 either. A closed track.
    for (const m of ['M1137', 'M1137-E', 'M1137 MK II', 'AXIS M1137-E Mk II', 'M1135']) {
        assert.equal(upgradePath('armv7hf', m, 10), 'no-published-path', `${m} should have no path`);
    }
});

test('a 32-bit camera absent from the list but on the ACTIVE track is unknown, not stranded', () => {
    // The trap: the published list omits big ARTPEC-7 families like the P1375 and
    // P3245, and ARTPEC-7 is not the generation Axis says is unsupported. Calling
    // those "no upgrade path" would tell someone to replace working cameras.
    for (const m of ['P1375', 'P3245-LV', 'Q1615 MK III', 'Q3517-LV']) {
        assert.equal(upgradePath('armv7hf', m, 11), 'unknown', `${m} must not be stranded`);
        assert.equal(upgradePath('armv7hf', m, 12), 'unknown', `${m} must not be stranded`);
    }
});

test('osMajor reads the track off the version string', () => {
    assert.equal(osMajor('10.12.300'), 10);
    assert.equal(osMajor('12.11.77'), 12);
    assert.equal(osMajor('9.80.3.14'), 9);
    assert.equal(osMajor(null), null);
    assert.equal(osMajor('unknown'), null);
});

test('slash notation expands to whole models, never a substring match', () => {
    // "Q6075/-E/-S/-SE" is five products. A startsWith match would also clear a
    // Q6075-XYZ that Axis never listed — inventing hardware compatibility.
    const all = os13ThirtyTwoBitModels();
    for (const m of ['Q6075', 'Q6075-E', 'Q6075-S', 'Q6075-SE']) assert.ok(all.includes(m), m);
    assert.equal(upgradePath('armv7hf', 'Q6075-XYZ', 10), 'no-published-path');
    assert.equal(upgradePath('armv7hf', 'M50001', 10), 'no-published-path', 'M5000 must not clear M50001');
});

test('"X & Mk II" is two products', () => {
    const all = os13ThirtyTwoBitModels();
    assert.ok(all.includes('Q8752-E'));
    assert.ok(all.includes('Q8752-E MK II'));
});

test('missing information is never either answer', () => {
    assert.equal(upgradePath(null, 'M1137', 10), 'unknown', 'no architecture');
    assert.equal(upgradePath('armv7hf', null, 10), 'unknown', 'no model number');
    assert.equal(upgradePath('armv7hf', 'M1137', null), 'unknown', 'no firmware to place the track');
    assert.equal(upgradePath('', '', null), 'unknown');
});

test('normalisation survives how people and cameras write model names', () => {
    assert.equal(normaliseModel('AXIS M1137-E Mk II'), 'M1137-E MK II');
    assert.equal(normaliseModel('  q6075-se '), 'Q6075-SE');
});

test('the published list is reproduced, not summarised', () => {
    assert.ok(OS13_32BIT_PRODUCTS.length >= 45, 'the list shrank — was the source re-read?');
    assert.ok(os13ThirtyTwoBitModels().length > OS13_32BIT_PRODUCTS.length, 'variants must expand');
});

// ---- end to end through the engine ----

const params = (arch, fw) => {
    const m = new Map([
        ['properties.system.architecture', arch],
        ['properties.firmware.version', fw],
    ]);
    return { get: (n) => m.get(n.replace(/^root\./i, '').toLowerCase()), size: m.size };
};
const apps = parseApplications(
    '<reply result="ok"><application Name="camoverlay" Version="1.0" SignatureStatus="Signed"></application></reply>'
);

test('an ARTPEC-6 camera gets its own verdict, not a rollback warning', () => {
    const r = evaluate({ targetOsMajor: 13, firmware: { raw: '10.12.300' }, architecture: 'armv7hf',
        productNumber: 'M1137', apps, params: params('armv7hf', '10.12.300') });
    assert.equal(r.verdict, 'no-upgrade-path');
    assert.ok(r.findings.some((f) => f.rule === 'A9'));
    // The key suppression: do not tell someone to rebuild for an ABI they will
    // never meet.
    assert.ok(!r.findings.some((f) => f.rule === 'A5'), 'A5 must be suppressed');
});

test('an ARTPEC-7 camera still gets the real ABI finding', () => {
    const r = evaluate({ targetOsMajor: 13, firmware: { raw: '12.11.77' }, architecture: 'armv7hf',
        productNumber: 'Q6075-E', apps, params: params('armv7hf', '12.11.77') });
    assert.ok(!r.findings.some((f) => f.rule === 'A9'), 'it has a path');
    assert.ok(r.findings.some((f) => f.rule === 'A5'), 'the ABI break is real for it');
    assert.equal(r.verdict, 'will-roll-back');
});

test('A9 names its source and does not order a replacement', () => {
    const r = evaluate({ targetOsMajor: 13, firmware: { raw: '10.12.300' }, architecture: 'armv7hf',
        productNumber: 'M1137', apps, params: params('armv7hf', '10.12.300') });
    const a9 = r.findings.find((f) => f.rule === 'A9');
    assert.match(a9.message, /help\.axis\.com/);
    assert.match(a9.message, /Confirm with Axis/);
    assert.match(a9.message, /never offered\s+AXIS OS 11|closed track/, 'must show its reasoning');
});

test('a target below 13 does not raise A9 at all', () => {
    const r = evaluate({ targetOsMajor: 12, firmware: { raw: '10.12.300' }, architecture: 'armv7hf',
        productNumber: 'M1137', apps, params: params('armv7hf', '10.12.300') });
    assert.ok(!r.findings.some((f) => f.rule === 'A9'));
});
