import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { escapeHtml, fullWidthPunctuation } from './utils.js';
import { MAX_PARAGRAPH_LENGTH, sanitizeEditorialMarkdown } from './articleWriter.js';

const execFileAsync = promisify(execFile);
const validatorPath = fileURLToPath(new URL('../../scripts/validate_gzh_html.py', import.meta.url));

const GRAPHITE = "max-width:677px;margin:0 auto;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#52525B;line-height:1.8;letter-spacing:0.3px;overflow-x:hidden;";
const BODY = 'font-size:15px;color:#52525B;line-height:1.8;margin:0 0 18px;';

export async function loadGzhSources(root = new URL('../../vendor/references/gzh-design/references/', import.meta.url)) {
  const [theme, common] = await Promise.all([readFile(new URL('theme-graphite-minimal.md', root), 'utf8'), readFile(new URL('common-components.md', root), 'utf8')]);
  return { theme, common };
}

export async function validateGzhHtml(html, { run } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'earlybird-gzh-'));
  const path = join(directory, 'article.html');
  try {
    assertGzhTypography(html);
    await writeFile(path, html, 'utf8');
    const report = run
      ? await run(path)
      : (await execFileAsync(process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'), [validatorPath, path], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })).stdout;
    if (/\b(?:ERROR|WARNING)\b/.test(report)) throw new Error(report.trim());
    return report;
  } catch (error) {
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();
    throw new Error(`gzh HTML validation failed: ${detail}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function assertGzhTypography(html) {
  if (/\*{2,}/.test(html)) throw new Error('raw Markdown emphasis marker found in HTML');
  const paragraphs = [...String(html).matchAll(/<p style="font-size:15px[^\"]*">([\s\S]*?)<\/p>/g)];
  for (const paragraph of paragraphs) {
    const text = paragraph[1].replace(/<[^>]+>/g, '').replace(/&(?:nbsp|amp|lt|gt|quot);/g, ' ').trim();
    if (text.length > MAX_PARAGRAPH_LENGTH) throw new Error(`body paragraph exceeds ${MAX_PARAGRAPH_LENGTH} characters`);
  }
}

const HIGHLIGHT_PATTERNS = [
  /(?:AI\s*失配(?:事件)?|失配事件披露框架|安全事件响应|代理系统|模型部署|监管机构|开源模型|推理能力|上下文窗口|训练数据|开发者工具)/i,
  /(?:20\d{2}年(?:\d{1,2}月(?:\d{1,2}日)?)?|[\d,.]+(?:万|亿|％|%|次|家|项|天|小时|分钟|倍))/,
  /\b(?:OpenAI|Anthropic|Google(?:\s+DeepMind)?|DeepMind|xAI|Hugging Face|ChatGPT|Codex|Claude|Gemini|Grok|GPT(?:-\d+(?:\.\d+)?)?)\b/i,
];

function plainText(text) {
  return fullWidthPunctuation(String(text).replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')).trim();
}

function findHighlightPhrase(text) {
  const plain = plainText(text);
  for (const pattern of HIGHLIGHT_PATTERNS) {
    const match = plain.match(pattern)?.[0];
    if (match) return match;
  }
  return '';
}

function markKeywords(text, emphasis = '') {
  const plain = plainText(text);
  if (!plain || !emphasis) return `<span leaf="">${escapeHtml(plain)}</span>`;
  const index = plain.indexOf(emphasis);
  if (index < 0) return `<span leaf="">${escapeHtml(plain)}</span>`;
  return `<span leaf="">${escapeHtml(plain.slice(0, index))}</span><span style="border-bottom:2px solid #52525B;font-weight:600;"><span leaf="">${escapeHtml(emphasis)}</span></span><span leaf="">${escapeHtml(plain.slice(index + emphasis.length))}</span>`;
}

function inline(text, emphasis = '') {
  return markKeywords(text, emphasis);
}

function referenceUrls(references, maximum = 8) {
  const urls = new Set();
  for (const reference of references || []) {
    try {
      const url = new URL(reference);
      if (url.protocol === 'https:') urls.add(url.toString());
    } catch {}
  }
  return [...urls].slice(0, maximum);
}

function normalizedTitle(value) {
  return plainText(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function imageAttribution(src, imageAttributions) {
  const norm = String(src || '').replace(/\\/g, '/');
  return (imageAttributions || []).find(item => item?.src === src || String(item?.src || '').replace(/\\/g, '/') === norm) || null;
}

export async function renderGzhMarkdown(markdown, { title, digest, contentType, references = [], endVisuals = [], imageAttributions = [] } = {}) {
  await loadGzhSources();
  const lines = sanitizeEditorialMarkdown(markdown, { preserveParagraphs: true }).split('\n');
  const safeTitle = sanitizeEditorialMarkdown(title).replace(/\s*\n\s*/g, ' ');
  const safeDigest = sanitizeEditorialMarkdown(digest).replace(/\s*\n\s*/g, ' ');
  const displayDigest = normalizedTitle(safeDigest) === normalizedTitle(safeTitle) ? '' : safeDigest;
  const sections = [];
  let current = null;
  let inCode = false;
  let code = [];
  let firstContentSeen = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) {
      if (inCode) {
        if (!current) { current = { title: null, body: [] }; sections.push(current); }
        current.body.push({ type: 'code', content: code.join('\n') });
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^#{2,6}\s+(.+)/);
    if (heading) {
      if (!firstContentSeen && normalizedTitle(heading[1]) === normalizedTitle(safeTitle)) { firstContentSeen = true; continue; }
      firstContentSeen = true;
      current = { title: heading[1], body: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith('# ')) continue;
    if (line.trim()) {
      if (!firstContentSeen && normalizedTitle(line) === normalizedTitle(safeTitle)) { firstContentSeen = true; continue; }
      firstContentSeen = true;
      if (!current) { current = { title: null, body: [] }; sections.push(current); }
      current.body.push(line);
    }
  }
  if (inCode && code.length) {
    if (!current) { current = { title: null, body: [] }; sections.push(current); }
    current.body.push({ type: 'code', content: code.join('\n') });
  }
  let html = `<section style="${GRAPHITE}">`;
  if (safeTitle) html += `<h1 style="font-size:24px;line-height:1.4;color:#27272A;margin:24px 10px 12px;"><span leaf="">${escapeHtml(fullWidthPunctuation(safeTitle))}</span></h1>`;
  if (displayDigest) html += `<p style="font-size:16px;color:#3F3F46;margin:0 10px 24px;border-left:3px solid #52525B;padding-left:12px;"><span leaf="">${escapeHtml(fullWidthPunctuation(displayDigest))}</span></p>`;
  let headingNumber = 0;
  let highlightBudget = contentType === 'brief' ? 2 : 5;
  sections.forEach((section, index) => {
    if (typeof section === 'string') {
      html += section;
      return;
    }
    html += `<section style="margin-top:${index ? 56 : 16}px;margin-bottom:28px;padding:0 10px;">`;
    if (section.title) { headingNumber += 1; html += `<section style="padding-bottom:14px;border-bottom:1px solid #E4E4E7;"><p style="font-size:42px;font-weight:900;color:#E4E4E7;margin:0;line-height:1;"><span leaf="">${String(headingNumber).padStart(2, '0')}</span></p><h3 style="font-size:20px;font-weight:800;color:#27272A;margin:0;line-height:1.4;"><span leaf="">${escapeHtml(fullWidthPunctuation(section.title))}</span></h3></section>`; }
    for (const item of (section.body || [])) {
      if (item && typeof item === 'object' && item.type === 'code') {
        html += `<section style="margin:20px 10px;padding:14px;background:#27272A;color:#FFFFFF;overflow-x:auto;"><p style="font-size:13px;line-height:1.6;margin:0;"><span leaf="">${escapeHtml(item.content)}</span></p></section>`;
        continue;
      }
      const image = item.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (image) {
        const caption = sanitizeEditorialMarkdown(image[1]).replace(/\s*\n\s*/g, ' ');
        html += `<img src="${escapeHtml(image[2])}" alt="${escapeHtml(caption)}" style="max-width:100%;height:auto;display:block;margin:20px auto;">`;
        const attribution = imageAttribution(image[2], imageAttributions);
        if (contentType === 'explainer') {
          const source = attribution?.sourceUrl ? plainText(attribution.label || attribution.sourceDomain || '').replace(/^(?:图片)?来源[：:]\s*/, '') : '';
          const note = [caption, source ? `来源：${source}` : ''].filter(Boolean).join(' ');
          if (note) html += `<p style="font-size:13px;color:#71717A;line-height:1.6;margin:-12px 0 20px;"><span leaf="">${escapeHtml(fullWidthPunctuation(note))}</span></p>`;
        } else if (attribution?.sourceUrl) {
          const label = plainText(attribution.label || attribution.sourceDomain || '图片来源');
          html += `<p style="font-size:12px;color:#71717A;line-height:1.6;margin:-12px 0 20px;word-break:break-all;"><span leaf="">${escapeHtml(label)}：${escapeHtml(attribution.sourceUrl)}</span></p>`;
        }
        continue;
      }
      if (/^[-*]\s+/.test(item)) {
        const listText = item.replace(/^[-*]\s+/, '');
        const emphasis = highlightBudget > 0 ? findHighlightPhrase(listText) : '';
        if (emphasis) highlightBudget -= 1;
        html += `<p style="${BODY}padding-left:14px;"> <span leaf="">• </span>${inline(listText, emphasis)}</p>`;
        continue;
      }
      if (/^>\s?/.test(item)) { html += `<p style="${BODY}border-left:3px solid #52525B;padding-left:12px;color:#3F3F46;"><span leaf="">${escapeHtml(fullWidthPunctuation(item.replace(/^>\s?/, '')))}</span></p>`; continue; }
      const emphasis = highlightBudget > 0 ? findHighlightPhrase(item) : '';
      if (emphasis) highlightBudget -= 1;
      html += `<p style="${BODY}">${inline(item, emphasis)}</p>`;
    }
    html += '</section>';
  });
  const sourceUrls = contentType === 'explainer'
    ? referenceUrls([...references, ...imageAttributions.map(item => item?.sourceUrl).filter(Boolean)], Infinity)
    : referenceUrls(references);
  if (sourceUrls.length) {
    html += '<section style="margin:48px 10px 28px;padding-top:20px;border-top:1px solid #E4E4E7;">';
    html += '<p style="font-size:14px;color:#71717A;line-height:1.8;margin:0 0 12px;"><span leaf="">参考资料：</span></p>';
    sourceUrls.forEach(url => {
      html += `<p style="font-size:13px;color:#71717A;line-height:1.8;margin:0 0 8px;word-break:break-all;"><span leaf="">${escapeHtml(url)}</span></p>`;
    });
    html += '</section>';
  }
  for (const visual of endVisuals) {
    const src = visual?.src || visual?.localPath;
    if (!src) continue;
    html += `<section style="margin:0 10px 20px;"><img src="${escapeHtml(src)}" alt="${escapeHtml(plainText(visual.alt || 'EarlyBird Pulse'))}" style="max-width:100%;height:auto;display:block;margin:0 auto;"></section>`;
  }
  return `${html}</section>`;
}
