// Throughline "Loop" (Deloop) intake — the minimal slice of loop_de_loop's
// pipeline: list the user's .loop files via Graph, render one to HTML
// (?format=html), and convert it to Markdown. Deliberately NONE of loop_de_loop's
// archive machinery (no jsonl meetings log, no HTML/MD files on disk, no audit) —
// Throughline just needs the converted text to drop into an intake entry.

import { graphGet, graphGetBinary } from './graph-client.js';
import { loopHtmlToMarkdown } from './loop-html.js';

/**
 * List every .loop file in the user's OneDrive (paged Graph search). Returns the
 * fields the picker + the render step need.
 * @returns {Promise<Array<{id, driveId, name, created, modified, path, webUrl, size}>>}
 */
export async function listLoopFiles(token) {
  const results = [];
  let next = "/me/drive/root/search(q='.loop')";
  while (next) {
    const resp = await graphGet(next, token);
    if (Array.isArray(resp?.value)) results.push(...resp.value);
    next = resp?.['@odata.nextLink'] || null;
  }
  return results
    .filter((it) => typeof it?.name === 'string' && it.name.toLowerCase().endsWith('.loop'))
    .map((it) => ({
      id: it.id,
      driveId: it?.parentReference?.driveId || null,
      name: it.name,
      created: it.createdDateTime || null,
      modified: it.lastModifiedDateTime || null,
      path: it?.parentReference?.path || null,
      webUrl: it.webUrl || null,
      size: it.size ?? null,
    }))
    .sort((a, b) => String(b.modified || b.created || '').localeCompare(String(a.modified || a.created || '')));
}

/** Render a .loop file to HTML via Graph's ?format=html conversion. */
export async function fetchLoopHtml(token, driveId, itemId) {
  if (!driveId || !itemId) throw new Error('Missing driveId/itemId for the selected Loop file.');
  const buf = await graphGetBinary(`/drives/${driveId}/items/${itemId}/content?format=html`, token);
  return buf.toString('utf8');
}

/**
 * Fetch + convert a .loop to Markdown (with provenance frontmatter).
 * @param item {id, driveId, name, created, modified, webUrl}
 * @returns {Promise<{markdown, name}>}
 */
export async function loopToMarkdown(token, item) {
  const html = await fetchLoopHtml(token, item.driveId, item.id);
  const meta = {
    source: 'onedrive-loop',
    loop_id: item.id || null,
    original_name: item.name || null,
    created: item.created || null,
    modified: item.modified || null,
    web_url: item.webUrl || null,
    pulled_at: new Date().toISOString(),
  };
  const markdown = loopHtmlToMarkdown(html, meta);
  return { markdown, name: item.name || 'Loop note' };
}
