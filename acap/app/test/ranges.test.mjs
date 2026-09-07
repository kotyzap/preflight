/**
 * Scope is the one thing this application must never get quietly wrong. A camera
 * missed because its subnet was never scanned looks exactly like a camera that
 * passed — and that is the failure the whole product exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, planScan, describePlan, MAX_HOSTS, MAX_RANGE_HOSTS } from '../dist/ranges.js';

test('a /24 is 254 usable addresses, network and broadcast excluded', () => {
    const r = parseRange('10.0.5.0/24');
    assert.equal(r.hosts.length, 254);
    assert.equal(r.hosts[0], '10.0.5.1');
    assert.equal(r.hosts[253], '10.0.5.254');
});

test('a CIDR base that is not the network address still yields that network', () => {
    // People type the camera's own address with a prefix. Take the network.
    assert.equal(parseRange('10.0.5.77/24').label, '10.0.5.0/24');
});

test('a single host means that host, not an empty range', () => {
    // /32 with network+broadcast stripped would be zero addresses — useless, and
    // silently so, which is the worst kind.
    assert.deepEqual(parseRange('10.0.5.7/32').hosts, ['10.0.5.7']);
    assert.equal(parseRange('10.0.5.6/31').hosts.length, 2);
});

test('a dash span is accepted, because people write both forms', () => {
    const r = parseRange('10.0.5.10-10.0.5.12');
    assert.deepEqual(r.hosts, ['10.0.5.10', '10.0.5.11', '10.0.5.12']);
});

test('a span across octets does not wrap', () => {
    const r = parseRange('10.0.4.254-10.0.5.2');
    assert.deepEqual(r.hosts, ['10.0.4.254', '10.0.4.255', '10.0.5.0', '10.0.5.1', '10.0.5.2']);
});

test('nonsense is rejected with a message, never silently dropped', () => {
    for (const bad of ['', 'hello', '10.0.5.0/33', '999.1.1.1/24', '10.0.5.20-10.0.5.10', '10.0.5.1']) {
        const r = parseRange(bad);
        assert.ok(r.error, `${bad} should not parse`);
        assert.ok(typeof r.error === 'string' && r.error.length > 0);
    }
});

test('a range too large to be a site is refused', () => {
    assert.ok(parseRange('10.0.0.0/16').error);
    assert.ok(parseRange('10.0.0.1-10.0.99.1').error);
    assert.ok(!parseRange(`10.0.0.0/22`).error, 'a /22 is a plausible site');
});

test('the default plan is this camera’s /24, and says so', () => {
    const p = planScan('192.168.1.156', '255.255.255.0');
    assert.equal(p.hosts.length, 254);
    assert.match(p.ranges[0].label, /192\.168\.1\.0\/24 \(this camera/);
    assert.deepEqual(p.warnings, [], 'a /24 network needs no warning');
    assert.ok(p.hosts.includes('192.168.1.156'), 'the camera scans itself');
});

test('a network wider than a /24 warns instead of silently clamping', () => {
    const p = planScan('10.0.5.20', '255.255.252.0');
    assert.equal(p.hosts.length, 254, 'still only the local /24 by default');
    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0], /\/22/);
    assert.match(p.warnings[0], /not included/);
});

test('extra ranges are added in the order given', () => {
    const p = planScan('10.0.5.20', '255.255.255.0', ['10.0.6.0/24', '10.0.7.10-10.0.7.20']);
    assert.equal(p.ranges.length, 3);
    assert.equal(p.ranges[1].label, '10.0.6.0/24');
    assert.equal(p.hosts.length, 254 + 254 + 11);
    assert.deepEqual(p.warnings, []);
});

test('an overlapping range is deduplicated, and the operator is told', () => {
    // Two rows for one camera, and double the scan time, from one typo.
    const p = planScan('10.0.5.20', '255.255.255.0', ['10.0.5.0/24']);
    assert.equal(p.hosts.length, 254);
    assert.equal(new Set(p.hosts).size, 254);
    assert.match(p.warnings[0], /already covered/);
});

test('a partial overlap keeps only the new addresses', () => {
    const p = planScan('10.0.5.20', '255.255.255.0', ['10.0.5.250-10.0.6.5']);
    assert.equal(new Set(p.hosts).size, p.hosts.length);
    // The /24 covered .1-.254, so the span contributes .255 plus 10.0.6.0-.5.
    // A literal span includes 10.0.6.0: the operator typed it, so it is meant.
    assert.equal(p.hosts.length, 254 + 7, 'only .255 and 10.0.6.0-.5 are new');
    assert.deepEqual(p.ranges[1].hosts.slice(0, 2), ['10.0.5.255', '10.0.6.0']);
});

test('the total is capped, and the skipped range is named', () => {
    const many = Array.from({ length: 24 }, (_, i) => `10.9.${i}.0/24`);
    const p = planScan('10.0.5.20', '255.255.255.0', many);
    assert.ok(p.hosts.length <= MAX_HOSTS, `${p.hosts.length} exceeds ${MAX_HOSTS}`);
    assert.ok(p.warnings.some((w) => /past 4096 addresses/.test(w)));
    // A silent truncation would be the same bug as the silent /24 clamp.
    assert.ok(p.warnings.some((w) => /^Skipped 10\.9\./.test(w)));
});

test('the plan describes itself for the report', () => {
    const p = planScan('10.0.5.20', '255.255.255.0', ['10.0.6.0/24']);
    const line = describePlan({ ranges: p.ranges, addresses: p.hosts.length });
    assert.match(line, /508 addresses/);
    assert.match(line, /10\.0\.6\.0\/24/);
    assert.match(line, /this camera/);
});

test('MAX_RANGE_HOSTS is the per-range guard, MAX_HOSTS the total', () => {
    assert.ok(MAX_RANGE_HOSTS < MAX_HOSTS);
});
