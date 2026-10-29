// POST /api/kofi — Ko-fi webhook: a Preflight purchase becomes a signed licence key, emailed to the buyer.
// Cloudflare Pages Function. Keys use the same format and Ed25519 key pair as tools/issue-key.mjs,
// and are verified offline by acap/app/src/licence.ts. Setup: see DEPLOY.md, "Ko-fi licence keys".
//
// Env (Pages → Settings → Variables and secrets):
//   KOFI_VERIFICATION_TOKEN  secret — Ko-fi → Settings → API → Webhooks → Verification token
//   PREFLIGHT_SIGNING_KEY    secret — the Ed25519 private key PEM (~/.preflight/signing.pem)
//   KOFI_SHOP_CODE           optional — the shop item's direct_link_code. When set, only that item issues a key.
//                            When not set, any payment of at least PREFLIGHT_MIN_AMOUNT does.
//   PREFLIGHT_MIN_AMOUNT     optional — default 5
//   CF_ACCOUNT_ID, CF_EMAIL_TOKEN, BETA_FROM, BETA_TO — shared with /api/beta
//   PREFLIGHT_KEYS           KV binding — the key is also kept here for an hour so /thanks can show it
//                            (see key.js). Optional: without it the key goes by email only.
//
// Always answers 200 once the token checks out, including for payments that are not for Preflight:
// Ko-fi retries anything else, and a retry of an ignored payment is noise.
// Keys are deterministic (same payment → same payload → same Ed25519 signature), so a retry
// re-sends the identical key and nothing needs to be stored.

const NEEDED = ['KOFI_VERIFICATION_TOKEN', 'PREFLIGHT_SIGNING_KEY', 'CF_ACCOUNT_ID', 'CF_EMAIL_TOKEN', 'BETA_FROM', 'BETA_TO'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/kofi — setup check. Reports only which variables are present, never their values.
export function onRequestGet({ env }) {
  const set = Object.fromEntries([...NEEDED, 'KOFI_SHOP_CODE', 'PREFLIGHT_MIN_AMOUNT'].map((k) => [k, Boolean(env[k])]));
  return new Response(JSON.stringify({ function: 'ok', variables: set }, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function onRequestPost({ request, env }) {
  const text = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/plain' } });

  let data;
  try {
    // Ko-fi posts application/x-www-form-urlencoded with one field, `data`, holding JSON.
    data = JSON.parse((await request.formData()).get('data'));
  } catch {
    return text(400, 'bad request');
  }
  if (!env.KOFI_VERIFICATION_TOKEN || data.verification_token !== env.KOFI_VERIFICATION_TOKEN) {
    return text(401, 'bad token');
  }

  if (!isPreflightPurchase(data, env)) return text(200, 'ignored');

  const email = String(data.email ?? '').trim();
  if (!EMAIL_RE.test(email)) {
    console.error('kofi: purchase without a usable email', data.kofi_transaction_id);
    return text(200, 'no email');
  }

  const missing = NEEDED.filter((k) => !env[k]);
  if (missing.length) {
    // 500 so Ko-fi retries once the variables are set.
    console.error('kofi: missing variables', missing.join(', '));
    return text(500, 'not configured');
  }

  const key = await issueKey(env.PREFLIGHT_SIGNING_KEY, {
    subject: email,
    issued: String(data.timestamp ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10),
    txn: String(data.kofi_transaction_id ?? ''),
  });

  // Stored before the email is attempted, so the thanks page has it even if sending fails.
  if (env.PREFLIGHT_KEYS) {
    await env.PREFLIGHT_KEYS.put('email:' + email.toLowerCase(), key, { expirationTtl: 3600 });
  }

  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CF_EMAIL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: [email],
      from: env.BETA_FROM,
      reply_to: env.BETA_TO,
      subject: 'Your Preflight for OS 13 licence key',
      text: [
        `Thank you for buying Preflight for OS 13${data.from_name ? ', ' + data.from_name : ''}.`,
        '',
        'Your licence key:',
        '',
        key,
        '',
        'Paste it into Licence key in the Preflight app on your camera, click Save, then Scan the network.',
        'The key is checked on the camera itself; the camera does not need internet access.',
        '',
        'Questions: reply to this email.',
        '— Pavel Kotyza, https://preflight.4xs.dev',
      ].join('\n'),
    }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));

  if (!r.ok) {
    // 500 so Ko-fi retries; the key is deterministic, so the retry sends the same one.
    console.error('kofi: send failed', r.status, await r.text(), data.kofi_transaction_id);
    return text(500, 'send failed');
  }
  console.log('kofi: key sent', data.kofi_transaction_id);
  return text(200, 'ok');
}

export function isPreflightPurchase(data, env) {
  if (env.KOFI_SHOP_CODE) {
    return (
      data.type === 'Shop Order' &&
      Array.isArray(data.shop_items) &&
      data.shop_items.some((i) => i && i.direct_link_code === env.KOFI_SHOP_CODE)
    );
  }
  return Number(data.amount) >= Number(env.PREFLIGHT_MIN_AMOUNT || 5);
}

// PF1.<base64url payload>.<base64url signature over the encoded payload> — as tools/issue-key.mjs.
export async function issueKey(pem, payload) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const priv = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  const encoded = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, new TextEncoder().encode(encoded));
  return `PF1.${encoded}.${b64url(new Uint8Array(sig))}`;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
