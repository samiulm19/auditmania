import { pass, warn, fail, info, plural } from '../engine/run.js';

// Conversion (CRO) and UI checks. Same format as the SEO checks: each one reads the
// page model and returns pass / warn / fail / info. "Early" means near the top of the
// page (before the first H2 or in the first ~15% of the page), our stand-in for "above the fold".

export const CRO_CATEGORIES = ['Value proposition', 'Call to action', 'Trust & proof', 'Contact & support', 'Forms & lead capture', 'Offer & urgency', 'Navigation', 'Copy & readability', 'Media', 'Mobile & accessibility', 'Measurement', 'Ecommerce'];

const GENERIC_H1 = /^(welcome|home|homepage|welcome to (our|my|the) (website|site|page|store)|hello|untitled|about us|our services)\b/i;
const BENEFIT = /\b(you|your|get|grow|save|increase|boost|more|better|faster|easy|easier|without|in \d+|free|guarantee|results|best|trusted|proven|instant|stress[- ]free|help(s)? you)\b/i;
const wc = s => (s || '').split(/\s+/).filter(Boolean).length;
const leadForms = m => m.forms.filter(f => !f.isSearch && !f.isNewsletter && f.fields.length >= 2);
const primaryCtas = m => m.ctas.filter(c => !c.inForm);

export const CRO_CHECKS = [
  // ---------------------------------------------------------------- Value proposition
  { id: 'vp-headline', cat: 'Value proposition', sev: 'high', label: 'Clear main headline',
    run: m => !m.h1[0] ? fail('No H1 headline', 'Visitors decide in ~5 seconds. Add a headline that says what you offer and for whom.')
      : GENERIC_H1.test(m.h1[0]) ? fail(`"${m.h1[0].slice(0, 60)}"`, 'Generic headline. Replace "Welcome…" with your main benefit, e.g. "Pain-free dental care in Gazipur, same-day appointments".')
      : pass(`"${m.h1[0].slice(0, 80)}"`) },
  { id: 'vp-length', cat: 'Value proposition', sev: 'medium', label: 'Headline is short and scannable',
    run: m => { if (!m.h1[0]) return null; const n = wc(m.h1[0]); return n > 14 ? warn(`${n} words`, 'Cut the headline to 6–12 words and move details to a subheadline.') : n < 3 ? warn(`${n} words`, 'Too vague. Say what you do and the outcome.') : pass(`${n} words`); } },
  { id: 'vp-early', cat: 'Value proposition', sev: 'medium', label: 'Headline is at the top of the page',
    run: m => { const h = m.headings.find(x => x.level === 1); return !h ? null : h.early ? pass('Above the fold') : warn('Appears low on the page', 'Move the main headline into the hero section.'); } },
  { id: 'vp-benefit', cat: 'Value proposition', sev: 'medium', label: 'Headline speaks to a benefit',
    run: m => { if (!m.h1[0]) return null; const sub = m.headings.find(h => h.level === 2)?.text || ''; return BENEFIT.test(m.h1[0] + ' ' + sub) ? pass('Benefit language found') : warn('Feature or brand focused', 'Lead with the result the customer gets ("Get more bookings…"), not just what you are.'); } },
  { id: 'vp-subheadline', cat: 'Value proposition', sev: 'low', label: 'Supporting subheadline',
    run: m => { const i = m.headings.findIndex(h => h.level === 1); if (i < 0) return null; const next = m.headings[i + 1]; const hasSub = (next && next.early && next.level >= 2) || m.paragraphs.slice(0, 3).some(n => n >= 8 && n <= 40); return hasSub ? pass('Present') : warn('Missing', 'Add one line under the headline explaining how you deliver the benefit.'); } },

  // ---------------------------------------------------------------- Call to action
  { id: 'cta-exists', cat: 'Call to action', sev: 'high', label: 'Has a clear call-to-action button',
    run: m => primaryCtas(m).length ? pass(plural(new Set(primaryCtas(m).map(c => c.text.toLowerCase())).size, 'button label')) : fail('No buttons found', 'Add a high-contrast primary button like "Book a free call".') },
  { id: 'cta-early', cat: 'Call to action', sev: 'high', label: 'CTA visible above the fold',
    run: m => !primaryCtas(m).length ? null : primaryCtas(m).some(c => c.early) ? pass(`"${primaryCtas(m).find(c => c.early).text}"`) : fail('First CTA is far down', 'Put your main CTA in the hero, next to the headline.') },
  { id: 'cta-specific', cat: 'Call to action', sev: 'medium', label: 'CTA text is specific',
    run: m => { const list = primaryCtas(m); if (!list.length) return null; const g = list.filter(c => c.generic); return g.length && g.length >= list.length / 2 ? warn(`"${g[0].text}"`, 'Use action + benefit, e.g. "Get my free quote" instead of "Submit" or "Learn more".') : g.length ? info(`${plural(g.length, 'generic button')} like "${g[0].text}"`, 'Rename generic buttons to say what happens next.') : pass('Action-oriented'); } },
  { id: 'cta-focus', cat: 'Call to action', sev: 'medium', label: 'One focused primary action',
    run: m => { const labels = new Set(primaryCtas(m).map(c => c.text.toLowerCase())); return !labels.size ? null : labels.size > 8 ? warn(`${labels.size} different button labels`, 'Too many choices. Pick one primary action and repeat it.') : pass(plural(labels.size, 'label')); } },
  { id: 'cta-repeat', cat: 'Call to action', sev: 'low', label: 'CTA repeated further down the page',
    run: m => { const list = primaryCtas(m); if (m.stats.words < 400 || !list.length) return null; const counts = {}; list.forEach(c => { counts[c.text.toLowerCase()] = (counts[c.text.toLowerCase()] || 0) + 1; }); const late = list.some(c => !c.early); return late && Math.max(...Object.values(counts)) >= 2 ? pass('Repeated') : warn('Only near the top', 'Repeat the main CTA after key sections and at the end of the page.'); } },

  // ---------------------------------------------------------------- Trust & proof
  { id: 'trust-testimonials', cat: 'Trust & proof', sev: 'high', label: 'Testimonials or reviews',
    run: m => m.trust.testimonials ? pass('Found') : fail('None found', 'Add 3+ real testimonials with names, photos or company.') },
  { id: 'trust-ratings', cat: 'Trust & proof', sev: 'medium', label: 'Star ratings or review widget',
    run: m => m.trust.ratings ? pass('Found') : warn('None found', 'Show your Google rating (e.g. ★ 4.9 from 120 reviews) near the CTA.') },
  { id: 'trust-logos', cat: 'Trust & proof', sev: 'medium', label: 'Client logos / "trusted by"',
    run: m => m.trust.logos ? pass('Found') : warn('None found', 'Add a "Trusted by" row of client or partner logos.') },
  { id: 'trust-numbers', cat: 'Trust & proof', sev: 'low', label: 'Proof in numbers',
    run: m => m.trust.numbers ? pass('Found') : warn('None found', 'Add numbers like "500+ projects" or "Since 2015".') },
  { id: 'trust-guarantee', cat: 'Trust & proof', sev: 'low', label: 'Guarantee or risk reversal',
    run: m => m.trust.guarantee ? pass('Found') : warn('None found', 'Reduce risk: money-back guarantee, free revisions or "no contract".') },
  { id: 'trust-certs', cat: 'Trust & proof', sev: 'low', label: 'Certifications, awards or badges',
    run: m => m.trust.certifications ? pass('Found') : info('None found', 'Show certifications, awards or memberships if you have them.') },
  { id: 'trust-cases', cat: 'Trust & proof', sev: 'low', label: 'Case studies or portfolio',
    run: m => m.trust.caseStudies ? pass('Linked') : warn('Not linked', 'Link to case studies or past work to prove results.') },
  { id: 'trust-about', cat: 'Trust & proof', sev: 'low', label: 'About page / team',
    run: m => m.trust.about || m.trust.team ? pass(m.trust.team ? 'Team shown' : 'About page linked') : warn('Missing', 'Link an About page with real people; it builds credibility.') },
  { id: 'trust-legal', cat: 'Trust & proof', sev: 'low', label: 'Privacy policy and terms',
    run: m => m.trust.privacy && m.trust.terms ? pass('Both linked') : m.trust.privacy || m.trust.terms ? warn(`Missing ${m.trust.privacy ? 'terms' : 'privacy policy'}`, 'Link both in the footer.') : warn('Neither linked', 'Add Privacy Policy and Terms links in the footer.') },
  { id: 'trust-https', cat: 'Trust & proof', sev: 'high', label: 'Secure connection (HTTPS)',
    run: m => m.protocol === 'https:' ? pass('Secure') : fail('Not secure', 'Browsers show "Not secure" on http pages, which kills trust.') },

  // ---------------------------------------------------------------- Contact & support
  { id: 'contact-phone', cat: 'Contact & support', sev: 'medium', label: 'Click-to-call phone number',
    run: m => m.contact.tel ? pass(m.contact.telEarly ? 'In header' : 'Present') : warn('No tel: link', 'Make your phone number a clickable tel: link.') },
  { id: 'contact-early', cat: 'Contact & support', sev: 'medium', label: 'Contact option at the top',
    run: m => m.contact.telEarly || m.contact.contactEarly ? pass('Visible in header') : warn('Not in header', 'Add a phone number or "Contact" button to the header.') },
  { id: 'contact-chat', cat: 'Contact & support', sev: 'medium', label: 'Live chat or WhatsApp',
    run: m => m.contact.whatsapp || m.trackers.chat.length ? pass(m.trackers.chat[0] || 'WhatsApp') : warn('None', 'Add a WhatsApp button or live chat; many visitors prefer messaging.') },
  { id: 'contact-email', cat: 'Contact & support', sev: 'low', label: 'Email address',
    run: m => m.contact.email ? pass('Clickable') : info('No mailto: link', 'Show an email address for visitors who prefer it.') },
  { id: 'contact-page', cat: 'Contact & support', sev: 'low', label: 'Contact page linked',
    run: m => m.contact.contactLink ? pass('Linked') : warn('Not found', 'Link a Contact page in the menu.') },
  { id: 'contact-address', cat: 'Contact & support', sev: 'low', label: 'Physical address / map',
    run: m => m.contact.address || m.contact.map ? pass(m.contact.map ? 'Map embedded' : 'Address shown') : info('Not found', 'Local businesses convert better with an address and map.') },

  // ---------------------------------------------------------------- Forms & lead capture
  { id: 'lead-capture', cat: 'Forms & lead capture', sev: 'high', label: 'Way to capture leads',
    run: m => leadForms(m).length || m.trackers.booking.length || m.contact.whatsapp || m.trackers.chat.length ? pass([leadForms(m).length && plural(leadForms(m).length, 'form'), m.trackers.booking[0], m.contact.whatsapp && 'WhatsApp'].filter(Boolean).join(', ') || 'Chat') : fail('None', 'Add a short enquiry form, booking widget or WhatsApp button.') },
  { id: 'form-fields', cat: 'Forms & lead capture', sev: 'high', label: 'Short forms (5 fields or fewer)',
    run: m => { const f = leadForms(m); if (!f.length) return null; const max = Math.max(...f.map(x => x.fields.length)); return max > 7 ? fail(`${max} fields`, 'Every extra field lowers completions. Keep name, email/phone and one question.') : max > 5 ? warn(`${max} fields`, 'Try cutting to 3–5 fields.') : pass(`${max} fields`); } },
  { id: 'form-labels', cat: 'Forms & lead capture', sev: 'medium', label: 'Form fields have labels',
    run: m => { const fields = m.forms.flatMap(f => f.fields); if (!fields.length) return null; const n = fields.filter(f => !f.hasLabel).length; return n ? warn(`${n} of ${fields.length} unlabeled`, 'Add visible labels; placeholder-only fields confuse people and screen readers.') : pass('All labeled'); } },
  { id: 'form-types', cat: 'Forms & lead capture', sev: 'low', label: 'Correct input types (email, tel)',
    run: m => { const fields = m.forms.flatMap(f => f.fields); if (!fields.length) return null; const bad = fields.filter(f => f.type === 'text' && /email|e-mail|phone|mobile|tel/.test(f.hint)); return bad.length ? warn(plural(bad.length, 'field'), 'Use type="email" and type="tel" so phones show the right keyboard.') : pass('OK'); } },
  { id: 'form-autocomplete', cat: 'Forms & lead capture', sev: 'low', label: 'Autofill enabled',
    run: m => { const f = leadForms(m).flatMap(x => x.fields); if (!f.length) return null; return f.some(x => x.autocomplete) ? pass('autocomplete used') : warn('No autocomplete', 'Add autocomplete="name", "email", "tel" so browsers fill forms instantly.'); } },
  { id: 'form-submit', cat: 'Forms & lead capture', sev: 'medium', label: 'Specific submit button text',
    run: m => { const f = leadForms(m); if (!f.length) return null; const g = f.filter(x => !x.submit || /^(submit|send|go|ok)$/i.test(x.submit)); return g.length ? warn(`"${g[0].submit || 'no text'}"`, 'Say what they get: "Get my free quote", "Book my call".') : pass(`"${f[0].submit}"`); } },
  { id: 'form-privacy', cat: 'Forms & lead capture', sev: 'low', label: 'Privacy reassurance near form',
    run: m => { const f = leadForms(m); if (!f.length) return null; return f.some(x => x.privacyNote) ? pass('Present') : info('Missing', 'Add "We never share your details" under the form.'); } },
  { id: 'form-captcha', cat: 'Forms & lead capture', sev: 'low', label: 'No visible CAPTCHA friction',
    run: m => { const f = leadForms(m); if (!f.length) return null; return f.some(x => x.captcha) ? info('CAPTCHA found', 'Prefer invisible checks (Turnstile, honeypot) over puzzle CAPTCHAs.') : pass('None'); } },
  { id: 'newsletter', cat: 'Forms & lead capture', sev: 'low', label: 'Email signup / lead magnet',
    run: m => m.forms.some(f => f.isNewsletter) || m.trackers.popup.length ? pass(m.trackers.popup[0] || 'Signup form') : info('None', 'Capture visitors who are not ready to buy with a newsletter or free guide.') },

  // ---------------------------------------------------------------- Offer & urgency
  { id: 'offer', cat: 'Offer & urgency', sev: 'medium', label: 'Clear offer or incentive',
    run: m => m.offer.free || m.offer.discount ? pass(m.offer.discount ? 'Discount' : 'Free offer') : warn('None', 'Give a reason to act now: free consultation, free audit, first-order discount.') },
  { id: 'pricing', cat: 'Offer & urgency', sev: 'low', label: 'Pricing is visible or linked',
    run: m => m.offer.pricing ? pass('Found') : info('No prices', 'Showing a starting price ("from $299") filters leads and builds trust.') },
  { id: 'urgency', cat: 'Offer & urgency', sev: 'low', label: 'Urgency or scarcity',
    run: m => m.offer.urgency ? pass('Found') : info('None', 'Honest urgency ("only 3 slots this month") can lift conversions.') },
  { id: 'faq', cat: 'Offer & urgency', sev: 'medium', label: 'FAQ to handle objections',
    run: m => m.offer.faq ? pass('Found') : warn('No FAQ', 'Answer the top 5 objections (price, time, process) in an FAQ.') },

  // ---------------------------------------------------------------- Navigation
  { id: 'nav-exists', cat: 'Navigation', sev: 'medium', label: 'Clear main navigation',
    run: m => m.nav.exists || m.nav.items.length ? pass(plural(m.nav.items.length, 'menu item')) : warn('No <nav> found', 'Add a simple header menu.') },
  { id: 'nav-size', cat: 'Navigation', sev: 'low', label: 'Menu is not overloaded',
    run: m => m.nav.items.length > 12 ? warn(plural(m.nav.items.length, 'item'), 'Keep 5–7 top-level items; group the rest.') : m.nav.items.length ? pass(plural(m.nav.items.length, 'item')) : null },
  { id: 'logo-home', cat: 'Navigation', sev: 'low', label: 'Logo links to homepage',
    run: m => m.logoHome ? pass('Yes') : warn('Not detected', 'Make the logo link back to the homepage.') },
  { id: 'breadcrumb', cat: 'Navigation', sev: 'low', label: 'Breadcrumbs on inner pages',
    run: m => m.path === '/' ? null : m.breadcrumb ? pass('Found') : info('None', 'Breadcrumbs help visitors (and Google) understand where they are.') },
  { id: 'search', cat: 'Navigation', sev: 'low', label: 'Site search (for larger sites)',
    run: m => m.links.filter(l => l.internal).length < 60 ? null : m.searchBox ? pass('Found') : info('None', 'Large sites and stores should offer search.') },

  // ---------------------------------------------------------------- Copy & readability
  { id: 'copy-you', cat: 'Copy & readability', sev: 'medium', label: 'Customer-focused copy ("you" vs "we")',
    run: m => { const { you, we } = m.stats; if (you + we < 5) return null; return you >= we ? pass(`${you} "you" vs ${we} "we"`) : warn(`${you} "you" vs ${we} "we"`, 'Talk about the customer more than yourself. Rewrite "We offer…" as "You get…".'); } },
  { id: 'copy-readability', cat: 'Copy & readability', sev: 'medium', label: 'Easy to read',
    run: m => m.stats.flesch == null ? null : m.stats.flesch >= 60 ? pass(`Reading ease ${m.stats.flesch}`) : m.stats.flesch >= 40 ? warn(`Reading ease ${m.stats.flesch}`, 'Use shorter sentences and everyday words.') : fail(`Reading ease ${m.stats.flesch}`, 'Hard to read. Simplify the copy.') },
  { id: 'copy-sentences', cat: 'Copy & readability', sev: 'low', label: 'Short sentences',
    run: m => !m.stats.sentences ? null : m.stats.avgSentence > 22 ? warn(`${m.stats.avgSentence} words avg`, 'Aim for under 20 words per sentence.') : pass(`${m.stats.avgSentence} words avg`) },
  { id: 'copy-scannable', cat: 'Copy & readability', sev: 'medium', label: 'Scannable (headings, lists, short paragraphs)',
    run: m => { const h2 = m.headings.filter(h => h.level === 2).length; const long = m.paragraphs.filter(n => n > 90).length; const ok = (h2 >= 2 || m.stats.words < 300) && long <= 1; return ok ? pass(`${h2} sections, ${m.lists} list items`) : warn(`${h2} sections, ${long} long paragraphs`, 'Break text into sections with subheadings and bullet points.'); } },
  { id: 'copy-length', cat: 'Copy & readability', sev: 'low', label: 'Enough detail to convince',
    run: m => m.stats.words >= 250 ? pass(`${m.stats.words} words`) : warn(`${m.stats.words} words`, 'Explain the problem, solution, proof and next step.') },

  // ---------------------------------------------------------------- Media
  { id: 'media-hero', cat: 'Media', sev: 'medium', label: 'Hero image or video',
    run: m => m.media.heroMedia ? pass('Present') : warn('None at the top', 'Show your product, team or result in the hero.') },
  { id: 'media-video', cat: 'Media', sev: 'low', label: 'Explainer or testimonial video',
    run: m => m.media.video ? pass(plural(m.media.video, 'video')) : info('None', 'A short video can lift conversions on service pages.') },
  { id: 'media-alt', cat: 'Media', sev: 'low', label: 'Images described for accessibility',
    run: m => { const t = m.images.length; if (!t) return null; const n = m.images.filter(i => i.alt === undefined).length; return n ? warn(`${n} of ${t} without alt`, 'Describe images with alt text.') : pass('All described'); } },

  // ---------------------------------------------------------------- Mobile & accessibility
  { id: 'mobile-viewport', cat: 'Mobile & accessibility', sev: 'high', label: 'Mobile-friendly viewport',
    run: m => !m.viewport ? fail('Missing', 'Without a viewport tag the page renders tiny on phones.') : pass('OK') },
  { id: 'mobile-zoom', cat: 'Mobile & accessibility', sev: 'medium', label: 'Pinch-zoom allowed',
    run: m => !m.viewport ? null : m.a11y.zoomBlocked ? warn('Zoom disabled', 'Remove user-scalable=no / maximum-scale=1 so people can zoom.') : pass('Allowed') },
  { id: 'a11y-buttons', cat: 'Mobile & accessibility', sev: 'medium', label: 'Buttons have readable labels',
    run: m => m.a11y.emptyButtons ? warn(plural(m.a11y.emptyButtons, 'button') + ' with no label', 'Add text or aria-label to icon buttons.') : pass('OK') },
  { id: 'a11y-links', cat: 'Mobile & accessibility', sev: 'low', label: 'Links have readable labels',
    run: m => m.a11y.emptyLinks ? warn(plural(m.a11y.emptyLinks, 'link') + ' with no label', 'Add text or aria-label to icon links (e.g. social icons).') : pass('OK') },
  { id: 'a11y-lang', cat: 'Mobile & accessibility', sev: 'low', label: 'Page language set',
    run: m => m.lang ? pass(m.lang) : warn('Missing', 'Add lang to <html> for screen readers and translation.') },
  { id: 'speed-server', cat: 'Mobile & accessibility', sev: 'medium', label: 'Fast first response',
    run: m => m.timeMs < 1000 ? pass(`${(m.timeMs / 1000).toFixed(2)} s`) : warn(`${(m.timeMs / 1000).toFixed(2)} s`, 'Every second of delay costs conversions. Add caching and a CDN.') },

  // ---------------------------------------------------------------- Measurement
  { id: 'track-analytics', cat: 'Measurement', sev: 'high', label: 'Analytics installed',
    run: m => m.trackers.analytics.length ? pass(m.trackers.analytics.join(', ')) : fail('None detected', "You can't improve what you don't measure. Install GA4 or another analytics tool.") },
  { id: 'track-heatmap', cat: 'Measurement', sev: 'medium', label: 'Heatmaps / session recordings',
    run: m => m.trackers.heatmap.length ? pass(m.trackers.heatmap.join(', ')) : warn('None detected', 'Install Microsoft Clarity (free) to see where visitors click and drop off.') },
  { id: 'track-ads', cat: 'Measurement', sev: 'low', label: 'Ad conversion pixels',
    run: m => m.trackers.ads.length ? pass(m.trackers.ads.join(', ')) : info('None detected', 'If you run ads, install the Meta Pixel / Google Ads tag to track conversions.') },
  { id: 'track-consent', cat: 'Measurement', sev: 'low', label: 'Cookie consent',
    run: m => m.trackers.consent.length ? pass(m.trackers.consent.join(', ')) : m.trackers.analytics.length || m.trackers.ads.length ? info('No consent banner detected', 'Required if you have EU/UK visitors (GDPR).') : null },

  // ---------------------------------------------------------------- Ecommerce (only on stores)
  { id: 'shop-cart', cat: 'Ecommerce', sev: 'high', label: 'Add-to-cart / buy button',
    run: m => !m.commerce.isStore ? null : m.commerce.addToCart ? pass('Found') : info('Not on this page', 'Product pages need a clear "Add to cart" above the fold.') },
  { id: 'shop-shipping', cat: 'Ecommerce', sev: 'medium', label: 'Shipping info visible',
    run: m => !m.commerce.isStore ? null : m.commerce.shipping ? pass('Mentioned') : warn('Not mentioned', 'Unexpected shipping costs are the #1 reason for abandoned carts. Show them early.') },
  { id: 'shop-returns', cat: 'Ecommerce', sev: 'medium', label: 'Returns / refund policy',
    run: m => !m.commerce.isStore ? null : m.commerce.returns ? pass('Mentioned') : warn('Not mentioned', 'Link your returns policy near the buy button.') },
  { id: 'shop-payments', cat: 'Ecommerce', sev: 'low', label: 'Payment options shown',
    run: m => !m.commerce.isStore ? null : m.commerce.payments ? pass('Shown') : warn('Not shown', 'Show accepted payment icons (Visa, PayPal, bKash…).') },
  { id: 'shop-secure', cat: 'Ecommerce', sev: 'low', label: 'Secure checkout reassurance',
    run: m => !m.commerce.isStore ? null : m.commerce.secure ? pass('Shown') : info('Not shown', 'Add "Secure checkout" near the buy button.') },
  { id: 'shop-reviews', cat: 'Ecommerce', sev: 'medium', label: 'Product reviews',
    run: m => !m.commerce.isStore ? null : m.trust.ratings ? pass('Found') : warn('None', 'Install a reviews app (Judge.me, Loox, Yotpo) and show stars on products.') },
];
