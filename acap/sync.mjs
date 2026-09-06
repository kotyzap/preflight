#!/usr/bin/env node
/**
 * Pull the shared sources in from their single home.
 *
 * engine.ts, report.ts and rules.json are authored once — in axis-cli and the
 * Preflight repo respectively — and copied here. Copies drift, so this script
 * exists to make the copy a mechanical step rather than a manual one, and it
 * stamps each file with a header saying where it came from.
 *
 *   node sync.mjs                       # uses the default relative paths
 *   AXIS_CLI=/path/to/axis-cli node sync.mjs
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, 'app/src');

// Several layouts are legitimate: the repos sit side by side in Projects/ on the
// authoring machine, and are mounted flat by name in some sandboxes. Try each
// rather than assuming one and failing with a path nobody recognises.
const cliCandidates = [
  process.env.AXIS_CLI,
  resolve(HERE, '../../AXIS CLI/axis-cli'),
  resolve(HERE, '../../../AXIS CLI/axis-cli'),
  resolve(HERE, '../../axis-cli'),
  resolve(HERE, '../../../axis-cli'),
  resolve(HERE, '../axis-cli'),
].filter(Boolean);
const cli = cliCandidates.find((p) => existsSync(resolve(p, 'src/preflight/engine.ts')));

if (!cli) {
  console.error('Could not find axis-cli. Looked in:');
  cliCandidates.forEach((p) => console.error('  ' + p));
  console.error('\nSet AXIS_CLI to its path.');
  process.exit(1);
}

const banner = (from) =>
  `// SYNCED COPY — do not edit here.\n` +
  `// Source of truth: ${from}\n` +
  `// Re-run \`node sync.mjs\` after changing it there.\n\n`;

for (const [rel, dest] of [
  ['src/preflight/engine.ts', 'engine.ts'],
  ['src/preflight/report.ts', 'report.ts'],
]) {
  const from = resolve(cli, rel);
  writeFileSync(resolve(SRC, dest), banner('axis-cli/' + rel) + readFileSync(from, 'utf8'));
  console.log(`  ${dest}  ← axis-cli/${rel}`);
}

const rules = resolve(HERE, '../rules.json');
copyFileSync(rules, resolve(SRC, 'rules.json'));
const v = JSON.parse(readFileSync(rules, 'utf8'));
console.log(`  rules.json  ← ../rules.json  (${v.rulesetVersion}, ${v.rules.length} rules)`);
