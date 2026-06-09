// HTML → Markdown conversion for Microsoft Loop pages — ported verbatim from
// loop_de_loop/lib/html-to-markdown.js. Wraps Turndown with a checkbox-list-item
// rule (Loop uses checkboxes for todos) and prepends YAML frontmatter so the
// downstream atomize/consult pass has source provenance.

import TurndownService from 'turndown';

function firstNonWhitespaceChild(node) {
  let n = node.firstChild;
  while (n && n.nodeType === 3 && !n.textContent.trim()) n = n.nextSibling;
  return n;
}

function createTurndownService() {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
  });

  td.remove(['head', 'title', 'style', 'script', 'meta', 'link']);

  // Loop renders todos as <li><input type="checkbox" [checked]> text</li>.
  // Preserve the checkbox state as GFM task-list syntax.
  td.addRule('loopCheckboxListItem', {
    filter: function (node) {
      if (node.nodeName !== 'LI') return false;
      const first = firstNonWhitespaceChild(node);
      if (!first || first.nodeName !== 'INPUT') return false;
      const type = first.getAttribute('type');
      return type && type.toLowerCase() === 'checkbox';
    },
    replacement: function (content, node) {
      const input = firstNonWhitespaceChild(node);
      const isChecked = input && (
        input.hasAttribute('checked') ||
        input.getAttribute('checked') === 'checked' ||
        input.getAttribute('checked') === ''
      );
      const mark = isChecked ? 'x' : ' ';
      const text = content.replace(/^\s+/, '').replace(/\s+$/, '');
      return `- [${mark}] ${text}\n`;
    },
  });

  return td;
}

function yamlValue(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));   // quote strings — colons/ISO timestamps stay safe
}

export function buildFrontmatter(meta) {
  if (!meta || Object.keys(meta).length === 0) return '';
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${k}: []`); }
      else { lines.push(`${k}:`); for (const item of v) lines.push(`- ${yamlValue(item)}`); }
      continue;
    }
    lines.push(`${k}: ${yamlValue(v)}`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

export function loopHtmlToMarkdown(html, meta = {}) {
  const td = createTurndownService();
  const body = td.turndown(html || '').trim().replace(/\n{3,}/g, '\n\n');
  const frontmatter = buildFrontmatter(meta);
  return frontmatter + body + '\n';
}

export { createTurndownService };
