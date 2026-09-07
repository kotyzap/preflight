// The header's version is a literal so the page still shows it when nothing routes.
// A literal drifts, and a wrong version on screen is worse than none: it makes a
// failed reinstall look successful. So the build refuses to produce a package whose
// page and manifest disagree.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version;
const man = JSON.parse(readFileSync('manifest.json', 'utf8')).acapPackageConf.setup.version;
const page = readFileSync('html/index.html', 'utf8');
const html = /data-page="([^"]*)"/.exec(page)?.[1];

// The settings UI is one inline script in a package that has to be rebuilt and
// reinstalled on a camera to test, so a mistake here costs ten minutes to see.
// These two checks are the ones that have actually bitten.
const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
const uiBad = [];

// 1. It must parse. A syntax error renders a perfect-looking page with dead
//    controls and nothing in the console until you look for it.
try {
    new Function(script);
} catch (err) {
    uiBad.push(`the inline script does not parse: ${err.message}`);
}

// 2. Event listeners must not be registered inside draw(). draw() runs on load,
//    after every save and on every poll tick, and #out survives all of them —
//    so a listener added there accumulates one copy per draw. Each copy toggled
//    row.hidden, so an even number of copies toggled twice and the row never
//    moved: buttons that looked frozen while every handler fired correctly.
const from = script.indexOf('function draw(d) {');
const to = script.indexOf('function recheck(btn)');
if (from === -1 || to === -1 || to < from) {
    uiBad.push('cannot find the draw()/recheck() boundary to check listener registration');
} else if (/addEventListener/.test(script.slice(from, to))) {
    uiBad.push('addEventListener inside draw() — listeners accumulate, one per redraw');
}
const listeners = (script.match(/addEventListener\('click'/g) ?? []).length;
if (listeners !== 1) uiBad.push(`expected exactly 1 delegated click listener, found ${listeners}`);

if (uiBad.length) {
    console.error('settings UI:\n  ' + uiBad.join('\n  '));
    process.exit(1);
}

const bad = [
    man !== pkg && `manifest.json says ${man}, package.json says ${pkg}`,
    html !== pkg && `html/index.html data-page says ${html}, package.json says ${pkg}`,
].filter(Boolean);

if (bad.length) {
    console.error('version mismatch:\n  ' + bad.join('\n  '));
    process.exit(1);
}
console.log(`version ${pkg}: manifest, package and page agree`);
