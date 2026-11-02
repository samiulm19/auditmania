# AuditLab — Free Website Audit (Speed + SEO + AI UX/CRO)

Simple lead-magnet SaaS: a visitor enters a URL, picks tests, and gets a live report with a progress bar.

- **Speed** — Google PageSpeed Insights API, Mobile, Desktop or Both (run in parallel, switch between them in the report). Two views from the same API result, no extra calls when switching:
  - **Short Report** (default): score, FCP/LCP/TBT/CLS/SI, Core Web Vitals summary, field-data availability, top 5 issues, plain-language recommendations, final screenshot
  - **Expandable Report**: PageSpeed-style accordions with lab metrics, real-user data (URL + origin with distributions), filmstrip, insights/diagnostics with "Show audits relevant to FCP/LCP/TBT/CLS" filter, passed / not applicable / manual audits, network dependency tree, resource summary, JS treemap, LCP breakdown, layout shifts, third parties and test environment
- **Report UI** — sections as tabs (Speed, Page SEO, Full site SEO, UX & CRO), a website preview panel (PageSpeed screenshot, or a live iframe when the site allows it) and **Download PDF** (generated in the browser with self-hosted jsPDF, no server cost)
- **Page SEO** — 100+ checks modeled on the Semrush / Ahrefs site-audit lists, in 13 categories: Indexability, On-page, Content, Links, Images, Structured data, Social, Technical, Performance, Security, International (hreflang), Site (robots.txt, sitemap, http→https, www, soft 404) and AI search (llms.txt). Includes network checks for broken links/images/JS/CSS, image size, compression, caching, minification, SSL certificate and TLS version.
- **Full site SEO crawl** — finds pages from the sitemap (or by following links), runs every page-level check on every page, then cross-page checks: duplicate titles/descriptions/H1s, near-duplicate content (MinHash), broken pages, redirect chains, orphan pages, click depth, noindex/canonicalized pages in the sitemap. Progress streams live.
- **UX / CRO** — 55+ conversion checks in 12 categories (value proposition, CTA, trust & proof, contact, forms, offer & urgency, navigation, copy & readability, media, mobile & accessibility, measurement/tracking, ecommerce) plus an optional Claude vision review of the screenshot.
- **Free vs paid** — free report shows the top 3 UX issues; the rest are locked behind a "Get full audit" lead form.
- **Leads** — modal form posts to `/api/lead`, which forwards to your webhook (n8n / Make / Zapier / Google Sheets).

No framework, no database. Plain HTML/CSS/JS frontend + Vercel serverless functions.

```
api/            psi.js  seo.js  crawl.js  ux.js  lead.js   (serverless endpoints)
lib/engine/     model.js   parse a page ONCE into a plain object
                probes.js  network checks (links, assets, robots, sitemap, TLS…) with a time budget
                run.js     runs checks + scores by category
lib/checks/     seo.js     page-level SEO checks
                site.js    cross-page checks for the crawl
                cro.js     conversion / UI checks
lib/            seo.js  crawl.js  ux.js  psi.js  url.js  http.js
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
- **Checks**: see "Adding a new check" below.

## Adding a new check

Every check is one object in `lib/checks/seo.js`, `cro.js` or `site.js`. Nothing else needs to change; scoring, categories and the UI pick it up automatically.

```js
{ id: 'og-image-size', cat: 'Social', sev: 'low', label: 'og:image is a full URL',
  run: m => !m.og.image ? null                       // null = not applicable, skipped
    : m.og.image.startsWith('http') ? pass(m.og.image)
    : warn(m.og.image, 'Use an absolute URL for og:image.') },
```

- `m` is the page model from `lib/engine/model.js` (title, headings, links, images, forms, ctas, trust, trackers, headers…). Need new data? Add a field there once.
- `ctx.probes` and `ctx.site` hold network results (only in Page SEO). Return `null` when they're missing.
- `sev` (`high` / `medium` / `low`) sets the weight in the score and the severity in the crawl report.
- Site-wide checks (robots, sitemap, TLS…) are listed in `SITE_SCOPE` so the crawl runs them once, not on every page.

## Crawl limits

A Vercel function on the Hobby plan should finish within 60 seconds, so the crawl stops at `CRAWL_LIMIT` pages (default 25) or `CRAWL_BUDGET_MS` (default 45s), whichever comes first. Cart, checkout, login, tag/author and asset URLs are skipped. For bigger sites raise `CRAWL_LIMIT` to 50–100 and the function `maxDuration` in `vercel.json` (paid plans allow longer).

## Shareable reports

Every scan updates the address bar to `?url=…&tests=…&device=…`. Opening that link re-runs the scan, so prospects can share or bookmark reports. Results are cached for 30 minutes per server instance.

## Before real traffic

- **Bot protection**: the built-in rate limit is in-memory per instance (`SCANS_PER_HOUR`). Add Cloudflare Turnstile to the form and verify it in the API, or use Upstash Redis for a shared limit.
- **SSRF**: private/local addresses are blocked and every redirect hop is checked. `ALLOW_PRIVATE=1` disables this — local testing only, never in production.
- **Storage**: nothing is saved. To keep scan history or email reports, add Supabase and save results in `api/*.js`.

## Testing without Google

`MOCK_PSI=1` returns a real Lighthouse 13 report captured from a test page (`lib/fixtures`), run through the same parser as live Google data, plus sample real-user data. It is marked "sample data" in the report. SEO and UX still run for real.
