#!/usr/bin/env node
// Preflight — renders rules.json to a static page. Zero dependencies.
// Usage: node build.mjs [--out dist/index.html]

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = dirname(new URL(import.meta.url).pathname);
const outArg = process.argv.indexOf('--out');
const OUT = resolve(ROOT, outArg > -1 ? process.argv[outArg + 1] : 'dist/index.html');

const data = JSON.parse(readFileSync(resolve(ROOT, 'rules.json'), 'utf8'));

/**
 * Model → chipset, 579 entries, extracted from the 4XS Toolbox extension whose own
 * snapshot came from CamStreamer's published supported-cameras list.
 *
 * This is what makes the checker useful rather than a lookup against Axis's
 * 58-model list. The bench already proved that list incomplete — an AXIS M1137
 * reports armv7hf and does not appear on it — and the chipset explains why:
 * M1137 is ARTPEC-6/7. Chipset determines the ACAP architecture, so it answers A5
 * for the whole catalogue instead of only the models Axis chose to name.
 */
const chipsets = existsSync(resolve(ROOT, 'chipsets.json'))
  ? JSON.parse(readFileSync(resolve(ROOT, 'chipsets.json'), 'utf8'))
  : { source: null, chipsets: {} };

const SITE = process.env.PREFLIGHT_SITE ?? 'https://preflight.4xs.dev';
const DESCRIPTION =
  'Every documented AXIS OS 13 breaking change, sorted by whether it stops your upgrade, ' +
  'breaks your app, or breaks your integration. Every rule cites Axis.';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const code = (s) => `<code>${esc(s)}</code>`;
const srcUrl = (id) => data.sources[id]?.url ?? '#';

// ---- validation: fail the build rather than ship a broken page -------------
const errors = [];
const seen = new Set();
for (const r of data.rules) {
  for (const k of ['id', 'tier', 'version', 'title', 'summary', 'detection', 'source']) {
    if (!(k in r)) errors.push(`${r.id ?? '?'}: missing ${k}`);
  }
  if (seen.has(r.id)) errors.push(`duplicate id ${r.id}`);
  seen.add(r.id);
  if (!data.sources[r.source]) errors.push(`${r.id}: unknown source ${r.source}`);
  if (r.detection && !data.detectionMethods[r.detection.method]) errors.push(`${r.id}: unknown detection method ${r.detection.method}`);
}
if (errors.length) {
  console.error('rules.json failed validation:\n  ' + errors.join('\n  '));
  process.exit(1);
}

// ---- rendering -------------------------------------------------------------
const TIER_ORDER = ['A', 'B', 'C', 'future'];
const tierMeta = {
  ...data.tiers,
  future: { label: 'Already dated — the 2028 wave', blurb: 'AXIS OS 14, September 2028. Nothing to do today. Worth knowing it is coming.' },
};

const list = (label, items, fmt = code) =>
  items?.length ? `<div class="kv"><span class="k">${label}</span><span class="v">${items.map(fmt).join(' ')}</span></div>` : '';

function renderRule(r) {
  const applied = r.applied ? `<span class="pill pill-applied">already in force</span>` : '';
  const hero = r.hero ? `<span class="pill pill-hero">the one that matters</span>` : '';
  const conf = r.confidence === 'partial' ? `<span class="pill pill-warn">needs verification</span>` : '';
  const det = r.detection ?? {};
  const changed = r.paramsChanged?.length
    ? `<div class="kv"><span class="k">Changes</span><span class="v">${r.paramsChanged
        .map((p) => `${code(p.name)} <span class="arrow">${esc(p.from)} → ${esc(p.to)}</span>`)
        .join('<br>')}</span></div>`
    : '';
  const models = r.models32bit ?? r.modelsAffected;
  const modelBlock = models
    ? `<details class="models"><summary>${models.length} affected models</summary><div class="modelgrid">${models
        .map((m) => `<span>${esc(m)}</span>`)
        .join('')}</div></details>`
    : '';

  return `<article class="rule" id="${esc(r.id)}" data-tier="${esc(r.tier)}" data-version="${esc(r.version)}" data-method="${esc(det.method ?? 'none')}">
  <header>
    <a class="rid" href="#${esc(r.id)}">${esc(r.id)}</a>
    <h3>${esc(r.title)}</h3>
    <span class="pill pill-ver">OS ${esc(r.version)}</span>${applied}${hero}${conf}
  </header>
  <p class="summary">${esc(r.summary)}</p>
  ${r.impact ? `<p class="impact"><strong>What it does to you.</strong> ${esc(r.impact)}</p>` : ''}
  ${changed}
  ${list('Removed', r.paramsRemoved)}
  ${list('Removed', r.apisRemoved)}
  ${list('Changed', r.apisChanged)}
  ${list('Retained', r.paramsRetained)}
  ${modelBlock}
  <div class="detect">
    <span class="k">Detection</span>
    <span class="v">${esc(det.sketch ?? '—')}
      <span class="tag tag-${esc(det.method ?? 'none')}">${esc(det.method ?? 'none')}</span>
      <span class="tag tag-status-${esc(det.status ?? 'open')}">${esc(det.status ?? 'open')}</span>
      ${det.blockedBy ? `<span class="tag tag-blocked">blocked by ${esc(det.blockedBy.split(' ')[0])}</span>` : ''}
    </span>
  </div>
  ${r.correctionNote ? `<p class="correction"><strong>Correction.</strong> ${esc(r.correctionNote)}</p>` : ''}
  ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
  ${r.related?.length ? `<p class="note">See also ${r.related.map((x) => `<a href="#${esc(x)}">${esc(x)}</a>`).join(', ')}.</p>` : ''}
  <a class="src" href="${esc(srcUrl(r.source))}" rel="noopener">Axis source ↗</a>
</article>`;
}

const bySection = TIER_ORDER.map((t) => {
  const rules = data.rules.filter((r) => r.tier === t);
  if (!rules.length) return '';
  return `<section class="tier" data-tier="${t}">
  <h2><span class="tierbadge tb-${t}">${t === 'future' ? '2028' : `Tier ${t}`}</span> ${esc(tierMeta[t].label)}</h2>
  <p class="tierblurb">${esc(tierMeta[t].blurb)}</p>
  ${rules.map(renderRule).join('\n')}
</section>`;
}).join('\n');

const counts = TIER_ORDER.map((t) => [t, data.rules.filter((r) => r.tier === t).length]);

/**
 * Newest AXIS OS version first.
 *
 * Compared segment by segment as integers, NOT with parseFloat: Axis versions are
 * dotted sequences, not decimals, so parseFloat reads both "12.1" and "12.10" as
 * 12.1 and the tie resolves arbitrarily — which put 12.1 ahead of the later 12.10
 * in the filter row.
 */
const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};
const versions = [...new Set(data.rules.map((r) => r.version))].sort(compareVersions);

const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preflight — will your Axis cameras survive AXIS OS 13?</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<link rel="canonical" href="${SITE}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}/">
<meta property="og:site_name" content="Preflight">
<meta property="og:title" content="AXIS OS 13 doesn't warn you. It rolls back.">
<meta property="og:description" content="${esc(DESCRIPTION)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="AXIS OS 13 doesn't warn you. It rolls back.">
<meta name="twitter:description" content="${esc(DESCRIPTION)}">
<meta name="twitter:image" content="${SITE}/og.png">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="author" content="Pavel Kotyza · 4XS.dev">
<meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#131417" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{
  --bg:#f7f7f5; --surface:#fff; --ink:#16181d; --muted:#5c6270; --line:#e2e2dd;
  --accent:#c2410c; --accent-soft:#fff1e9;
  --a:#b91c1c; --a-bg:#fef2f2; --b:#b45309; --b-bg:#fffbeb; --c:#1d4ed8; --c-bg:#eff6ff; --f:#4b5563; --f-bg:#f3f4f6;
  --code-bg:#f0f0ec;
}
html[data-theme="dark"]{
  --bg:#131417; --surface:#1a1c21; --ink:#e8e8e6; --muted:#9aa1ae; --line:#2b2e35;
  --accent:#fb923c; --accent-soft:#2a1a10;
  --a:#f87171; --a-bg:#2a1618; --b:#fbbf24; --b-bg:#2a2110; --c:#7dabff; --c-bg:#141d2e; --f:#9ca3af; --f-bg:#212429;
  --code-bg:#22252b;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:920px;margin:0 auto;padding:0 20px}
a{color:var(--accent)}
code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;
  font:.86em/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}

/* header */
.top{border-bottom:1px solid var(--line);background:var(--surface);position:sticky;top:0;z-index:20}
.top .wrap{display:flex;align-items:center;gap:16px;height:56px}
.brand{font-weight:700;letter-spacing:-.01em}
.brand span{color:var(--accent)}
.top nav{margin-left:auto;display:flex;gap:14px;align-items:center;font-size:14px}
.top nav a{color:var(--muted);text-decoration:none}
.top nav a:hover{color:var(--ink)}
#theme{background:none;border:1px solid var(--line);color:var(--muted);border-radius:6px;
  width:32px;height:32px;cursor:pointer;font-size:15px;line-height:1}
#theme:hover{color:var(--ink);border-color:var(--muted)}

/* hero */
.hero{padding:64px 0 40px}
.hero h1{font-size:clamp(28px,4.4vw,44px);line-height:1.15;letter-spacing:-.02em;margin:0 0 18px;max-width:22ch}
.lede{font-size:19px;color:var(--muted);max-width:62ch;margin:0 0 28px}
.quote{background:var(--a-bg);border-left:3px solid var(--a);padding:18px 22px;border-radius:0 8px 8px 0;margin:0 0 22px}
.quote p{margin:0 0 8px;font-size:17px}
.quote p:last-child{margin:0}
.quote cite{font-style:normal;font-size:13px;color:var(--muted)}
.punch{font-size:18px;max-width:64ch}
.punch strong{color:var(--a)}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:30px 0 0}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px 14px;font-size:14px}
.stat b{font-size:20px;display:block;line-height:1.2}

/* filters */
.filters{position:sticky;top:56px;z-index:10;background:var(--bg);
  border-bottom:1px solid var(--line);padding:12px 0;margin-bottom:8px}
.filters .wrap{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.filters label{font-size:13px;color:var(--muted);margin-right:2px}
button.f{background:var(--surface);border:1px solid var(--line);color:var(--muted);
  border-radius:999px;padding:5px 12px;font-size:13px;cursor:pointer}
button.f:hover{color:var(--ink)}
button.f[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
#q{flex:1;min-width:160px;background:var(--surface);border:1px solid var(--line);color:var(--ink);
  border-radius:999px;padding:6px 14px;font-size:13px}
#count{font-size:13px;color:var(--muted)}

/* tiers + rules */
.tier{margin:44px 0}
.tier h2{font-size:20px;display:flex;align-items:center;gap:10px;margin:0 0 6px;letter-spacing:-.01em}
.tierbadge{font-size:12px;font-weight:700;padding:3px 9px;border-radius:6px;letter-spacing:.02em}
.tb-A{background:var(--a-bg);color:var(--a)} .tb-B{background:var(--b-bg);color:var(--b)}
.tb-C{background:var(--c-bg);color:var(--c)} .tb-future{background:var(--f-bg);color:var(--f)}
.tierblurb{color:var(--muted);margin:0 0 20px;max-width:70ch}

.rule{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:0 0 12px}
.rule[data-tier="A"]{border-left:3px solid var(--a)}
.rule[data-tier="B"]{border-left:3px solid var(--b)}
.rule[data-tier="C"]{border-left:3px solid var(--c)}
.rule[data-tier="future"]{border-left:3px solid var(--f)}
.rule header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:8px}
.rid{font:600 12px/1 ui-monospace,Menlo,monospace;background:var(--code-bg);color:var(--muted);
  padding:5px 7px;border-radius:5px;text-decoration:none}
.rule h3{font-size:17px;margin:0;flex:1;min-width:min(100%,20ch);letter-spacing:-.01em}
.pill{font-size:11px;padding:3px 8px;border-radius:999px;white-space:nowrap;border:1px solid var(--line);color:var(--muted)}
.pill-hero{background:var(--a-bg);color:var(--a);border-color:transparent;font-weight:600}
.pill-warn{background:var(--b-bg);color:var(--b);border-color:transparent}
.pill-applied{background:var(--f-bg);color:var(--f);border-color:transparent}
.summary{margin:0 0 10px}
.impact{margin:0 0 12px;color:var(--muted)}
.impact strong{color:var(--ink)}
.kv,.detect{display:flex;gap:10px;font-size:14px;margin:8px 0;align-items:baseline}
.k{flex:0 0 74px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em;padding-top:2px}
.v{flex:1;min-width:0}
.arrow{color:var(--muted);font-size:13px}
.detect{border-top:1px dashed var(--line);padding-top:10px;margin-top:12px}
.tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:5px;background:var(--code-bg);color:var(--muted);margin-left:4px;white-space:nowrap}
.tag-model-list,.tag-vapix-param{background:var(--c-bg);color:var(--c)}
.tag-eap-binary,.tag-client-side{background:var(--b-bg);color:var(--b)}
.tag-status-designed{background:var(--c-bg);color:var(--c)}
.tag-status-open{background:var(--b-bg);color:var(--b)}
.tag-status-verified{background:var(--a-bg);color:var(--a)}
.tag-blocked{background:var(--b-bg);color:var(--b)}
.correction{background:var(--b-bg);border-radius:8px;padding:12px 14px;font-size:14px;margin:12px 0 0}
.note{font-size:14px;color:var(--muted);margin:10px 0 0}
.src{display:inline-block;margin-top:12px;font-size:13px;text-decoration:none}
.src:hover{text-decoration:underline}
.models{margin:10px 0}
.models summary{cursor:pointer;font-size:13px;color:var(--muted)}
.modelgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:4px 12px;
  margin-top:10px;font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--muted)}

/* checker */
.checker{border:1px solid var(--line);border-radius:10px;background:var(--surface);
  padding:24px 26px;margin:0 0 32px}
.checker h2{margin:0 0 8px;font-size:19px}
.ck-lede{color:var(--muted);max-width:70ch;margin:0 0 18px}
.ck-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
#ck-model{flex:1;min-width:220px}
#ck-model,#ck-os{background:var(--bg);border:1px solid var(--line);color:var(--ink);
  border-radius:7px;padding:11px 14px;font-size:15px;font-family:inherit}
#ck-model:focus,#ck-os:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.ck-out:empty{display:none}
.ck-hint{font-size:13px;color:var(--muted);margin:12px 0 0}
.ck-out{display:grid;gap:10px}
.ck-card{border-left:3px solid var(--line);background:var(--bg);border-radius:0 7px 7px 0;padding:13px 16px}
.ck-card.bad{border-left-color:var(--a);background:var(--a-bg)}
.ck-card.warn{border-left-color:var(--b);background:var(--b-bg)}
.ck-card.ok{border-left-color:var(--c);background:var(--c-bg)}
.ck-card h4{margin:0 0 4px;font-size:15px}
.ck-card p{margin:0;font-size:14px;color:var(--muted)}
.ck-card a{font-size:13px}

/* scanner */
.scanner{border:1px solid var(--line);border-radius:10px;padding:22px 24px;margin:44px 0;background:var(--surface)}
.scanner h2{margin:0 0 12px;font-size:18px}
.scanner p{max-width:74ch}
.ship{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:20px 0 4px}
.ship > div{border-top:2px solid var(--line);padding-top:10px}
.ship > div:first-child{border-top-color:var(--accent)}
.ship p{font-size:14px;color:var(--muted);margin:0}
.tagn{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
@media (max-width:640px){.ship{grid-template-columns:1fr}}

/* questions + footer */
.open{background:var(--accent-soft);border:1px solid var(--line);border-radius:10px;padding:20px 22px;margin:44px 0}
.open h2{margin:0 0 6px;font-size:18px}
.open > p{color:var(--muted);margin:0 0 16px;font-size:15px}
.open li{margin-bottom:12px}
.open .why{color:var(--muted);font-size:14px;display:block}
footer{border-top:1px solid var(--line);margin-top:56px;padding:28px 0 60px;color:var(--muted);font-size:14px}
footer a{color:var(--muted)}
.hidden{display:none !important}
@media (max-width:600px){
  .k{flex-basis:100%} .kv,.detect{flex-wrap:wrap}
  .filters{position:static}
}
</style>
</head>
<body>

<header class="top"><div class="wrap">
  <div class="brand">Pre<span>flight</span></div>
  <nav>
    <a href="#check">Check a model</a>
    <a href="#tiers">Rules</a>
    <a href="#scanner">Scanner</a>
    <a href="#open">Open questions</a>
    <a href="${esc(srcUrl('axis-os'))}" rel="noopener">Axis source</a>
    <button id="theme" type="button" aria-label="Toggle colour theme" title="Toggle theme">◐</button>
  </nav>
</div></header>

<main class="wrap">

<section class="hero">
  <h1>AXIS OS 13 doesn't warn you. It rolls back.</h1>
  <p class="lede">Point it at your Axis cameras and it tells you which ones will survive the upgrade — before you start it. Read-only. No agent, nothing installed on the camera.</p>

  <blockquote class="quote">
    <p>“If a re-installation of an ACAP results in an error… AXIS OS will initiate a rollback.”</p>
    <p>“Compatibility field with AXIS OS major versions now mandatory in manifest.”</p>
    <cite>— Axis, upcoming breaking changes</cite>
  </blockquote>

  <p class="punch">Read those together. The upgrade does not warn you and then proceed — <strong>it fails and reverts the camera</strong>, because of one application somebody installed years ago. With four hundred cameras you find this out one camera at a time, at night, in a maintenance window, with nothing telling you which application did it.</p>

  <div class="stats">
    ${counts.map(([t, n]) => `<div class="stat"><b>${n}</b>${t === 'future' ? '2028 items' : `Tier ${t} rules`}</div>`).join('')}
    <div class="stat"><b>${data.rules.find((r) => r.id === 'A5').models32bit.length}</b>32-bit models</div>
    <div class="stat"><b>${esc(data.rulesetVersion)}</b>ruleset · ${esc(data.generated)}</div>
  </div>
</section>

<section class="checker" id="check">
  <h2>Is your camera affected?</h2>
  <p class="ck-lede">Type a model. Everything is answered in your browser from the same
  <a href="/rules.json">rules.json</a> below — nothing is sent anywhere, and this page never asks for
  a camera, an address or a password.</p>
  <div class="ck-row">
    <input id="ck-model" type="search" list="ck-models" autocomplete="off" spellcheck="false"
           placeholder="Any Axis model &mdash; M3215-LVE, Q1656, M1137&hellip;" aria-label="Axis camera model">
    <select id="ck-os" aria-label="Current AXIS OS version">
      <option value="">AXIS OS version…</option>
      <option value="12">AXIS OS 12.x</option>
      <option value="11">AXIS OS 11.x</option>
      <option value="10">AXIS OS 10.x or older</option>
      <option value="13">Already on 13</option>
    </select>
  </div>
  <datalist id="ck-models">${Object.keys(chipsets.chipsets).sort().map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
  <div id="ck-out" class="ck-out" role="status" aria-live="polite"></div>
  <p class="ck-hint">${Object.keys(chipsets.chipsets).length} models, matched by chipset — which is what
  decides the architecture, and therefore the answer Axis's own 58-model list gets wrong for some cameras.
  Chipset data from <a href="https://camstreamer.com/download-app-all-supported-cameras">CamStreamer's
  supported-cameras list</a>.</p>
  <p class="note">This checks what a model and a firmware version can tell you on their own. What
  actually decides whether a camera rolls back is which applications are installed on it — and that
  needs a scan of the device itself.</p>
</section>

<div class="filters"><div class="wrap">
  <label>Tier</label>
  ${TIER_ORDER.map((t) => `<button class="f" data-filter="tier" data-value="${t}" aria-pressed="false">${t === 'future' ? '2028' : t}</button>`).join('')}
  <label>OS</label>
  ${versions.map((v) => `<button class="f" data-filter="version" data-value="${esc(v)}" aria-pressed="false">${esc(v)}</button>`).join('')}
  <input id="q" type="search" placeholder="Search parameter, CGI, model…" aria-label="Search rules">
  <span id="count"></span>
</div></div>

<div id="tiers">
${bySection}
</div>

<section class="scanner" id="scanner">
  <h2>There is a scanner</h2>
  <p>The rules above are checked automatically, per camera, read-only — no agent, nothing installed
  on the camera, no credentials leaving your network. It reads the installed-application list and a
  handful of parameters, the same calls any Axis tool makes, and answers one question per device:
  <em>will upgrade</em>, <em>will roll back</em>, or <em>unknown</em>.</p>
  <p><strong>Unknown is not a pass.</strong> Firmware older than about AXIS OS 12 does not publish the
  per-application fields two of these rules depend on. Those cameras report unknown rather than a
  clean bill of health, because a false all-clear is the one answer that would make the tool worse
  than not running it.</p>
  <div class="ship">
    <div><span class="mono tagn">now</span><p>${data.rules.filter((r) => r.detection.status === 'verified').length} of the ${data.rules.length} rules are bench-verified and checked automatically. Command-line, macOS and Linux.</p></div>
    <div><span class="mono tagn">next</span><p>Signed downloads for macOS and Windows — nothing to install, no runtime to set up.</p></div>
    <div><span class="mono tagn">then</span><p>A signed ACAP: install it on one camera you already have, and it checks the rest of the subnet from inside the network.</p></div>
  </div>
  <p class="note">Every detection is free. There is no paid tier holding back the rollback answer —
  the point of this is that fleets get checked before September, not that a scanner gets sold.</p>
</section>

<section class="open" id="open">
  <h2>Open questions</h2>
  <p>Things this ruleset does not yet know. Listed because a rules page that hides its own gaps is worth less than one that names them.</p>
  <ol>
    ${data.openQuestions
      .map(
        (q) => `<li><strong>${esc(q.id)}.</strong> ${esc(q.question)}
      <span class="why">${esc(q.why)} Blocks ${q.blocks.map((b) => `<a href="#${esc(b)}">${esc(b)}</a>`).join(', ')}.</span></li>`
      )
      .join('\n    ')}
  </ol>
</section>

</main>

<footer><div class="wrap">
  <p>Every rule on this page cites public Axis documentation. Nothing here comes from a support ticket or a named installation.</p>
  <p>Ruleset ${esc(data.rulesetVersion)}, generated ${esc(data.generated)} from <a href="/rules.json"><code>rules.json</code></a> — the same file the scanner reads. Take it, cite it, argue with it. ${esc(data.owner)}.</p>

</div></footer>

<script>
(function(){
  var RULES = ${JSON.stringify(data.rules.map((r) => ({ id: r.id, tier: r.tier, version: r.version })))};
  var root=document.documentElement, btn=document.getElementById('theme');
  try{ var s=localStorage.getItem('preflight-theme'); if(s) root.dataset.theme=s;
       else if(matchMedia('(prefers-color-scheme: dark)').matches) root.dataset.theme='dark'; }catch(e){}
  btn.addEventListener('click',function(){
    root.dataset.theme = root.dataset.theme==='dark' ? 'light' : 'dark';
    try{ localStorage.setItem('preflight-theme', root.dataset.theme); }catch(e){}
  });

  var rules=[].slice.call(document.querySelectorAll('.rule'));
  var q=document.getElementById('q'), count=document.getElementById('count');
  var active={tier:new Set(), version:new Set()};

  function apply(){
    var term=q.value.trim().toLowerCase(), shown=0;
    rules.forEach(function(el){
      var ok = (!active.tier.size    || active.tier.has(el.dataset.tier))
            && (!active.version.size || active.version.has(el.dataset.version))
            && (!term || el.textContent.toLowerCase().indexOf(term) > -1);
      el.classList.toggle('hidden', !ok);
      if(ok) shown++;
    });
    document.querySelectorAll('.tier').forEach(function(sec){
      sec.classList.toggle('hidden', !sec.querySelector('.rule:not(.hidden)'));
    });
    count.textContent = shown === rules.length ? rules.length+' rules' : shown+' of '+rules.length;
  }

  // ---- model / firmware checker -----------------------------------------
  var CHIPS = ${JSON.stringify(chipsets.chipsets)};
  var MODELS32 = ${JSON.stringify(data.rules.find((r) => r.id === 'A5').models32bit)};
  var NONVIDEO = ${JSON.stringify(data.rules.find((r) => r.id === 'C7').modelsAffected)};
  var mi=document.getElementById('ck-model'), os=document.getElementById('ck-os'), out=document.getElementById('ck-out');

  // Match generously: people type "Q1656" for "AXIS Q1656-LE", and the published
  // lists use the full marketing name. Compare on letters and digits only.
  function norm(s){ return String(s).toUpperCase().replace(/^AXIS /,'').replace(/[^A-Z0-9]/g,''); }

  function card(cls,title,body,link){
    return '<div class="ck-card '+cls+'"><h4>'+title+'</h4><p>'+body+
      (link?' <a href="#'+link+'">'+link+' →</a>':'')+'</p></div>';
  }

  function check(){
    var q=(mi.value||'').trim(), v=os.value, html='';
    if(!q && !v){ out.innerHTML=''; return; }

    if(q){
      var n=norm(q);
      if(n.length<3){ out.innerHTML=''; return; }

      // Chipset first: it decides the ACAP architecture, so it answers A5 for the
      // whole catalogue rather than only the models Axis chose to name.
      var chip=null, chipModel=null;
      for(var key in CHIPS){
        var k=norm(key);
        if(k===n){ chip=CHIPS[key]; chipModel=key; break; }
        if(!chip && (k.indexOf(n)>-1 || n.indexOf(k)>-1)){ chip=CHIPS[key]; chipModel=key; }
      }
      // Substring, not prefix: people type "6075" for "AXIS Q6075-SE". Minimum three
      // characters, because two would match half the catalogue.
      var match=function(m){ var k=norm(m); return k===n || k.indexOf(n)>-1 || n.indexOf(k)>-1; };
      var hit32=MODELS32.filter(match);
      var hitNV=NONVIDEO.filter(match);

      var listed = hit32.length ? ' Axis also names it directly: '+hit32.join(', ')+'.' : '';

      if(chip==='ARTPEC-8' || chip==='ARTPEC-9'){
        html+=card('ok','64-bit — not exposed to the Y2038 ABI break',
          chipModel+' is '+chip+', which runs 64-bit ACAPs (aarch64). The time_t change in AXIS OS 13 does '+
          'not force a rebuild here.'+listed,'A5');
      } else if(chip==='ARTPEC-6/7'){
        html+=card('bad','32-bit — exposed to the Y2038 ABI break',
          chipModel+' is '+chip+', which runs 32-bit ACAPs (armv7hf). AXIS OS 13 moves to 64-bit time_t, so '+
          'every ACAP on this camera must be rebuilt against the new ABI or removed before you upgrade.'+
          (hit32.length ? listed : ' Note that Axis does not name this model on its 32-bit list — the bench '+
          'confirmed an M1137 reporting armv7hf while absent from it, which is why this checks the chipset.'),'A5');
      } else if(chip){
        html+=card('warn','Older or non-ARTPEC platform — check the lifecycle first',
          chipModel+' is '+chip+'. Before worrying about breaking changes, confirm this product receives '+
          'current AXIS OS releases at all; many older platforms are on a long-term-support track and will '+
          'never be offered AXIS OS 13. Read Properties.System.Architecture on the device for the definitive answer.','A5');
      } else if(hit32.length){
        html+=card('bad','32-bit — exposed to the Y2038 ABI break',
          'Axis lists '+hit32.join(', ')+' among the 32-bit products. AXIS OS 13 moves to 64-bit time_t, so '+
          'every ACAP on this camera must be rebuilt against the new ABI or removed before you upgrade.','A5');
      } else {
        html+=card('','Model not recognised',
          'Not in the chipset table, and not named on the Axis 32-bit list either. Read '+
          'Properties.System.Architecture on the device — armv7hf is exposed, aarch64 is not.','A5');
      }
      if(hitNV.length){
        html+=card('warn','Non-video product — StreamCache.Size is removed',
          'root.StreamCache.Size no longer exists on '+hitNV.join(', ')+'. Configuration tooling that sets it will error.','C7');
      }
    }

    if(v){
      var maj=parseInt(v,10);
      if(maj>=13){
        html+=card('ok','Already on AXIS OS 13',
          'The breaking changes below have already applied to this camera. What is left to watch is the '+
          'AXIS OS 14 wave in September 2028.','');
      } else if(maj<12){
        html+=card('bad','Older than AXIS OS 12 — the scan cannot answer for you',
          'This firmware does not publish per-application compatibility or signature status, so nothing '+
          'read from the camera can tell you whether its applications survive the upgrade. Treat it as '+
          'unverified, never as safe, and check each application with its vendor.','A1');
      } else {
        html+=card('ok','Reports what the checks need',
          'AXIS OS '+v+' publishes CompatibleOsVersions and SignatureStatus per application, so a read-only '+
          'scan can answer whether this camera rolls back.','A1');
      }
      var applies=RULES.filter(function(r){ return r.tier!=='future' && parseFloat(r.version)>maj; }).length;
      if(applies>0){
        html+=card('', applies + ' documented changes land between AXIS OS '+v+' and 13',
          'Filter the list below by version to read them.','');
      }
    }
    out.innerHTML=html;
  }
  mi.addEventListener('input',check); os.addEventListener('change',check); check();

  document.querySelectorAll('button.f').forEach(function(b){
    b.addEventListener('click',function(){
      var set=active[b.dataset.filter], on=b.getAttribute('aria-pressed')==='true';
      if(on) set.delete(b.dataset.value); else set.add(b.dataset.value);
      b.setAttribute('aria-pressed', String(!on));
      apply();
    });
  });
  q.addEventListener('input', apply);
  apply();
})();
</script>
</body>
</html>
`;

/** Everything the public site consists of. Anything else in dist/ fails the build. */
const PUBLIC_FILES = new Set([
  'index.html', '404.html', 'rules.json',
  'favicon.svg', 'og.svg', 'og.png',
  '_headers', 'robots.txt', 'sitemap.xml',
]);

const DIST = dirname(OUT);
mkdirSync(DIST, { recursive: true });
writeFileSync(OUT, html);

// Everything below makes dist/ a complete, deployable site rather than one page.
const write = (name, content) => writeFileSync(resolve(DIST, name), content);

// The ruleset itself, served. It is the artefact worth citing, and a page that
// asks to be argued with should hand over the data it argues from.
write('rules.json', JSON.stringify(data, null, 2));

// Paper-plane mark. Inline SVG so there is no extra request and no binary in git.
write(
  'favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#c2410c"/>
  <path d="M25 7 6.5 15.2a.6.6 0 0 0 .05 1.11l4.9 1.72 1.72 4.9a.6.6 0 0 0 1.11.05L25 7Z" fill="#fff"/>
  <path d="M25 7 11.45 18.03" stroke="#c2410c" stroke-width="1.1" fill="none"/>
</svg>`
);

// Social card, drawn rather than photographed — same palette as the page.
write(
  'og.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f7f7f5"/>
  <rect x="0" y="0" width="14" height="630" fill="#b91c1c"/>
  <text x="80" y="150" font-family="Helvetica,Arial,sans-serif" font-size="26" letter-spacing="4" fill="#c2410c">PREFLIGHT · 4XS.DEV</text>
  <text x="80" y="270" font-family="Helvetica,Arial,sans-serif" font-size="72" font-weight="bold" fill="#16181d">AXIS OS 13 doesn't warn you.</text>
  <text x="80" y="352" font-family="Helvetica,Arial,sans-serif" font-size="72" font-weight="bold" fill="#b91c1c">It rolls back.</text>
  <text x="80" y="440" font-family="Helvetica,Arial,sans-serif" font-size="30" fill="#5c6270">${data.rules.length} documented breaking changes, sorted by what they cost you.</text>
  <text x="80" y="486" font-family="Helvetica,Arial,sans-serif" font-size="30" fill="#5c6270">Every rule cites Axis. Ruleset ${data.rulesetVersion}.</text>
  <text x="80" y="566" font-family="monospace" font-size="26" fill="#c2410c">preflight.4xs.dev</text>
</svg>`
);

// Cloudflare Pages headers. The CSP is tight because the page loads nothing
// external — no fonts, no analytics, no CDN — so anything that tries to is a bug
// or a compromise, and should fail loudly rather than quietly work.
write(
  '_headers',
  `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN
  Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'
  Permissions-Policy: geolocation=(), microphone=(), camera=()

/rules.json
  Content-Type: application/json; charset=utf-8
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300, must-revalidate

/*.svg
  Cache-Control: public, max-age=86400

/
  Cache-Control: public, max-age=300, must-revalidate
`
);

write(
  'robots.txt',
  `User-agent: *
Allow: /
Sitemap: ${SITE}/sitemap.xml
`
);

write(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc><lastmod>${data.generated}</lastmod><changefreq>monthly</changefreq><priority>1.0</priority></url>
</urlset>
`
);

// A 404 that routes people to the thing they were probably looking for.
write(
  '404.html',
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found — Preflight</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f5;color:#16181d;
  font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;padding:24px}
@media (prefers-color-scheme:dark){body{background:#131417;color:#e8e8e6}}
h1{font-size:22px;margin:0 0 10px;letter-spacing:-.01em}
p{margin:0 0 18px;opacity:.72;max-width:46ch}
a{color:#c2410c}
</style></head><body><main>
<h1>That page isn't here.</h1>
<p>The AXIS OS 13 breaking-change rules — all ${data.rules.length} of them, each citing Axis — are on the front page.</p>
<p><a href="/">Go to the rules</a> · <a href="/rules.json">rules.json</a></p>
</main></body></html>
`
);

// The page's behaviour lives in an inline <script>. A syntax error there leaves the
// checker silently dead — the HTML looks perfect and nothing happens when you type.
// One escaped apostrophe did exactly that, so the script is parsed at build time.
for (const [i, body] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  try {
    new Function(body[1]);
  } catch (err) {
    console.error(`\n✗ Inline script #${i + 1} does not parse: ${err.message}`);
    console.error('  The page would render and the checker would silently do nothing.');
    process.exit(1);
  }
}

// Guard: dist/ is published verbatim, so anything that lands here is public.
// The pitch deck used to build into this directory and would have gone live at
// /deck.html without anyone deciding it should.
const strays = readdirSync(DIST).filter((f) => !PUBLIC_FILES.has(f));
if (strays.length > 0) {
  console.error(`\n✗ Unexpected files in ${DIST} — this directory is published as-is:`);
  for (const f of strays) console.error(`    ${f}`);
  console.error('  Remove them, or add them to PUBLIC_FILES in build.mjs if they belong on the site.');
  process.exit(1);
}

console.log(
  `✓ ${data.rules.length} rules → ${OUT} (${(html.length / 1024).toFixed(0)} kB)\n` +
    `  + ${[...PUBLIC_FILES].filter((f) => f !== 'index.html').sort().join(', ')}`
);
