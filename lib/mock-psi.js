import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePsi } from './psi.js';

// MOCK_PSI=1: returns a real Lighthouse 13 report captured from a test page (lib/fixtures),
// run through the same parser as live Google data. Field data below is sample CrUX data.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const dist = (a, b, c) => [{ min: 0, proportion: a }, { proportion: b }, { proportion: c }];
const SAMPLE_FIELD = {
  overall_category: 'AVERAGE',
  metrics: {
    LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100, category: 'AVERAGE', distributions: dist(0.62, 0.25, 0.13) },
    INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: 'FAST', distributions: dist(0.81, 0.14, 0.05) },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 4, category: 'FAST', distributions: dist(0.9, 0.07, 0.03) },
    FIRST_CONTENTFUL_PAINT_MS: { percentile: 2100, category: 'AVERAGE', distributions: dist(0.66, 0.24, 0.1) },
    EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 1100, category: 'AVERAGE', distributions: dist(0.55, 0.33, 0.12) },
  },
};

export async function mockPsi(url, strategy) {
  await new Promise(r => setTimeout(r, strategy === 'desktop' ? 4000 : 5000));
  const lhr = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, `lhr-${strategy}.json.gz`))).toString('utf8'));
  const data = parsePsi({ id: url, lighthouseResult: lhr, originLoadingExperience: { ...SAMPLE_FIELD, id: url } }, strategy);
  return { ...data, mock: true };
}
