// The header's version is a literal so the page still shows it when nothing routes.
// A literal drifts, and a wrong version on screen is worse than none: it makes a
// failed reinstall look successful. So the build refuses to produce a package whose
// page and manifest disagree.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version;
const man = JSON.parse(readFileSync('manifest.json', 'utf8')).acapPackageConf.setup.version;
const html = /data-page="([^"]*)"/.exec(readFileSync('html/index.html', 'utf8'))?.[1];

const bad = [
    man !== pkg && `manifest.json says ${man}, package.json says ${pkg}`,
    html !== pkg && `html/index.html data-page says ${html}, package.json says ${pkg}`,
].filter(Boolean);

if (bad.length) {
    console.error('version mismatch:\n  ' + bad.join('\n  '));
    process.exit(1);
}
console.log(`version ${pkg}: manifest, package and page agree`);
