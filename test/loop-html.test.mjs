// Loop HTML → Markdown converter (Deloop intake). Verifies the turndown-based
// port keeps the structure the atomize/consult pass relies on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopHtmlToMarkdown, buildFrontmatter } from '../lib/loop-html.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'sample-loop.html');

test('loopHtmlToMarkdown converts a Loop page, preserving structure', async () => {
  const html = await readFile(FIXTURE, 'utf8');
  const md = loopHtmlToMarkdown(html, { source: 'onedrive-loop', original_name: 'Dr. Otto Quarterly Review.loop' });

  // ATX headings (not setext) — the converter sets headingStyle: 'atx'.
  assert.match(md, /^# Dr\. Otto Quarterly Review$/m);
  assert.match(md, /^## Action items$/m);

  // Loop checkbox todos survive as GFM task-list items, with state.
  assert.match(md, /- \[x\] Send Q1 quality metrics PDF to Otto by Friday/);
  assert.match(md, /- \[ \] Schedule follow-up with HR re: PA hiring/);

  // Links are kept inline.
  assert.match(md, /\[Q1 metrics dashboard\]\(https:\/\/uhgazure-my\.sharepoint\.com\/dashboards\/q1-metrics\)/);

  // Provenance frontmatter is prepended (NOT in version_hash territory — it's
  // source metadata the intake can read).
  assert.match(md, /^---\n/);
  assert.match(md, /original_name: "Dr\. Otto Quarterly Review\.loop"/);

  // No raw HTML tags leak through.
  assert.ok(!/<\/?(h1|h2|ul|li|input|table)\b/i.test(md), 'should not contain raw HTML tags');
});

test('buildFrontmatter quotes strings and handles arrays/empties', () => {
  const fm = buildFrontmatter({ source: 'onedrive-loop', participants: ['A <a@x>', 'B <b@y>'], empty: [] });
  assert.match(fm, /source: "onedrive-loop"/);
  assert.match(fm, /participants:\n- "A <a@x>"\n- "B <b@y>"/);
  assert.match(fm, /empty: \[\]/);
  assert.equal(buildFrontmatter({}), '');
});
