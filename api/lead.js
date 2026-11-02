import { handler, rateLimit, HttpError } from '../lib/http.js';

// POST { name, email, website, plan, message } -> forwards to LEAD_WEBHOOK_URL (n8n, Make, Zapier, Google Apps Script…)
export default handler(async (body, req) => {
  rateLimit(req, 'lead', 5, 60 * 60 * 1000);
  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().slice(0, 200);
  if (!name) throw new HttpError(400, 'Please add your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email.');
  if (body.company_site) return { ok: true }; // honeypot field filled = bot

  const lead = {
    name, email,
    website: String(body.website || '').slice(0, 500),
    plan: String(body.plan || '').slice(0, 60),
    message: String(body.message || '').slice(0, 2000),
    scores: body.scores && typeof body.scores === 'object' ? body.scores : null,
    createdAt: new Date().toISOString(),
  };

  if (process.env.LEAD_WEBHOOK_URL) {
    const r = await fetch(process.env.LEAD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
    }).catch(() => null);
    if (!r || !r.ok) throw new HttpError(502, 'Could not save your request. Please email us instead.');
  } else {
    console.log('[lead]', JSON.stringify(lead));
  }
  return { ok: true };
});
