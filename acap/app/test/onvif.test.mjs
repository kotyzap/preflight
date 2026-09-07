// Namespace prefixes are not fixed by the WS-Discovery spec. Every vendor picks
// its own, so these fixtures use different ones deliberately: a prefix-sensitive
// parser passes one of them and silently finds nothing on the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeMatch } from '../dist/onvif.js';

const axis = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch>
<d:Types>dn:NetworkVideoTransmitter</d:Types>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/Profile/Streaming onvif://www.onvif.org/name/AXIS%20M3085-V onvif://www.onvif.org/hardware/M3085-V onvif://www.onvif.org/location/</d:Scopes>
<d:XAddrs>http://192.168.1.185/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs>
</d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

const wsdd = `<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body>
<wsdd:ProbeMatches xmlns:wsdd="http://schemas.xmlsoap.org/ws/2005/04/discovery"><wsdd:ProbeMatch>
<wsdd:Scopes>onvif://www.onvif.org/manufacturer/OtherVendor onvif://www.onvif.org/hardware/CAM-99</wsdd:Scopes>
<wsdd:XAddrs>http://10.0.0.9/onvif/device_service</wsdd:XAddrs>
</wsdd:ProbeMatch></wsdd:ProbeMatches></Body></Envelope>`;

const noPrefix = `<Envelope><Body><ProbeMatches><ProbeMatch>
<Scopes>onvif://www.onvif.org/hardware/P1375</Scopes><XAddrs>http://172.16.0.5/onvif/device_service</XAddrs>
</ProbeMatch></ProbeMatches></Body></Envelope>`;

test('Axis-style d: prefix, and %20 in the name', () => {
    const d = parseProbeMatch(axis, '192.168.1.185');
    assert.equal(d.hardware, 'M3085-V');
    assert.equal(d.name, 'AXIS M3085-V');
    assert.equal(d.xaddr, 'http://192.168.1.185/onvif/device_service');
});

test('wsdd: prefix from another vendor', () => {
    const d = parseProbeMatch(wsdd, '10.0.0.9');
    assert.equal(d.hardware, 'CAM-99');
    assert.equal(d.manufacturer, 'OtherVendor');
});

test('no prefix at all', () => {
    assert.equal(parseProbeMatch(noPrefix, '172.16.0.5').hardware, 'P1375');
});

test('the host is the address that answered, not the advertised XAddrs', () => {
    // A multi-homed device can advertise an address this camera cannot reach.
    assert.equal(parseProbeMatch(axis, '192.168.9.9').host, '192.168.9.9');
});

test('a matched device with no scopes is still reported', () => {
    const d = parseProbeMatch('<ProbeMatches><ProbeMatch><XAddrs>http://1.2.3.4/x</XAddrs></ProbeMatch></ProbeMatches>', '1.2.3.4');
    assert.equal(d.hardware, null);
    assert.equal(d.host, '1.2.3.4');
});

test('anything that is not a ProbeMatch is ignored', () => {
    assert.equal(parseProbeMatch('<Envelope><Body><Hello/></Body></Envelope>', '1.2.3.4'), null);
    assert.equal(parseProbeMatch('', '1.2.3.4'), null);
});
