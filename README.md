# AuditLab — Free Website Audit (Speed + SEO + AI UX/CRO)

Simple lead-magnet SaaS: a visitor enters a URL, picks tests, and gets a live report with a progress bar.

- **Speed** — Google PageSpeed Insights API (Lighthouse scores, Core Web Vitals, real-user CrUX data, top fixes)
- **SEO** — 19 on-page checks (title, meta, H1/H2, schema, canonical, OG, alt text, robots.txt, sitemap, response time…) + Lighthouse SEO findings
- **AI UX / CRO** — page screenshot (from PSI) + extracted HTML structure sent to Claude vision with a fixed rubric. Without an API key it falls back to rule-based conversion checks.
- **Free vs paid** — free report shows the top 3 UX issues; the rest are locked behind a "Get full audit" lead form.
- **Leads** — modal form posts to `/api/lead`, which forwards to your webhook (n8n / Make / Zapier / Google Sheets).

No framework, no database. Plain HTML/CSS/JS frontend + Vercel serverless functions.

```
api/        psi.js  seo.js  ux.js  lead.js   (serverless endpoints)
lib/        psi.js  seo.js  ux.js  url.js  http.js  mock-psi.js
public/     index.html  styles.css  app.js  favicon.svg
server.js   local dev server (runs the same api/ code)
```

## Run locally

```bash
npm install
cp .env.example .env      # add keys (optional)
npm run dev               # http://localhost:3000
```

Node 18+ required. PageSpeed works without a key, but the anonymous quota is very low; add `PSI_API_KEY`.

## Get the API keys

1. **PSI_API_KEY** (free): Google Cloud Console → create project → APIs & Services → enable "PageSpeed Insights API" → Credentials → Create API key. Restrict it to the PageSpeed Insights API.
2. **ANTHROPIC_API_KEY**: console.anthropic.com → API Keys. `AI_MODEL` defaults to `claude-sonnet-5-5`; use `claude-haiku-5-5` for cheaper scans.
3. **LEAD_WEBHOOK_URL** (optional): any URL that accepts a JSON POST. Without it, leads are only printed in the server logs.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. Vercel → Add New Project → import the repo. Framework preset: **Other**. No build command needed.
3. Settings → Environment Variables → add the values from `.env.example`.
4. Deploy. `vercel.json` already gives the PSI and UX functions 60 seconds.

## Customize

- **Brand name**: search for `AuditLab` in `public/index.html`.
- **Colors / fonts**: CSS variables at the top of `public/styles.css`.
- **Prices and plan text**: `#pricing` section in `public/index.html`.
- **Free UX issues shown**: `FREE_UX_ISSUES` env var (default 3).
- **AI rubric / tone**: `SYSTEM` prompt in `lib/ux.js`.
- **SEO checks**: `lib/seo.js` — each check has a weight that affects the score.

## Shareable reports

Every scan updates the address bar to `?url=…&tests=…&device=…`. Opening that link re-runs the scan, so prospects can share or bookmark reports. Results are cached for 30 minutes per server instance.

## Before real traffic

- **Bot protection**: the built-in rate limit is in-memory per instance (`SCANS_PER_HOUR`). Add Cloudflare Turnstile to the form and verify it in the API, or use Upstash Redis for a shared limit.
- **SSRF**: private/local addresses are blocked and every redirect hop is checked. `ALLOW_PRIVATE=1` disables this — local testing only, never in production.
- **Storage**: nothing is saved. To keep scan history or email reports, add Supabase and save results in `api/*.js`.

## Testing without Google

`MOCK_PSI=1` returns sample PageSpeed data after 5 seconds (marked "sample data" in the report). SEO and UX still run for real.
