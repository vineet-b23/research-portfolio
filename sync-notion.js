// sync-notion.js
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('@notionhq/client');
const slugify = require('slugify');

// ───────────────────────── Config ─────────────────────────
const ROOT = __dirname;
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'paper-template.html');
const DATA_PATH = path.join(ROOT, 'data.json');
const MANIFEST_PATH = path.join(ROOT, '.sync-manifest.json');

const BLOCKED_STATUS = 'future work';
// Fail-closed whitelist: anything else (empty, renamed, new status) is NOT published.
const ALLOWED_STATUSES = new Set(['on-going', 'in review', 'published']);
const RESERVED_SLUGS = new Set([
  'index', 'library', 'ongoing', 'in-review', 'published', 
  'styles', 'archive', 'data', 'about', 'template', '404', 'paper-template'
]);
const MAX_BLOCK_DEPTH = 3;
const MIN_GAP_MS = 340; // Notion allows ~3 requests/sec
const DROP_MENTIONS = new Set(['page', 'database', 'user']); // can leak private titles/names

// ───────────────────────── Helpers ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
async function throttle() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

async function withRetry(fn, label, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      await throttle();
      return await fn();
    } catch (err) {
      const retriable =
        err?.status === 429 ||
        err?.status >= 500 ||
        ['rate_limited', 'internal_server_error', 'service_unavailable', 'gateway_timeout',
          'notionhq_client_request_timeout', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err?.code);
      if (!retriable || i >= attempts) throw err;
      const delay = Math.min(1000 * 2 ** (i - 1), 15000) + Math.floor(Math.random() * 300);
      console.warn(`[retry] ${label} failed (${err.code || err.status}); attempt ${i}/${attempts}, waiting ${delay}ms`);
      await sleep(delay);
    }
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const parsed = new URL(u.trim());
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null; // blocks javascript:, data:, etc.
  } catch { return null; }
}

function richToPlain(rich = []) {
  return (rich || [])
    .filter((t) => !(t.type === 'mention' && DROP_MENTIONS.has(t.mention?.type)))
    .map((t) => (t.type === 'equation' ? t.equation?.expression ?? '' : t.plain_text ?? ''))
    .join('');
}

function richToHtml(rich = []) {
  return (rich || []).map((t) => {
    if (t.type === 'mention' && DROP_MENTIONS.has(t.mention?.type)) return '';
    if (t.type === 'equation') {
      return `$${escapeHtml(t.equation?.expression || t.plain_text || '')}$`;
    }
    let s = escapeHtml(t.plain_text ?? '').replace(/\n/g, '<br>');
    const a = t.annotations || {};
    if (a.code) s = `<code>${s}</code>`;
    if (a.bold) s = `<strong>${s}</strong>`;
    if (a.italic) s = `<em>${s}</em>`;
    if (a.strikethrough) s = `<s>${s}</s>`;
    const href = safeUrl(t.href);
    if (href) s = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${s}</a>`;
    return s;
  }).join('');
}

function makeSlug(title, usedSlugs, pageId) {
  let base = slugify(title || '', { lower: true, strict: true, trim: true })
    .slice(0, 80).replace(/-+$/g, '');
  if (!base) base = `paper-${String(pageId).replace(/-/g, '').slice(0, 8)}`;
  if (RESERVED_SLUGS.has(base)) base = `${base}-paper`;
  let slug = base;
  for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
  usedSlugs.add(slug);
  return slug;
}

function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ───────────────────── Property extraction (null-safe) ─────────────────────
function findProp(props, name, types) {
  const key = Object.keys(props || {}).find((k) => k.trim().toLowerCase() === name.toLowerCase());
  const p = key ? props[key] : undefined;
  return p && (!types || types.includes(p.type)) ? p : undefined;
}

function getStatus(props) {
  const p = findProp(props, 'Status', ['select', 'status']);
  return (p?.select?.name ?? p?.status?.name ?? '').trim() || null;
}

function getTitle(props) {
  const p = findProp(props, 'Title', ['title']) ||
    Object.values(props || {}).find((x) => x?.type === 'title'); // fallback: whatever the title column is called
  return richToPlain(p?.title).trim();
}

function extractProperties(page) {
  const props = page.properties || {};
  return {
    title: getTitle(props) || 'Untitled',
    status: getStatus(props),
    abstract: richToPlain(findProp(props, 'Abstract', ['rich_text'])?.rich_text).trim(),
    topics: (findProp(props, 'Topics', ['multi_select'])?.multi_select || []).map((o) => o.name).filter(Boolean),
    link: safeUrl(findProp(props, 'Links', ['url'])?.url),
    bibtex: richToPlain(findProp(props, 'BibTeX', ['rich_text'])?.rich_text).trim(),
  };
}

// SECURITY: single choke point. Fail-closed.
function isPublishable(page) {
  if (page?.object !== 'page' || !page.properties) return false;
  if (page.archived || page.in_trash) return false;
  const status = (getStatus(page.properties) || '').toLowerCase();
  if (status === BLOCKED_STATUS) return false;
  if (!ALLOWED_STATUSES.has(status)) {
    console.warn(`[skip] page ${page.id} has unrecognised/missing Status "${status}" - not published`);
    return false;
  }
  return true;
}

// ───────────────────── Notion fetching ─────────────────────
async function queryAllPages(notion, databaseId) {
  const pages = [];
  let cursor;
  do {
    const res = await withRetry(() => notion.databases.query({
      database_id: databaseId,
      filter: { property: 'Status', status: { does_not_equal: 'Future Work' } },
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      start_cursor: cursor,
      page_size: 100,
    }), 'databases.query');
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

const TEXT_BLOCKS = new Set([
  'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item',
  'numbered_list_item', 'to_do', 'quote', 'callout', 'toggle', 'code', 'equation'
]);

function normalizeBlock(b) {
  if (b.type === 'divider') return { type: 'divider', rich: [], children: [] };
  if (b.type === 'equation') {
    const expr = b.equation?.expression || '';
    if (!expr.trim()) return null;
    return { type: 'equation', expression: expr, rich: [], children: [] };
  }
  if (!TEXT_BLOCKS.has(b.type)) return null;
  const data = b[b.type] || {};
  const rich = data.rich_text || [];
  if (!richToPlain(rich).trim() && b.type !== 'toggle') return null;
  return { type: b.type, rich, checked: !!data.checked, language: data.language || '', children: [] };
}

async function fetchBlocks(blockId, depth = 0) {
  const raw = [];
  let cursor;
  do {
    const res = await withRetry(() => notion.blocks.children.list({
      block_id: blockId, start_cursor: cursor, page_size: 100,
    }), `blocks.children.list(${blockId})`);
    raw.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  const nodes = [];
  for (const b of raw) {
    const node = normalizeBlock(b);
    if (!node) continue;
    if (b.has_children && depth < MAX_BLOCK_DEPTH) node.children = await fetchBlocks(b.id, depth + 1);
    nodes.push(node);
  }
  return nodes;
}

// ───────────────────── Rendering ─────────────────────
function blocksToPlain(nodes, depth = 0, out = []) {
  for (const n of nodes) {
    if (n.type === 'equation') {
      out.push({ type: 'equation', text: n.expression, depth });
    } else if (n.type !== 'divider') {
      out.push({ type: n.type, text: richToPlain(n.rich), depth });
    }
    blocksToPlain(n.children, depth + 1, out);
  }
  return out;
}

function blockToHtml(n) {
  const inner = richToHtml(n.rich);
  const kids = n.children.length ? blocksToHtml(n.children) : '';
  switch (n.type) {
    case 'heading_1': return `<h3>${inner}</h3>${kids}`; // page <h1> is reserved for paper title
    case 'heading_2': return `<h4>${inner}</h4>${kids}`;
    case 'heading_3': return `<h5>${inner}</h5>${kids}`;
    case 'equation': return `<div class="math-block">$$\n${escapeHtml(n.expression)}\n$$</div>${kids}`;
    case 'to_do': return `<p class="todo">${n.checked ? '&#9745;' : '&#9744;'} ${inner}</p>${kids}`;
    case 'quote': return `<blockquote>${inner}${kids}</blockquote>`;
    case 'callout': return `<aside class="callout">${inner}${kids}</aside>`;
    case 'toggle': return `<details><summary>${inner}</summary>${kids}</details>`;
    case 'code': {
      const lang = String(n.language).replace(/[^a-z0-9+-]/gi, '');
      return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(richToPlain(n.rich))}</code></pre>`;
    }
    case 'divider': return '<hr>';
    default: return `<p>${inner}</p>${kids}`;
  }
}

function blocksToHtml(nodes) {
  let html = '';
  for (let i = 0; i < nodes.length;) {
    const n = nodes[i];
    if (n.type === 'bulleted_list_item' || n.type === 'numbered_list_item') {
      const tag = n.type === 'bulleted_list_item' ? 'ul' : 'ol';
      let items = '';
      while (i < nodes.length && nodes[i].type === n.type) {
        const li = nodes[i++];
        items += `<li>${richToHtml(li.rich)}${li.children.length ? blocksToHtml(li.children) : ''}</li>`;
      }
      html += `<${tag}>${items}</${tag}>`;
    } else {
      html += blockToHtml(n);
      i++;
    }
  }
  return html;
}

function textToParagraphs(text) {
  return String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function renderPaperHtml(template, paper, timelineHtml) {
  const abstractHtml = textToParagraphs(paper.abstract);
  const content = [
    abstractHtml && `<section class="abstract"><h2>Abstract</h2>${abstractHtml}</section>`,
    timelineHtml && `<section class="timeline"><h2>Timeline</h2>${timelineHtml}</section>`,
  ].filter(Boolean).join('\n');

  const vars = {
    TITLE: escapeHtml(paper.title),
    STATUS: escapeHtml(paper.status || ''),
    ABSTRACT: abstractHtml,
    TIMELINE: timelineHtml,
    CONTENT: content,
    TOPICS: paper.topics.map((t) => `<span class="topic">${escapeHtml(t)}</span>`).join(' '),
    LINK: paper.link ? escapeHtml(paper.link) : '',
    BIBTEX: escapeHtml(paper.bibtex),
  };
  return template.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}

// ───────────────────── Manifest (stale-file cleanup) ─────────────────────
function readManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return Array.isArray(m.files) ? m.files : [];
  } catch { return []; }
}

// ───────────────────── Main ─────────────────────
const apiKey = (process.env.NOTION_API_KEY || '').trim();
const databaseId = (process.env.NOTION_DATABASE_ID || '').trim();
const notion = new Client({ auth: apiKey });

async function main() {
  if (!apiKey || !databaseId) {
    throw new Error('Missing NOTION_API_KEY and/or NOTION_DATABASE_ID environment variables.');
  }

  let template;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read template at ${TEMPLATE_PATH}: ${err.message}`);
  }
  if (!template.includes('{{')) console.warn('[warn] Template contains no {{PLACEHOLDER}} tags.');

  const previousFiles = readManifest();

  console.log('Querying Notion database...');
  const rawPages = await queryAllPages(notion, databaseId);
  const pages = rawPages.filter(isPublishable);
  console.log(`Fetched ${rawPages.length} page(s); ${pages.length} publishable (rest dropped).`);

  if (pages.length === 0 && previousFiles.length > 0 && process.env.ALLOW_EMPTY_SYNC !== 'true') {
    throw new Error('Notion returned 0 publishable papers but the site currently has pages. ' +
      'Refusing to wipe the site. Set ALLOW_EMPTY_SYNC=true if this is intentional.');
  }

  const usedSlugs = new Set();
  const papers = [];
  const outputs = [];
  const failures = [];

  for (const page of pages) {
    try {
      const props = extractProperties(page);
      const slug = makeSlug(props.title, usedSlugs, page.id);
      const blocks = await fetchBlocks(page.id);
      const paper = {
        slug,
        url: `./${slug}.html`,
        title: props.title,
        status: props.status,
        abstract: props.abstract,
        topics: props.topics,
        link: props.link,
        bibtex: props.bibtex,
        timeline: blocksToPlain(blocks),
        created: page.created_time || null,
        updated: page.last_edited_time || null,
      };
      papers.push(paper);
      outputs.push({ file: `${slug}.html`, html: renderPaperHtml(template, paper, blocksToHtml(blocks)) });
      console.log(`  ok  ${paper.url}`);
    } catch (err) {
      failures.push(page.id);
      console.error(`[error] Failed to process page ${page.id}: ${err.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} page(s) failed; aborting without writing any files.`);
  }

  // Write phase
  for (const { file, html } of outputs) writeFileAtomic(path.join(ROOT, file), html);

  papers.reverse();
  writeFileAtomic(DATA_PATH, JSON.stringify(papers, null, 2) + '\n');

  const newFiles = outputs.map((o) => o.file).sort();
  writeFileAtomic(MANIFEST_PATH, JSON.stringify({ files: newFiles }, null, 2) + '\n');

  // Remove pages that no longer qualify
  for (const f of previousFiles) {
    if (newFiles.includes(f)) continue;
    if (!/^[a-z0-9-]+\.html$/.test(f) || RESERVED_SLUGS.has(f.replace(/\.html$/, ''))) continue;
    try {
      fs.unlinkSync(path.join(ROOT, f));
      console.log(`  removed stale ${f}`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[error] Could not remove ${f}: ${err.message}`);
    }
  }

  console.log(`Done. ${papers.length} paper(s) written to data.json and ${outputs.length} HTML file(s).`);
}

main().catch((err) => {
  console.error('[fatal] Notion sync failed:', err?.message || err);
  if (err?.code) console.error('[fatal] code:', err.code, 'status:', err.status);
  process.exit(1);
});