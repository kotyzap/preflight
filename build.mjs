#!/usr/bin/env node
// Preflight — renders rules.json to a static page. Zero dependencies.
// Usage: node build.mjs [--out dist/index.html]

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the latter keeps %20, so a path with a space
// ("External SSD") pointed at a directory that does not exist.
const ROOT = dirname(fileURLToPath(import.meta.url));
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

  // <details>: collapsed shows id, title, pills and a two-line summary; the
  // evidence opens on demand. The hero rule starts open.
  return `<details class="rule" id="${esc(r.id)}" data-tier="${esc(r.tier)}" data-version="${esc(r.version)}" data-method="${esc(det.method ?? 'none')}"${r.hero ? ' open' : ''}>
  <summary>
  <span class="rhead">
    <a class="rid" href="#${esc(r.id)}">${esc(r.id)}</a>
    <h3>${esc(r.title)}</h3>
    <span class="pills"><span class="pill pill-ver">OS ${esc(r.version)}</span>${applied}${hero}${conf}</span>
    <span class="chev" aria-hidden="true"></span>
  </span>
  <p class="summary">${esc(r.summary)}</p>
  </summary>
  <div class="rbody">
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
  </div>
</details>`;
}

const tierName = (t) => (t === 'future' ? '2028' : `Tier ${t}`);

const bySection = TIER_ORDER.map((t) => {
  const rules = data.rules.filter((r) => r.tier === t);
  if (!rules.length) return '';
  return `<section class="tier" id="tier-${t}" data-tier="${t}">
  <div class="tierhead">
    <h2><span class="tierbadge tb-${t}">${tierName(t)}</span> ${esc(tierMeta[t].label)} <span class="tiercount">${rules.length}</span></h2>
    <p class="tierblurb">${esc(tierMeta[t].blurb)}</p>
  </div>
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
<title>Preflight for OS 13 — will your Axis cameras survive the upgrade?</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<link rel="canonical" href="${SITE}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}/">
<meta property="og:site_name" content="Preflight for OS 13">
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
  --bg:#eef0f3; --band:#f7f8fa; --surface:#fff; --ink:#16181d; --muted:#5c6270; --line:#dfe2e7; --line-soft:#eceef1;
  --accent:#c2410c; --accent-soft:#fff1e9; --accent-line:#fbd5bf;
  --a:#b91c1c; --a-bg:#fef2f2; --b:#b45309; --b-bg:#fffbeb; --c:#1d4ed8; --c-bg:#eff6ff; --f:#4b5563; --f-bg:#f3f4f6;
  --code-bg:#f1f2f4;
  --deep:#16181d; --deep-ink:#eceef2; --deep-muted:#a3a9b6; --deep-line:#2c3038;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);
  --shadow-lg:0 4px 10px rgba(16,24,40,.06),0 12px 32px rgba(16,24,40,.08);
}
html[data-theme="dark"]{
  --bg:#0f1013; --band:#15171b; --surface:#1c1f24; --ink:#e8e8e6; --muted:#9aa1ae; --line:#2b2e35; --line-soft:#24272d;
  --accent:#fb923c; --accent-soft:#2a1a10; --accent-line:#4a2a14;
  --a:#f87171; --a-bg:#2a1618; --b:#fbbf24; --b-bg:#2a2110; --c:#7dabff; --c-bg:#141d2e; --f:#9ca3af; --f-bg:#212429;
  --code-bg:#262a31;
  --deep:#1f232a; --deep-ink:#eceef2; --deep-muted:#a3a9b6; --deep-line:#343944;
  --shadow:0 1px 2px rgba(0,0,0,.4);
  --shadow-lg:0 8px 28px rgba(0,0,0,.45);
}
*{box-sizing:border-box}
html{scroll-padding-top:128px}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1160px;margin:0 auto;padding:0 24px}
.narrow > *{max-width:860px}
a{color:var(--accent)}
code{background:var(--code-bg);padding:.1em .35em;border-radius:4px;
  font:.86em/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}

/* section scaffolding: every part of the page is its own full-width band */
.band{padding:64px 0;border-top:1px solid var(--line)}
.band-head{margin:0 0 28px}
.eyebrow{display:inline-block;font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;
  color:var(--accent);margin-bottom:10px}
.band-head h2{font-size:clamp(24px,3vw,30px);line-height:1.2;letter-spacing:-.02em;margin:0 0 10px}
.band-head p{color:var(--muted);margin:0;font-size:17px}

/* header */
.top{border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--surface) 88%,transparent);
  backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px);position:sticky;top:0;z-index:20}
.top .wrap{display:flex;align-items:center;gap:16px;height:60px}
.brand{font-weight:700;letter-spacing:-.01em;font-size:17px;display:flex;align-items:center;gap:9px;color:var(--ink);text-decoration:none}
.brand i{width:26px;height:26px;border-radius:7px;background:var(--accent);display:grid;place-items:center}
.brand i svg{width:16px;height:16px}
.brand span{color:var(--accent)}
.top nav{margin-left:auto;display:flex;gap:4px;align-items:center;font-size:14px}
.top nav a{color:var(--muted);text-decoration:none;padding:7px 11px;border-radius:7px}
.top nav a:hover{color:var(--ink);background:var(--code-bg)}
#theme{background:var(--surface);border:1px solid var(--line);color:var(--muted);border-radius:8px;margin-left:6px;
  width:34px;height:34px;cursor:pointer;font-size:15px;line-height:1}
#theme:hover{color:var(--ink);border-color:var(--muted)}
@media (max-width:760px){ .top nav a.opt{display:none} }
@media (max-width:420px){ .top nav a{padding:7px 7px} }

/* hero */
.hero{padding:48px 0 56px;border-top:0;
  background:radial-gradient(1000px 420px at 85% -10%,var(--accent-soft),transparent 70%),var(--band)}
.hero-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:48px;align-items:start}
.hero h1{font-size:clamp(32px,4.6vw,52px);line-height:1.08;letter-spacing:-.03em;margin:0 0 20px;max-width:16ch}
.hero h1 em{font-style:normal;color:var(--a)}
.lede{font-size:19px;color:var(--muted);max-width:52ch;margin:0 0 24px}
.quote{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--a);padding:20px 22px;
  border-radius:10px;margin:0 0 18px;box-shadow:var(--shadow)}
.quote p{margin:0 0 10px;font-size:16px}
.quote p:last-child{margin:0}
.quote cite{font-style:normal;font-size:13px;color:var(--muted)}
.punch{font-size:17px;margin:0 0 16px}
.band-scan .scan-body p.punch{color:var(--deep-ink)}
.punch strong{color:#f87171}
.acap-card{background:var(--deep);color:var(--deep-ink);border-radius:12px;padding:22px 24px;box-shadow:var(--shadow-lg)}
.acap-tag{display:inline-block;font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;
  color:#fdba74;border:1px solid rgba(251,146,60,.45);background:rgba(251,146,60,.10);border-radius:999px;padding:6px 10px;margin-bottom:12px}
.acap-card h3{font-size:20px;line-height:1.25;letter-spacing:-.01em;margin:0 0 8px;color:#fff}
.acap-card p{font-size:14px;color:var(--deep-muted);margin:0 0 16px}
.acap-card em{color:var(--deep-ink)}
.acap-actions{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}
.acap-card a.ck-go{color:#fff}
.beta-dlg{border:1px solid var(--line);border-radius:14px;padding:0;width:min(560px,calc(100vw - 32px));
  background:var(--surface);color:var(--ink);box-shadow:var(--shadow-lg)}
.beta-dlg::backdrop{background:rgba(15,16,19,.55)}
.beta-dlg form{padding:24px 26px;display:grid;gap:12px}
.beta-dlg h3{margin:0;font-size:20px;letter-spacing:-.01em}
.beta-sub{margin:0 0 4px;color:var(--muted);font-size:14px}
.beta-dlg label{display:grid;gap:5px;font-size:13px;font-weight:600;color:var(--ink)}
.beta-dlg input,.beta-dlg select,.beta-dlg textarea{font:15px/1.4 inherit;font-family:inherit;color:var(--ink);background:var(--band);
  border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-weight:400}
.beta-dlg textarea{resize:vertical}
.beta-dlg input:focus,.beta-dlg select:focus,.beta-dlg textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
.beta-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.req{color:var(--a)}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.beta-status{margin:0;font-size:14px}
.beta-status:empty{display:none}
.beta-status.err{color:var(--a)}
.beta-actions{display:flex;justify-content:flex-end;gap:10px;align-items:center}
.beta-dlg button.ck-go{border:0;cursor:pointer;font-family:inherit}
.beta-dlg button.ck-go[disabled]{opacity:.6;cursor:wait}
.beta-cancel{background:none;border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:9px 14px;font:14px inherit;font-family:inherit;cursor:pointer}
.beta-done{text-align:center;padding:12px 0}
@media (max-width:520px){.beta-2{grid-template-columns:1fr}.beta-dlg form{padding:20px 18px}}
.acap-more{color:#fdba74;font-size:14px;text-decoration:none}
.acap-more:hover{text-decoration:underline}
.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:44px 0 0}
.stat{background:var(--surface);border:1px solid var(--line);border-top:3px solid var(--line);border-radius:10px;
  padding:14px 16px;font-size:13px;color:var(--muted);text-decoration:none;box-shadow:var(--shadow)}
a.stat:hover{border-color:var(--muted)}
.stat b{font-size:26px;display:block;line-height:1.15;color:var(--ink);letter-spacing:-.02em}
.stat.s-A{border-top-color:var(--a)} .stat.s-B{border-top-color:var(--b)}
.stat.s-C{border-top-color:var(--c)} .stat.s-future{border-top-color:var(--f)}
@media (max-width:900px){ .hero-grid{grid-template-columns:1fr;gap:28px} .stats{grid-template-columns:repeat(3,minmax(0,1fr))} }
@media (max-width:480px){ .stats{grid-template-columns:repeat(2,minmax(0,1fr))} .hero{padding-top:44px} }

/* checker */
.checker{border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:var(--shadow-lg);
  padding:22px 24px}
.ck-title{font-size:19px;margin:0 0 4px;letter-spacing:-.01em}
.ck-lede{font-size:14px;color:var(--muted);margin:0 0 14px}
.ck-sum{border:1px solid var(--accent-line);border-left:4px solid var(--accent);background:var(--surface);border-radius:10px;padding:14px 18px}
.ck-sum h4{margin:0 0 8px;font-size:16px}
.ck-sum .tiers{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.ck-sum p{margin:0 0 10px;font-size:13px;color:var(--muted)}
.relbar{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;background:var(--accent-soft);border:1px solid var(--accent-line);
  border-radius:12px;padding:10px 14px;margin:0 0 10px;font-size:14px}
.relbar button{margin-left:auto;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:999px;
  padding:5px 12px;font-size:13px;cursor:pointer;font-family:inherit}
.ck-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
#ck-model{flex:1;min-width:220px}
#ck-model,#ck-os{background:var(--band);border:1px solid var(--line);color:var(--ink);
  border-radius:9px;padding:13px 15px;font-size:16px;font-family:inherit}
#ck-model:focus,#ck-os:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.ck-out:empty{display:none}
.ck-hint{font-size:13px;color:var(--muted);margin:16px 0 0}
.ck-cta{border:1px solid var(--accent-line);background:var(--accent-soft);border-radius:10px;padding:18px 20px;margin-top:4px}
.ck-cta h4{margin:0 0 6px;font-size:15px}
.ck-cta p{margin:0 0 14px;font-size:14px;max-width:74ch}
.ck-go{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;
  border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600}
.ck-go:hover{filter:brightness(1.08)}
.ck-out{display:grid;gap:10px}
.ck-card{border:1px solid var(--line);border-left:4px solid var(--line);background:var(--band);border-radius:10px;padding:14px 18px}
.ck-card.bad{border-color:transparent;border-left-color:var(--a);background:var(--a-bg)}
.ck-card.nopath{border-color:transparent;border-left-color:var(--c);background:var(--c-bg)}
.ck-card.nopath b{color:var(--c)}
.ck-card.warn{border-color:transparent;border-left-color:var(--b);background:var(--b-bg)}
.ck-card.ok{border-color:transparent;border-left-color:var(--c);background:var(--c-bg)}
.ck-card h4{margin:0 0 4px;font-size:15px}
.ck-card p{margin:0;font-size:14px;color:var(--muted)}
.ck-card a{font-size:13px}

/* rules: sidebar + column */
.band-rules{background:var(--band)}
.rules-grid{display:grid;grid-template-columns:220px minmax(0,1fr);gap:36px;align-items:start}
.toc{position:sticky;top:84px;font-size:14px}
.toc h4{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.toc a{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;padding:8px 10px;border-radius:8px}
.toc a:hover{background:var(--surface)}
.toc .dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px}
.toc .n{margin-left:auto;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.toc hr{border:0;border-top:1px solid var(--line);margin:12px 0}
.dot-A{background:var(--a)} .dot-B{background:var(--b)} .dot-C{background:var(--c)} .dot-future{background:var(--f)}
@media (max-width:1000px){ .rules-grid{grid-template-columns:minmax(0,1fr)} .toc{display:none} }

.filters{position:sticky;top:72px;z-index:10;background:var(--surface);border:1px solid var(--line);border-radius:12px;
  box-shadow:var(--shadow);padding:12px 14px;margin-bottom:8px;display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center}
.fgroup{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.filters label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-right:2px}
button.f,#expand{background:var(--band);border:1px solid var(--line);color:var(--muted);
  border-radius:999px;padding:5px 12px;font-size:13px;cursor:pointer;font-family:inherit}
button.f:hover,#expand:hover{color:var(--ink);border-color:var(--muted)}
button.f[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.fsearch{display:flex;gap:8px;align-items:center;flex:1 1 260px}
#q{flex:1;min-width:140px;background:var(--band);border:1px solid var(--line);color:var(--ink);
  border-radius:999px;padding:7px 14px;font-size:14px;font-family:inherit}
#q:focus{outline:2px solid var(--accent);outline-offset:1px}
#count{font-size:13px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}

.tier{margin:36px 0 0}
.tierhead{margin:0 0 14px;padding:0 0 0 2px}
.tier h2{font-size:21px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 6px;letter-spacing:-.01em}
.tiercount{font-size:12px;font-weight:600;color:var(--muted);background:var(--surface);border:1px solid var(--line);
  border-radius:999px;padding:1px 9px}
.tierbadge{font-size:12px;font-weight:700;padding:4px 10px;border-radius:6px;letter-spacing:.02em}
.tb-A{background:var(--a-bg);color:var(--a)} .tb-B{background:var(--b-bg);color:var(--b)}
.tb-C{background:var(--c-bg);color:var(--c)} .tb-future{background:var(--f-bg);color:var(--f)}
.tierblurb{color:var(--muted);margin:0;max-width:70ch}

.rule{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;
  margin:0 0 10px;box-shadow:var(--shadow);transition:border-color .15s}
.rule[data-tier="A"]{border-left-color:var(--a)}
.rule[data-tier="B"]{border-left-color:var(--b)}
.rule[data-tier="C"]{border-left-color:var(--c)}
.rule[data-tier="future"]{border-left-color:var(--f)}
.rule > summary{list-style:none;cursor:pointer;padding:16px 20px 14px}
.rule > summary::-webkit-details-marker{display:none}
.rule > summary:hover h3{color:var(--accent)}
.rule > summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:8px}
.rhead{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin-bottom:6px}
.rid{font:600 12px/1 ui-monospace,Menlo,monospace;background:var(--code-bg);color:var(--muted);
  padding:5px 7px;border-radius:5px;text-decoration:none}
.rule h3{font-size:17px;margin:0;flex:1;min-width:min(100%,20ch);letter-spacing:-.01em;line-height:1.35}
.pills{display:flex;flex-wrap:wrap;gap:6px}
.chev{width:22px;height:22px;flex:0 0 22px;border-radius:6px;display:grid;place-items:center;color:var(--muted)}
.chev::before{content:"";width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;
  transform:translateY(-2px) rotate(45deg);transition:transform .15s}
.rule[open] .chev::before{transform:translateY(2px) rotate(-135deg)}
.pill{font-size:11px;padding:3px 8px;border-radius:999px;white-space:nowrap;border:1px solid var(--line);color:var(--muted)}
.pill-hero{background:var(--a-bg);color:var(--a);border-color:transparent;font-weight:600}
.pill-warn{background:var(--b-bg);color:var(--b);border-color:transparent}
.pill-applied{background:var(--f-bg);color:var(--f);border-color:transparent}
.summary{margin:0;color:var(--muted);font-size:15px}
.rule:not([open]) .summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rule[open] .summary{color:var(--ink);font-size:16px}
.rbody{padding:4px 20px 18px;border-top:1px solid var(--line-soft);margin:0 0 0;padding-top:14px}
.impact{margin:0 0 12px;color:var(--muted)}
.impact strong{color:var(--ink)}
.kv,.detect{display:flex;gap:12px;font-size:14px;margin:8px 0;align-items:baseline}
.k{flex:0 0 84px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding-top:2px}
.v{flex:1;min-width:0}
.arrow{color:var(--muted);font-size:13px}
.detect{background:var(--band);border-radius:8px;padding:10px 12px;margin-top:14px}
.tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:5px;background:var(--code-bg);color:var(--muted);margin-left:4px;white-space:nowrap}
.tag-model-list,.tag-vapix-param{background:var(--c-bg);color:var(--c)}
.tag-eap-binary,.tag-client-side{background:var(--b-bg);color:var(--b)}
.tag-status-designed{background:var(--c-bg);color:var(--c)}
.tag-status-open{background:var(--b-bg);color:var(--b)}
.tag-status-verified{background:var(--a-bg);color:var(--a)}
.tag-blocked{background:var(--b-bg);color:var(--b)}
.correction{background:var(--b-bg);border-radius:8px;padding:12px 14px;font-size:14px;margin:12px 0 0}
.note{font-size:14px;color:var(--muted);margin:10px 0 0}
.src{display:inline-block;margin-top:12px;font-size:13px;text-decoration:none;font-weight:600}
.src:hover{text-decoration:underline}
.models{margin:10px 0}
.models summary{cursor:pointer;font-size:13px;color:var(--muted)}
.modelgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:4px 12px;
  margin-top:10px;font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--muted)}

/* scanner: the one dark band, so the product pitch reads as its own place */
.band-scan{background:var(--deep);color:var(--deep-ink);border-top-color:var(--deep)}
.band-scan .band-head p,.band-scan .scan-body p{color:var(--deep-muted)}
.band-scan .band-head h2{color:#fff}
.band-scan a{color:#fdba74}
.band-scan strong,.band-scan em{color:var(--deep-ink)}
.scan-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:40px;align-items:start}
.scan-body p{margin:0 0 16px;max-width:66ch}
.avail{background:rgba(251,146,60,.10);border:1px solid rgba(251,146,60,.45);border-radius:10px;padding:16px 18px;font-size:14px;margin:0 0 16px}
.band-scan .avail p{margin:0 0 14px;color:var(--deep-ink)}
.band-scan a.ck-go{color:#fff}
.band-scan .avail{color:var(--deep-ink)}
.ship{display:grid;gap:12px}
.ship > div{border:1px solid var(--deep-line);border-radius:12px;padding:16px 18px;background:rgba(255,255,255,.03)}
.ship > div:first-child{border-color:#fb923c;background:rgba(251,146,60,.08)}
.ship p{font-size:14px;margin:0;color:var(--deep-muted)}
.tagn{display:block;font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#fdba74;margin-bottom:8px}
.band-scan .note{color:var(--deep-muted);border-top:1px solid var(--deep-line);padding-top:18px;margin-top:28px;max-width:none}
@media (max-width:900px){.scan-grid{grid-template-columns:1fr;gap:24px}}

/* questions + footer */
.band-open{background:var(--bg)}
.open{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;counter-reset:q}
.open li{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px;box-shadow:var(--shadow)}
.open li strong{display:inline-block;font:600 12px/1 ui-monospace,Menlo,monospace;background:var(--accent-soft);color:var(--accent);
  padding:5px 7px;border-radius:5px;margin-right:6px}
.open .why{color:var(--muted);font-size:14px;display:block;margin-top:8px}
footer{background:var(--surface);border-top:1px solid var(--line);padding:32px 0 56px;color:var(--muted);font-size:14px}
footer a{color:var(--muted)}
.disclaimer{font-size:13px;border-top:1px solid var(--line);padding-top:14px;margin-top:18px}
.hidden{display:none !important}
@media (max-width:600px){
  .wrap{padding:0 16px}
  .band{padding:44px 0}
  .checker{padding:20px 18px}
  .k{flex-basis:100%} .kv,.detect{flex-wrap:wrap}
  .filters{position:static} .fsearch{flex-wrap:wrap} #q{min-width:0}
  .rule > summary{padding:14px 16px 12px} .rbody{padding:12px 16px 16px}
  .open{grid-template-columns:1fr}
}
</style>
</head>
<body>

<header class="top"><div class="wrap">
  <a class="brand" href="#top"><i><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M27 5 4.5 15a.7.7 0 0 0 .06 1.3l6 2.1 2.1 6a.7.7 0 0 0 1.3.06L27 5Z" fill="#fff"/></svg></i><b>Pre<span>flight</span></b></a>
  <nav>
    <a href="#check">Check a model</a>
    <a href="#tiers">Rules</a>
    <a class="opt" href="#scanner">Scanner</a>
    <a class="opt" href="#open">Open questions</a>
    <a class="opt" href="${esc(srcUrl('axis-os'))}" rel="noopener">Axis source ↗</a>
    <button id="theme" type="button" aria-label="Toggle colour theme" title="Toggle theme">◐</button>
  </nav>
</div></header>

<main id="top">

<section class="band hero"><div class="wrap">
  <div class="hero-grid">
    <div>
      <h1>AXIS OS 13 doesn't warn you. <em>It rolls back.</em></h1>
      <p class="lede">Point it at your Axis cameras and it tells you which ones will survive the upgrade — before you start it. Read-only. No agent, nothing installed on the camera.</p>
  <div class="checker" id="check">
  <h2 class="ck-title">Is your camera affected?</h2>
  <p class="ck-lede">Type a model. Answered in your browser from <a href="rules.json">rules.json</a> — nothing is sent anywhere, and this page never asks for a camera, an address or a password.</p>
  <div class="ck-row">
    <input id="ck-model" type="search" list="ck-models" autocomplete="off" spellcheck="false"
           placeholder="Camera model, e.g. Q1656" aria-label="Axis camera model">
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
  </div>
    </div>
    <div>
      <blockquote class="quote">
        <p>“If a re-installation of an ACAP results in an error… AXIS OS will initiate a rollback.”</p>
        <p>“Compatibility field with AXIS OS major versions now mandatory in manifest.”</p>
        <cite>— Axis, upcoming breaking changes</cite>
      </blockquote>
      <div class="acap-card">
        <span class="acap-tag">Preflight ACAP · v1.4.9, signed</span>
        <h3>Install it on one camera. It checks the whole network.</h3>
        <p>Add it through the camera's own Apps page. It finds every camera on that network and answers per device: <em>will upgrade</em>, <em>will roll back</em>, or <em>cannot be determined</em> — and names the applications responsible.</p>
        <div class="acap-actions"><a class="ck-go" href="https://github.com/kotyzap/preflight/releases/latest" target="_blank" rel="noopener">Download Preflight ACAP App →</a><a class="acap-more" href="#scanner">How it works ↓</a></div>
      </div>    </div>
  </div>

  <div class="stats">
    ${counts.map(([t, n]) => `<a class="stat s-${t}" href="#tier-${t}"><b>${n}</b>${t === 'future' ? '2028 items' : `Tier ${t} rules`}</a>`).join('')}
    <a class="stat" href="#A5"><b>${data.rules.find((r) => r.id === 'A5').models32bit.length}</b>32-bit models</a>
    <a class="stat" href="rules.json"><b>${esc(data.rulesetVersion)}</b>ruleset · ${esc(data.generated)}</a>
  </div>
</div></section>

<section class="band band-rules" id="tiers"><div class="wrap">
  <div class="band-head">
    <span class="eyebrow">01 · The rules</span>
    <h2>${data.rules.length} documented breaking changes, sorted by what they cost you</h2>
    <p>Click a rule to open its impact, detection method and Axis source. Filter by tier or AXIS OS version, or search for a parameter, CGI or model.</p>
  </div>
  <div class="rules-grid">
    <aside class="toc" aria-label="Rule tiers">
      <h4>Tiers</h4>
      ${counts.filter(([, n]) => n).map(([t, n]) => `<a href="#tier-${t}"><span class="dot dot-${t}"></span>${t === 'future' ? '2028 wave' : `Tier ${t}`}<span class="n">${n}</span></a>`).join('\n      ')}
      <hr>
      <a href="#scanner">Scanner</a>
      <a href="#open">Open questions</a>
      <a href="rules.json">rules.json</a>
    </aside>
    <div>
      <div id="relbar" class="relbar hidden" role="status"></div>
      <div class="filters">
        <div class="fgroup"><label>Tier</label>
        ${TIER_ORDER.map((t) => `<button class="f" data-filter="tier" data-value="${t}" aria-pressed="false">${t === 'future' ? '2028' : t}</button>`).join('')}</div>
        <div class="fgroup"><label>OS</label>
        ${versions.map((v) => `<button class="f" data-filter="version" data-value="${esc(v)}" aria-pressed="false">${esc(v)}</button>`).join('')}</div>
        <div class="fsearch">
          <input id="q" type="search" placeholder="Search parameter, CGI, model…" aria-label="Search rules">
          <button id="expand" type="button" aria-pressed="false">Expand all</button>
          <span id="count"></span>
        </div>
      </div>
${bySection}
    </div>
  </div>
</div></section>

<section class="band band-scan" id="scanner"><div class="wrap">
  <div class="band-head">
    <span class="eyebrow" style="color:#fdba74">02 · The scanner</span>
    <h2>Install it on one camera. It checks the whole network.</h2>
  </div>
  <div class="scan-grid">
  <div class="scan-body">
<p class="punch">The upgrade does not warn you and then proceed — <strong>it fails and reverts the camera</strong>, because of one application somebody installed years ago. With four hundred cameras you find this out one camera at a time, at night, in a maintenance window, with nothing telling you which application did it.</p>
  <p>An ACAP you add through the camera's own Apps page — no laptop, no terminal, nothing to set up.
  It finds every camera on that network and answers one question per device: <em>will upgrade</em>,
  <em>will roll back</em>, or <em>cannot be determined</em>. For the ones that roll back, it names the
  applications responsible.</p>
  <div class="avail"><p><strong>Released — signed by Axis, free to install.</strong> The camera it is
  installed on is checked in full, free. The other cameras it scans are the paid part: a €5 licence key.
  Without a key the scan stops at 5 cameras. ARTPEC-8/9 (aarch64) and ARTPEC-6/7 (armv7hf) packages.</p>
  <a class="ck-go" href="https://github.com/kotyzap/preflight/releases/latest" target="_blank" rel="noopener">Download Preflight ACAP App →</a></div>
  <p>Read-only against every camera it touches: it reads the installed-application list and a handful of
  parameters, the same calls any Axis management tool makes. Nothing is written, nothing is installed on
  the cameras being checked, and no credentials leave your network. The app publishes the complete list
  of endpoints it requests, so that is checkable on the device rather than taken on trust.</p>
  <p><strong>Unknown is not a pass.</strong> Firmware older than about AXIS OS 12 does not publish the
  per-application fields two of these rules depend on. Those cameras report unknown rather than a
  clean bill of health, because a false all-clear is the one answer that would make the tool worse
  than not running it.</p>
  </div>
  <div class="ship">
    <div><span class="mono tagn">now</span><p>${data.rules.filter((r) => r.detection.status === 'verified').length} of the ${data.rules.length} rules are bench-verified and checked automatically. Command-line, macOS and Linux.</p></div>
    <div><span class="mono tagn">now · ACAP</span><p>The signed ACAP: install it on one camera you already have, and it checks the rest of the subnet from inside the network. <a href="https://github.com/kotyzap/preflight/releases/latest" target="_blank" rel="noopener">Download Preflight ACAP App</a>.</p></div>
    <div><span class="mono tagn">next</span><p>Signed downloads for macOS and Windows — nothing to install, no runtime to set up.</p></div>
  </div>
  </div>
  <p class="note"><strong>The free scan tells you which cameras roll back.</strong> That answer is never
  behind a paywall — the point of this is that fleets get checked, not that a scanner gets sold. A licence
  names the applications on each camera, says what to do about each, and produces the report you can hand
  to whoever owns the cameras. The command-line scanner is open and free either way, if you would rather
  run it yourself.</p>
</div></section>

<section class="band band-open" id="open"><div class="wrap">
  <div class="band-head">
    <span class="eyebrow">03 · Known gaps</span>
    <h2>Open questions</h2>
    <p>Things this ruleset does not yet know. Listed because a rules page that hides its own gaps is worth less than one that names them.</p>
  </div>
  <ol class="open">
    ${data.openQuestions
      .map(
        (q) => `<li><strong>${esc(q.id)}</strong> ${esc(q.question)}
      <span class="why">${esc(q.why)} Blocks ${q.blocks.map((b) => `<a href="#${esc(b)}">${esc(b)}</a>`).join(', ')}.</span></li>`
      )
      .join('\n    ')}
  </ol>
</div></section>

</main>

<dialog id="beta" class="beta-dlg" aria-labelledby="beta-h">
<form id="beta-form" method="post" action="/api/beta">
  <h3 id="beta-h">Request the Preflight ACAP beta</h3>
  <p class="beta-sub">The signed package comes to you by email. What you enter here is used only to reply.</p>
  <label><span>Email <span class="req">*</span></span><input name="email" type="email" required maxlength="200" autocomplete="email"></label>
  <div class="beta-2">
    <label>Name<input name="name" maxlength="120" autocomplete="name"></label>
    <label>Company<input name="company" maxlength="160" autocomplete="organization"></label>
  </div>
  <div class="beta-2">
    <label>Number of cameras<select name="cameras"><option value="">—</option><option>1–10</option><option>11–100</option><option>101–1000</option><option>1000+</option></select></label>
    <label>Camera models<input name="models" maxlength="400" placeholder="e.g. Q1656, M1137"></label>
  </div>
  <label><span>Why do you need access? <span class="req">*</span></span><textarea name="reason" required minlength="10" maxlength="2000" rows="4" placeholder="Your fleet, your upgrade plans, what you want to check…"></textarea></label>
  <div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
  <p id="beta-status" class="beta-status" role="status"></p>
  <div class="beta-actions">
    <button type="button" class="beta-cancel" data-close>Cancel</button>
    <button type="submit" class="ck-go">Send request</button>
  </div>
</form>
</dialog>

<footer><div class="wrap">
  <p>Every rule on this page cites public Axis documentation. Nothing here comes from a support ticket or a named installation.</p>
  <p>Ruleset ${esc(data.rulesetVersion)}, generated ${esc(data.generated)} from <a href="rules.json"><code>rules.json</code></a> — the same file the scanner reads. Take it, cite it, argue with it. ${esc(data.owner)}.</p>
  <p class="disclaimer">Preflight is a personal project by Pavel Kotyza, <a href="https://4xs.dev">4xs.dev</a>. It is not affiliated with, endorsed by or sponsored by Axis Communications AB or CamStreamer. AXIS and AXIS OS are trademarks of Axis Communications AB.</p>

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
  var REL=null, relOff=false;  // ids that apply to the model/OS in the checker

  function apply(){
    var term=q.value.trim().toLowerCase(), shown=0;
    rules.forEach(function(el){
      var ok = (!active.tier.size    || active.tier.has(el.dataset.tier))
            && (!active.version.size || active.version.has(el.dataset.version))
            && (!term || el.textContent.toLowerCase().indexOf(term) > -1)
            && (!REL || relOff || REL.has(el.id));
      el.classList.toggle('hidden', !ok);
      if(ok) shown++;
    });
    document.querySelectorAll('.tier').forEach(function(sec){
      var n=sec.querySelectorAll('.rule:not(.hidden)').length;
      sec.classList.toggle('hidden', !n);
      sec.querySelector('.tiercount').textContent=n;
      var t=document.querySelector('.toc a[href="#'+sec.id+'"] .n'); if(t) t.textContent=n;
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
    // What the checker learns narrows the rule list: hide[id] = why it does not apply.
    var hide={}, only=null, recognised=false, label=q;
    function done(h){ out.innerHTML=h||''; if(!h){ REL=null; showRel(); apply(); } }
    if(!q && !v){ return done(''); }

    if(q){
      var n=norm(q);
      if(n.length<3 && !v){ return done(''); }
      if(n.length>=3){

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

      if(chipModel) label=chipModel;
      var listed = hit32.length ? ' Axis also names it directly: '+hit32.join(', ')+'.' : '';

      // The question people actually have is not "is this 32-bit" but "does this
      // camera get AXIS OS 13 at all", and the two have opposite answers for
      // ARTPEC-6. Axis: "AXIS OS 13 won't support Artpec-6 products." Its
      // published list of 32-bit products that DO get AXIS OS 13 is therefore the
      // dividing line, not the chipset.
      var onList = hit32.length > 0;
      var SIXTY_FOUR = { 'ARTPEC-8':1, 'ARTPEC-9':1, 'Ambarella CV25':1 };
      var OLD_32 = { 'ARTPEC-6/7':1, 'ARTPEC-5':1, 'ARTPEC-4':1, 'ARTPEC-3':1,
                     'Ambarella S3L':1, 'Ambarella S2L':1, 'Ambarella S2E':1, 'Ambarella A5S':1 };

      recognised = !!chip || onList;
      if(chip && SIXTY_FOUR[chip]){
        hide.A5='64-bit, no rebuild'; hide.A9='gets AXIS OS 13';
        html+=card('ok','Gets AXIS OS 13 — and no rebuild needed',
          chipModel+' is '+chip+', which is 64-bit (aarch64). It is on the AXIS OS 13 track, and the '+
          'Y2038 change to 64-bit time_t does not force an ACAP rebuild here. What matters for this camera '+
          'is its installed applications, not its hardware.','A5');
      } else if(onList){
        hide.A9='on the AXIS OS 13 list';
        html+=card('bad','Gets AXIS OS 13 — every ACAP must be rebuilt first',
          'Axis names '+hit32.join(', ')+' among the 32-bit products that will receive AXIS OS 13. That '+
          'means the Y2038 ABI break is real for this camera: every ACAP on it must be rebuilt against '+
          '64-bit time_t or removed before you upgrade, or the upgrade rolls back.','A5');
      } else if(chip && OLD_32[chip]){
        // Absence from the list is not enough on its own: it omits big ARTPEC-7
        // families like the P1375 and P3245, and ARTPEC-7 is not the generation
        // Axis says is unsupported. What settles it is the track the camera is
        // actually on — an ARTPEC-7 product has been offered AXIS OS 11 and 12,
        // an ARTPEC-6 product is capped on 10.12. So the answer needs the
        // firmware, and without it this hedges rather than guessing.
        var maj0 = v ? parseInt(v,10) : null;
        if(maj0 !== null && maj0 <= 10){
          only=['A9'];
          html+=card('nopath','No AXIS OS 13 for this camera',
            chipModel+' is '+chip+' and 32-bit, Axis does not name it among the 32-bit products that will '+
            'receive AXIS OS 13, and on AXIS OS '+v+' it was never offered AXIS OS 11 either — a closed '+
            'track. Axis also states that AXIS OS 13 will not support ARTPEC-6 products. Nothing to prepare: '+
            'no application change makes AXIS OS 13 available on this hardware. Confirm with Axis before you '+
            'budget for replacements.','A9');
        } else if(maj0 !== null){
          hide.A5='not on the 32-bit AXIS OS 13 list';
          html+=card('warn','Not on the AXIS OS 13 list — ask Axis for this model',
            chipModel+' is '+chip+' and 32-bit, and Axis does not name it among the 32-bit products that will '+
            'receive AXIS OS 13. But it is on the active AXIS OS track, and that list omits several ARTPEC-7 '+
            'families, so absence from it is not proof there is no upgrade. Ask Axis before planning either '+
            'application work or replacement.','A9');
        } else {
          html+=card('warn','Depends on which AXIS OS it runs today',
            chipModel+' is '+chip+' and 32-bit, and Axis does not name it among the 32-bit products getting '+
            'AXIS OS 13. Pick the current AXIS OS above: still on 10 means it never got AXIS OS 11 '+
            'either and there is no AXIS OS 13 coming; on 11 or 12 it is on the active track and its status '+
            'is simply unpublished.','A9');
        }
      } else if(chip){
        html+=card('warn','Check the upgrade path for this platform',
          chipModel+' is '+chip+', which is not on the list of chips the ACAP Native SDK targets, so '+
          'whether it receives AXIS OS 13 cannot be answered from here. Ask Axis, or read '+
          'Properties.System.Architecture and compare the model against the list under rule A5.','A9');
      } else {
        html+=card('','Model not recognised',
          'Not in the chipset table, and not named on the Axis list of 32-bit products getting AXIS OS 13. '+
          'Read Properties.System.Architecture on the device: aarch64 is on the AXIS OS 13 track; armv7hf '+
          'gets AXIS OS 13 if the model appears on that list, and otherwise depends on whether it ever '+
          'received AXIS OS 11.','A9');
      }
      if(hitNV.length){
        html+=card('warn','Non-video product — StreamCache.Size is removed',
          'root.StreamCache.Size no longer exists on '+hitNV.join(', ')+'. Configuration tooling that sets it will error.','C7');
      } else if(recognised){ hide.C7='non-video products only'; }
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
    }
    // One list, not two: the rules below are filtered to what this camera faces.
    var majV = v ? parseInt(v,10) : null;
    var rel = RULES.filter(function(r){
      if(only) return only.indexOf(r.id)>-1;
      if(hide[r.id]) return false;
      if(majV===null) return true;
      return majV>=13 ? r.tier==='future' : (r.tier!=='future' && parseFloat(r.version)>majV);
    });
    REL=new Set(rel.map(function(r){ return r.id; })); relOff=false;
    var who=(label && norm(label).length>=3 ? '<b>'+esc1(label)+'</b>' : 'this camera')+(v ? ' on <b>AXIS OS '+(v==='10'?'10 or older':v==='13'?'13':v+'.x')+'</b>' : '');
    var tc={A:0,B:0,C:0,future:0}; rel.forEach(function(r){ tc[r.tier]++; });
    var chips=['A','B','C','future'].filter(function(t){ return tc[t]; }).map(function(t){
      return '<span class="tierbadge tb-'+t+'">'+tc[t]+' × '+(t==='future'?'2028':'Tier '+t)+'</span>'; }).join('');
    var skipped=Object.keys(hide).map(function(id){ return id+' ('+hide[id]+')'; });
    if(only) skipped=['every other rule (no AXIS OS 13 for this camera)'];
    html+='<div class="ck-sum"><h4>'+rel.length+' of '+RULES.length+' rules apply to '+who+'</h4>'+
      '<div class="tiers">'+chips+'</div>'+
      (skipped.length?'<p>Left out: '+skipped.join(', ')+'.</p>':'')+
      (!v?'<p>Pick the current AXIS OS to narrow it to the changes still ahead of this camera.</p>':'')+
      '<a class="ck-go" href="#tiers">See the '+rel.length+' rules &darr;</a></div>';
    relbarHTML='Filtered: <b>'+rel.length+'</b> of '+RULES.length+' rules apply to '+who+'.';
    showRel(); apply();
    // Every result ends with the route to a real answer. Without this the checker
    // stops on a caveat and the visitor has nowhere to go — and the caveat is the
    // point: a model number cannot know what is installed on the camera.
    if(html){
      html+='<div class="ck-cta"><h4>This is what a model number can tell you. Not much.</h4>'+
        '<p>What decides whether a camera rolls back is which applications are installed on it, and no '+
        'model list knows that. Preflight scans a fleet and answers it per camera &mdash; the applications '+
        'on each, which ones fail re-installation, which cameras revert. It runs from the command line '+
        'today, and as a signed ACAP you install on a single camera to '+
        'check the whole network.</p>'+
        '<a class="ck-go" href="#scanner">How the scanner works &rarr;</a></div>';
    }
    out.innerHTML=html;
  }
  var relbar=document.getElementById('relbar'), relbarHTML='';
  function esc1(t){ return String(t).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function showRel(){
    if(!REL){ relbar.classList.add('hidden'); return; }
    relbar.classList.remove('hidden');
    relbar.innerHTML='<span>'+(relOff?'Showing all '+RULES.length+' rules.':relbarHTML)+'</span><button type="button" id="relbtn">'+
      (relOff?'Only the ones that apply':'Show all '+RULES.length)+'</button>';
    document.getElementById('relbtn').onclick=function(){ relOff=!relOff; showRel(); apply(); };
  }
  mi.addEventListener('input',check); os.addEventListener('change',check); check();

  // ---- beta request form ---------------------------------------------------
  var dlg=document.getElementById('beta'), bform=document.getElementById('beta-form'), bstat=document.getElementById('beta-status');
  document.querySelectorAll('[data-beta]').forEach(function(a){
    a.addEventListener('click',function(e){ e.preventDefault(); dlg.showModal(); bform.email.focus(); });
  });
  dlg.querySelector('[data-close]').addEventListener('click',function(){ dlg.close(); });
  dlg.addEventListener('click',function(e){ if(e.target===dlg) dlg.close(); });
  bform.addEventListener('submit',function(e){
    e.preventDefault();
    var btn=bform.querySelector('button[type=submit]');
    btn.disabled=true; bstat.className='beta-status'; bstat.textContent='Sending…';
    fetch(bform.action,{method:'POST',body:new FormData(bform),headers:{Accept:'application/json'}})
      .then(function(r){
        var fallback='Could not send the request (HTTP '+r.status+'). Please try again later.';
        return r.json().then(function(d){ if(!d.ok && !d.error) d.error=fallback; return d; },
                             function(){ return {ok:false, error:fallback}; });
      })
      .then(function(d){
        if(!d.ok) throw new Error(d.error||'');
        bform.innerHTML='<div class="beta-done"><h3>Request sent</h3><p class="beta-sub">Thanks. You will get a reply by email.</p>'+
          '<button type="button" class="ck-go" id="beta-ok">Close</button></div>';
        document.getElementById('beta-ok').onclick=function(){ dlg.close(); };
      })
      .catch(function(err){
        btn.disabled=false; bstat.className='beta-status err';
        bstat.textContent=err.message||'Could not send the request. Please try again later.';
      });
  });

  document.querySelectorAll('button.f').forEach(function(b){
    b.addEventListener('click',function(){
      var set=active[b.dataset.filter], on=b.getAttribute('aria-pressed')==='true';
      if(on) set.delete(b.dataset.value); else set.add(b.dataset.value);
      b.setAttribute('aria-pressed', String(!on));
      apply();
    });
  });
  q.addEventListener('input', function(){
    apply();
    // A match may sit in the collapsed evidence, so show it.
    if(q.value.trim()) rules.forEach(function(el){ if(!el.classList.contains('hidden')) el.open=true; });
  });
  apply();

  var exp=document.getElementById('expand');
  exp.addEventListener('click',function(){
    var on=exp.getAttribute('aria-pressed')!=='true';
    rules.forEach(function(el){ el.open=on; });
    exp.setAttribute('aria-pressed',String(on));
    exp.textContent=on?'Collapse all':'Expand all';
  });

  // Links like #A5 (checker, "see also", open questions) land on a collapsed rule: open it.
  function openHash(){
    var id=decodeURIComponent(location.hash.slice(1)); if(!id) return;
    var el=document.getElementById(id);
    if(el && el.classList.contains('rule')){ el.classList.remove('hidden'); el.open=true; el.scrollIntoView(); }
  }
  addEventListener('hashchange',openHash); openHash();
})();
</script>
</body>
</html>
`;

/** Everything the public site consists of. Anything else in dist/ fails the build. */
const PUBLIC_FILES = new Set([
  'index.html', '404.html', 'rules.json',
  'favicon.svg', 'og.svg', 'og.png',
  '_headers', 'robots.txt', 'sitemap.xml', 'thanks.html',
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
  Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; connect-src 'self'; frame-ancestors 'self'
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
<title>Not found — Preflight for OS 13</title>
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

// Where Ko-fi sends a buyer after paying (the shop item's "Redirect buyer to a URL").
// Shows the licence key as soon as the webhook has issued it (functions/api/key.js),
// and says plainly that the same key is on its way by email.
write(
  'thanks.html',
  `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Thank you — Preflight for OS 13</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#f7f7f5;--surface:#fff;--ink:#16181d;--muted:#5c6270;--line:#e2e2dd;--accent:#c2410c;--code:#f0f0ec;--ok:#0d6f68}
html[data-theme="dark"]{--bg:#131417;--surface:#1a1c21;--ink:#e8e8e6;--muted:#9aa1ae;--line:#2b2e35;--accent:#fb923c;--code:#22252b;--ok:#4fb3a7}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);
  font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px 16px}
main{max-width:560px;margin:8vh auto 0;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:28px 24px}
h1{font-size:22px;margin:0 0 8px;letter-spacing:-.01em}
p{margin:0 0 14px;color:var(--muted)}
label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
.row{display:flex;gap:8px;flex-wrap:wrap}
input{flex:1;min-width:0;font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
button{font:600 14px/1 inherit;padding:11px 16px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
button[disabled]{opacity:.55;cursor:default}
html[data-theme="dark"] button{color:#111}
#theme{position:fixed;top:14px;right:14px;background:var(--surface);color:var(--ink);border-color:var(--line);padding:8px 10px}
.key{display:block;margin:6px 0 10px;padding:12px;background:var(--code);border-radius:6px;
  font:13px/1.45 ui-monospace,Menlo,monospace;word-break:break-all;user-select:all}
ol{margin:0 0 14px;padding-left:20px}
li{margin-bottom:4px}
#msg{font-size:14px;margin-top:12px}
#msg.ok{color:var(--ok)}
a{color:var(--accent)}
</style></head><body>
<button id="theme" type="button" aria-label="Toggle colour theme">◐</button>
<main>
<h1>Thank you — payment received.</h1>
<p>Your licence key is on its way to the email address you paid with. You can also get it here right away.</p>
<form id="f">
  <label for="email">Email on your Ko-fi receipt</label>
  <div class="row"><input id="email" type="email" required autocomplete="email" placeholder="you@example.com">
  <button id="go" type="submit">Show my key</button></div>
</form>
<div id="msg" role="status"></div>
<div id="done" hidden>
  <code class="key" id="key"></code>
  <div class="row" style="margin-bottom:16px"><button id="copy" type="button">Copy key</button></div>
  <ol>
    <li>Go back to the <strong>Preflight</strong> tab on your camera.</li>
    <li>Paste the key into the key field and click <strong>Save</strong>. The other cameras' findings appear straight away.</li>
  </ol>
  <p>The key is checked on the camera itself — the camera does not need internet access. Keep the email; it is your copy.</p>
</div>
<!--email_off--><p style="margin:18px 0 0;font-size:13px">No key after a few minutes? Check spam, then write to
<a href="mailto:kotyza@gmail.com?subject=Preflight%20licence%20key">kotyza@gmail.com</a> with your Ko-fi receipt.</p><!--/email_off-->
</main>
<script>
(function () {
  var root = document.documentElement, $ = function (id) { return document.getElementById(id); };
  try { var t = localStorage.getItem('preflight-theme'); if (t) root.dataset.theme = t; } catch (e) {}
  $('theme').onclick = function () {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('preflight-theme', root.dataset.theme); } catch (e) {}
  };
  var tries = 0;
  function ask(email) {
    fetch('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.key) {
          $('key').textContent = d.key; $('done').hidden = false; $('f').hidden = true;
          $('msg').className = 'ok'; $('msg').textContent = 'Here is your key. The same key has been emailed to you.';
          return;
        }
        if (d.error) { $('msg').textContent = d.error; $('go').disabled = false; return; }
        // Ko-fi's webhook can arrive a few seconds after the redirect: keep asking for two minutes.
        if (++tries < 40) {
          $('msg').textContent = 'Waiting for Ko-fi to confirm the payment…';
          return setTimeout(function () { ask(email); }, 3000);
        }
        $('msg').textContent = 'Not confirmed yet. Your key will arrive by email — or check the address and try again.';
        $('go').disabled = false;
      })
      .catch(function () { $('msg').textContent = 'Could not reach the server. Your key will still arrive by email.'; $('go').disabled = false; });
  }
  $('f').onsubmit = function (e) {
    e.preventDefault(); tries = 0; $('go').disabled = true; ask($('email').value.trim());
  };
  $('copy').onclick = function () {
    var k = $('key').textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(k) : Promise.reject())
      .then(function () { $('copy').textContent = 'Copied'; })
      .catch(function () { $('copy').textContent = 'Select the key and copy it'; });
  };
})();
</script>
</body></html>
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

// ---- README visuals ----------------------------------------------------------
// GitHub renders Markdown without CSS, so the README borrows the page's look as SVG
// banners (light + dark, picked by <picture>) and gets its coverage table rewritten
// here. Both come from rules.json, so the README can no longer drift from the page.
const README = resolve(ROOT, 'README.md');
const DOCS = resolve(ROOT, 'docs');
mkdirSync(DOCS, { recursive: true });

const n32 = data.rules.find((r) => r.id === 'A5').models32bit.length;
const tierCount = Object.fromEntries(counts);

function banner(dark) {
  const c = dark
    ? { bg: '#15171b', card: '#1c1f24', line: '#2b2e35', ink: '#e8e8e6', muted: '#9aa1ae', accent: '#fb923c',
        a: '#f87171', b: '#fbbf24', cc: '#7dabff', f: '#9ca3af' }
    : { bg: '#f7f8fa', card: '#ffffff', line: '#dfe2e7', ink: '#16181d', muted: '#5c6270', accent: '#c2410c',
        a: '#b91c1c', b: '#b45309', cc: '#1d4ed8', f: '#4b5563' };
  const F = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
  const M = `ui-monospace,SFMono-Regular,Menlo,monospace`;
  const stats = [
    [tierCount.A, 'Tier A rules', c.a],
    [tierCount.B, 'Tier B rules', c.b],
    [tierCount.C, 'Tier C rules', c.cc],
    [tierCount.future, '2028 items', c.f],
    [n32, '32-bit models', c.line],
    [data.rulesetVersion, `ruleset · ${data.generated}`, c.line],
  ];
  const W = 1280, cw = 184, gap = 16, x0 = 56;
  const cards = stats
    .map(([v, l, top], i) => {
      const x = x0 + i * (cw + gap);
      return `<g transform="translate(${x},300)">
    <rect width="${cw}" height="92" rx="12" fill="${c.card}" stroke="${c.line}"/>
    <rect x="12" y="0" width="${cw - 24}" height="4" rx="2" fill="${top}"/>
    <text x="18" y="50" font-family="${F}" font-size="32" font-weight="700" fill="${c.ink}">${esc(v)}</text>
    <text x="18" y="76" font-family="${F}" font-size="16" fill="${c.muted}">${esc(l)}</text>
  </g>`;
    })
    .join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="430" viewBox="0 0 ${W} 430">
  <clipPath id="r"><rect width="${W}" height="430" rx="16"/></clipPath>
  <g clip-path="url(#r)"><rect width="${W}" height="430" fill="${c.bg}"/><rect width="8" height="430" fill="${c.a}"/></g>
  <text x="56" y="76" font-family="${M}" font-size="15" font-weight="600" letter-spacing="3" fill="${c.accent}">PREFLIGHT FOR OS 13 · 4XS.DEV</text>
  <text x="56" y="148" font-family="${F}" font-size="54" font-weight="800" letter-spacing="-1.5" fill="${c.ink}">AXIS OS 13 doesn't warn you. <tspan fill="${c.a}">It rolls back.</tspan></text>
  <text x="56" y="200" font-family="${F}" font-size="22" fill="${c.muted}">Which Axis cameras survive the upgrade — before you start it. Read-only, nothing installed on the camera.</text>
  <text x="56" y="252" font-family="${F}" font-size="18" fill="${c.ink}"><tspan font-weight="700">${data.rules.length} documented breaking changes</tspan>, sorted by what they cost you. Every rule cites Axis.</text>
  ${cards}
</svg>
`;
}
writeFileSync(resolve(DOCS, 'banner-light.svg'), banner(false));
writeFileSync(resolve(DOCS, 'banner-dark.svg'), banner(true));

// Coverage table between markers in README.md.
if (existsSync(README)) {
  const applied = data.rules.filter((r) => r.tier === 'C' && r.applied).length;
  const verified = data.rules.filter((r) => r.detection.status === 'verified').length;
  const table = `<!-- coverage:start — generated by build.mjs from rules.json; edits here are overwritten -->
| | Tier | What it does | Rules |
|:-:|---|---|--:|
| 🔴 | **A** | Blocks the upgrade or rolls it back | **${tierCount.A}** |
| 🟠 | **B** | Upgrade succeeds, the app breaks | **${tierCount.B}** |
| 🔵 | **C** | Camera is fine, your integration breaks (incl. ${applied} already in force) | **${tierCount.C}** |
| ⚫ | **2028** | AXIS OS 14, September 2028 | **${tierCount.future}** |
| | | **Total** · ${verified} bench-verified | **${data.rules.length}** |
| 🧩 | **A5** | 32-bit models under the Y2038 ABI break | **${n32}** |
<!-- coverage:end -->`;
  const md = readFileSync(README, 'utf8');
  const re = /<!-- coverage:start[\s\S]*?<!-- coverage:end -->/;
  if (re.test(md)) {
    const next = md.replace(re, table);
    if (next !== md) writeFileSync(README, next);
  }
}
