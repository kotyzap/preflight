// POST /api/beta — a Preflight ACAP beta request, emailed to the owner.
// Cloudflare Pages Function. Sends through the Cloudflare Email Sending REST API,
// so there is no third party and nothing stored. Setup: see DEPLOY.md, "Beta form".
//
// Env (Pages → Settings → Variables and secrets):
//   CF_ACCOUNT_ID    account that owns 4xs.dev
//   CF_EMAIL_TOKEN   secret — API token with "Email Sending: Edit"
//   BETA_FROM        e.g. preflight@4xs.dev (domain onboarded for Email Sending)
//   BETA_TO          e.g. kotyza@gmail.com (verified destination address)

const MAX = { email: 200, name: 120, company: 160, cameras: 20, models: 400, reason: 2000 };
const CAMERAS = ['', '1–10', '11–100', '101–1000', '1000+'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const oneLine = (s) => s.replace(/[\r\n]+/g, ' ');

export async function onRequestPost({ request, env }) {
  const json = (request.headers.get('accept') || '').includes('application/json');
  const reply = (ok, msg, status) =>
    json
      ? Response.json(ok ? { ok } : { ok, error: msg }, { status })
      : new Response(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
            `<title>Preflight beta request</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
            `<p>${ok ? 'Thanks — your request was sent. You will get a reply by email.' : msg}</p><p><a href="/">← Back to Preflight</a></p>`,
          { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );

  let f;
  try {
    f = Object.fromEntries(await request.formData());
  } catch {
    return reply(false, 'Bad request.', 400);
  }
  // Honeypot: humans never see this field. Pretend success so bots learn nothing.
  if (f.website) return reply(true, '', 200);

  const v = {};
  for (const k in MAX) v[k] = String(f[k] ?? '').trim().slice(0, MAX[k]);
  if (!EMAIL_RE.test(v.email)) return reply(false, 'Please enter a valid email address.', 400);
  if (v.reason.length < 10) return reply(false, 'Please tell us a little about why you need access.', 400);
  if (!CAMERAS.includes(v.cameras)) return reply(false, 'Bad request.', 400);

  const text = [
    'Preflight ACAP beta request',
    '',
    `Email:    ${v.email}`,
    `Name:     ${v.name || '—'}`,
    `Company:  ${v.company || '—'}`,
    `Cameras:  ${v.cameras || '—'}`,
    `Models:   ${v.models || '—'}`,
    '',
    'Why they need access:',
    v.reason,
    '',
    `— sent from ${new URL(request.url).host}, ${new Date().toISOString()}`,
  ].join('\n');

  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_EMAIL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: env.BETA_TO,
      from: env.BETA_FROM,
      replyTo: v.email,
      subject: oneLine(`Preflight ACAP beta: ${v.name || v.email}${v.company ? ` (${v.company})` : ''}`),
      text,
    }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));

  if (!r.ok) {
    console.error('beta: send failed', r.status, await r.text());
    return reply(false, 'Sorry — the request could not be sent. Please try again later.', 502);
  }
  return reply(true, '', 200);
}
