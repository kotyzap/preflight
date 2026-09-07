/**
 * The advice text is what most operators will actually read, and it lives in an
 * inline script inside a package that has to be rebuilt and reinstalled on a
 * camera to look at. So it is exercised here instead: the real function, pulled
 * out of the real page, against the verdict shapes the bench produces.
 *
 * The thing being guarded is not the wording. It is that every shape gets advice
 * at all — a camera that silently gets no next action is the failure mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const body = /<script>([\s\S]*?)<\/script>/.exec(readFileSync('html/index.html', 'utf8'))[1];
const open = '(function () {';
const src = body.slice(body.indexOf(open) + open.length, body.lastIndexOf('})();'));
const el = {
    value: '', placeholder: '', dataset: {}, classList: { add() {} }, style: {}, children: [],
    querySelector() { return el; }, querySelectorAll() { return []; }, appendChild() {}, remove() {},
    setAttribute() {}, addEventListener() {}, innerHTML: '', textContent: '', closest() { return null },
    get onclick() { return null }, set onclick(v) {},
};
const api = new Function(
    'esc', '$', 'localStorage', 'location', 'fetch', 'document', 'window',
    src + '\n; return { advice: advice, fleetKicker: fleetKicker };'
)(
    (s) => String(s == null ? '' : s), () => el, { getItem: () => null, setItem() {} },
    { pathname: '/local/preflight/index.html' }, () => new Promise(() => {}),
    { documentElement: { dataset: {} }, getElementById: () => el, createElement: () => el }, {}
);

const shapes = {
    unchecked: { host: 'x', result: null, onvif: { name: 'AXIS M1137', hardware: 'M1137' }, note: 'refused' },
    namedApps: { host: 'x', firmware: '12.11.77', result: { verdict: 'will-roll-back', unknown: 0, findings: [
        { rule: 'A1', severity: 'blocking', application: 'camwallet' },
        { rule: 'A4', severity: 'blocking', application: 'camwallet' },
        { rule: 'A1', severity: 'blocking', application: 'needle_mcp' }] } },
    redacted: { host: 'x', firmware: '12.11.77', result: { verdict: 'will-roll-back', unknown: 0, findings: [
        { rule: 'A2', severity: 'blocking' }] } },
    thirtyTwoBit: { host: 'x', firmware: '10.12.300', result: { verdict: 'will-roll-back', unknown: 0, findings: [
        { rule: 'A5', severity: 'blocking' }] } },
    clean: { host: 'x', firmware: '12.11.77', result: { verdict: 'will-upgrade', unknown: 0, findings: [] } },
    unknowns: { host: 'x', firmware: '10.12.300', result: { verdict: 'unknown', unknown: 2, findings: [
        { rule: 'A1', severity: 'unknown' }] } },
};

test('every camera shape gets a next action', () => {
    for (const [name, c] of Object.entries(shapes)) {
        const a = api.advice(c, 13);
        assert.ok(a && a.title && a.text, `${name} got no advice`);
        assert.ok(['bad', 'unk', 'ok'].includes(a.tone), `${name} has tone ${a.tone}`);
    }
});

test('two applications tripping four rules is two things to fix, not four', () => {
    // The whole point of grouping: 3 findings over 2 applications.
    assert.match(api.advice(shapes.namedApps, 13).title, /\b2 applications\b/);
});

test('the target OS is the configured one, not a hardcoded 13', () => {
    assert.match(api.advice(shapes.namedApps, 14).text, /AXIS OS 14/);
});

test('the free tier is told how to get the names, and never given them', () => {
    const a = api.advice(shapes.redacted, 13);
    assert.equal(a.tone, 'bad');
    assert.match(a.text, /licence key|preflight\.4xs\.dev/);
    assert.doesNotMatch(a.text, /camwallet|needle_mcp/);
});

test('a 32-bit camera is not told to uninstall its way out', () => {
    assert.match(api.advice(shapes.thirtyTwoBit, 13).title, /32-bit/);
});

test('an unreadable camera is never described as safe', () => {
    for (const c of [shapes.unchecked, shapes.unknowns]) {
        const a = api.advice(c, 13);
        assert.equal(a.tone, 'unk', 'unreadable must not read as ok');
        assert.doesNotMatch(a.text, /\bis safe\b/);
    }
});

test('no article glued to a model name', () => {
    assert.doesNotMatch(api.advice(shapes.unchecked, 13).text, /\ba AXIS\b|\ban M\d/);
});

test('unchecked cameras are surfaced even when nothing rolls back', () => {
    const k = api.fleetKicker({ cameras: 3, rollback: 0, unknown: 1 });
    assert.match(k, /kick unk/);
    assert.match(k, /not a safe camera/);
});

test('a clean fleet says go ahead, a broken one leads with applications', () => {
    assert.match(api.fleetKicker({ cameras: 3, rollback: 0, unknown: 0 }), /kick ok/);
    assert.match(api.fleetKicker({ cameras: 3, rollback: 3, unknown: 2, applications: 7 }), /applications, not the cameras/);
});
