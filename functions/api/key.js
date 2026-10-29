// POST /api/key — the thanks page asks for the key of a purchase that just happened.
// Body: { email }. Answers { key } once the Ko-fi webhook has stored it, { pending: true } before that.
//
// kofi.js stores each issued key in KV under the buyer's email for one hour. The email is the
// only thing the thanks page can know (Ko-fi's redirect URL is the same for every buyer), so
// anyone who knows a buyer's email within that hour can read their key. Accepted at €5; the
// key is also emailed, and this endpoint only shortens the wait.
//
// Binding (Pages → Settings → Bindings): KV namespace as PREFLIGHT_KEYS — shared with kofi.js.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function onRequestPost({ request, env }) {
  if (!env.PREFLIGHT_KEYS) return reply({ error: 'not configured' }, 503);
  let email = '';
  try {
    email = String((await request.json()).email ?? '').trim().toLowerCase();
  } catch {
    return reply({ error: 'bad request' }, 400);
  }
  if (!EMAIL_RE.test(email) || email.length > 200) return reply({ error: 'Please enter the email you paid with.' }, 400);
  const key = await env.PREFLIGHT_KEYS.get('email:' + email);
  return reply(key ? { key } : { pending: true });
}
