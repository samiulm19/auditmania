// Fake PageSpeed result for UI testing without calling Google (set MOCK_PSI=1).
export async function mockPsi(url, strategy) {
  await new Promise(r => setTimeout(r, 5000));
  const mobile = strategy === 'mobile';
  return {
    strategy,
    mock: true,
    finalUrl: url,
    fetchedAt: new Date().toISOString(),
    lighthouseVersion: 'mock',
    scores: { performance: mobile ? 47 : 78, accessibility: 86, bestPractices: 92, seo: 83 },
    metrics: [
      { id: 'first-contentful-paint', label: 'First Contentful Paint', value: mobile ? '2.9 s' : '1.1 s', rating: mobile ? 'average' : 'good' },
      { id: 'largest-contentful-paint', label: 'Largest Contentful Paint', value: mobile ? '6.4 s' : '2.3 s', rating: mobile ? 'poor' : 'average' },
      { id: 'total-blocking-time', label: 'Total Blocking Time', value: mobile ? '640 ms' : '120 ms', rating: mobile ? 'poor' : 'good' },
      { id: 'cumulative-layout-shift', label: 'Cumulative Layout Shift', value: '0.08', rating: 'good' },
      { id: 'speed-index', label: 'Speed Index', value: mobile ? '5.2 s' : '1.9 s', rating: mobile ? 'average' : 'good' },
    ],
    field: {
      scope: 'origin', passed: false,
      metrics: [
        { label: 'LCP', value: '3.1 s', rating: 'average' },
        { label: 'INP', value: '0.2 s', rating: 'good' },
        { label: 'CLS', value: '0.04', rating: 'good' },
        { label: 'FCP', value: '2.0 s', rating: 'average' },
        { label: 'TTFB', value: '1.1 s', rating: 'average' },
      ],
    },
    opportunities: [
      { id: 'render-blocking-resources', title: 'Eliminate render-blocking resources', description: 'Resources are blocking the first paint of your page. Consider delivering critical JS/CSS inline and deferring all non-critical JS/styles.', savings: 'Est savings of 1,850 ms', savingsMs: 1850, severity: 'high' },
      { id: 'modern-image-formats', title: 'Serve images in next-gen formats', description: 'Image formats like WebP and AVIF often provide better compression than PNG or JPEG.', savings: 'Est savings of 1,240 KiB', savingsMs: 1200, severity: 'high' },
      { id: 'unused-javascript', title: 'Reduce unused JavaScript', description: 'Reduce unused JavaScript and defer loading scripts until they are required.', savings: 'Est savings of 410 KiB', savingsMs: 900, severity: 'medium' },
      { id: 'offscreen-images', title: 'Defer offscreen images', description: 'Consider lazy-loading offscreen and hidden images after all critical resources have finished loading.', savings: 'Est savings of 380 KiB', savingsMs: 450, severity: 'medium' },
      { id: 'font-display', title: 'Ensure text remains visible during webfont load', description: 'Leverage the font-display CSS feature to ensure text is user-visible while webfonts are loading.', savings: '', savingsMs: 0, severity: 'medium' },
    ],
    seoIssues: [
      { id: 'link-text', title: 'Links do not have descriptive text', description: 'Descriptive link text helps search engines understand your content.', savings: '', savingsMs: 0, severity: 'high' },
      { id: 'image-alt', title: 'Image elements do not have [alt] attributes', description: 'Informative elements should aim for short, descriptive alternate text.', savings: '', savingsMs: 0, severity: 'high' },
    ],
    a11yIssues: [
      { id: 'color-contrast', title: 'Background and foreground colors do not have a sufficient contrast ratio', description: 'Low-contrast text is difficult or impossible for many users to read.', savings: '', savingsMs: 0, severity: 'high' },
    ],
    screenshot: null,
    fullPageScreenshot: null,
  };
}
