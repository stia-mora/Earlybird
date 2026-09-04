import { readFile } from 'node:fs/promises';
import { escapeHtml, fullWidthPunctuation } from './utils.js';

const GRAPHITE = "max-width:677px;margin:0 auto;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#52525B;line-height:1.8;letter-spacing:0.3px;overflow-x:hidden;";
const BODY = 'font-size:15px;color:#52525B;line-height:1.8;margin:0 0 18px;';

export async function loadGzhSources(root = new URL('../../vendor/references/gzh-design/references/', import.meta.url)) {
  const [theme, common] = await Promise.all([readFile(new URL('theme-graphite-minimal.md', root), 'utf8'), readFile(new URL('common-components.md', root), 'utf8')]);
  return { theme, common };
}

function markKeywords(text) {
  const plain = fullWidthPunctuation(text).trim();
  if (!plain) return '';
  const match = plain.match(/[\u4e00-\u9fff]{4,12}/)?.[0] || plain.split(/\s+/).slice(0, 3).join(' ');
  const index = plain.indexOf(match);
  if (index < 0) return `<span leaf="">${escapeHtml(plain)}</span>`;
  return `<span leaf="">${escapeHtml(plain.slice(0, index))}</span><span style="border-bottom:2px solid #52525B;font-weight:600;"><span leaf="">${escapeHtml(match)}</span></span><span leaf="">${escapeHtml(plain.slice(index + match.length))}</span>`;
}

function inline(text) {
  const links = [];
  const protectedText = String(text).replace(/\[(.+?)\]\((https?:\/\/[^)]+)\)/g, (_match, label, url) => {
    links.push({ label, url });
    return `@@LINK${links.length - 1}@@`;
  });
  let value = escapeHtml(fullWidthPunctuation(protectedText));
  value = value.replace(/\*\*(.+?)\*\*/g, '<strong><span leaf="$1">$1</span></strong>');
  links.forEach(({ label, url }, index) => { value = value.replace(`@@LINK${index}@@`, `<a href="${escapeHtml(url)}" style="color:#52525B;text-decoration:underline;">${escapeHtml(fullWidthPunctuation(label))}</a>`); });
  if (value.includes('<')) {
    return value.replace(/(^|>)([^<]+)(?=<|$)/g, (match, prefix, text) => {
      if (!/[\u4e00-\u9fff]/.test(text) || text.includes('leaf=')) return match;
      return `${prefix}${markKeywords(text)}`;
    });
  }
  return markKeywords(value);
}

export async function renderGzhMarkdown(markdown, { evidencePath, title, digest, sourceUrl } = {}) {
  await loadGzhSources();
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const sections = [];
  let current = null;
  let inCode = false;
  let code = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('```')) { if (inCode) { sections.push(`<section style="margin:20px 10px;padding:14px;background:#27272A;color:#FFFFFF;overflow-x:auto;"><p style="font-size:13px;line-height:1.6;margin:0;"><span leaf="">${escapeHtml(code.join('\n'))}</span></p></section>`); code = []; } inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^##\s+(.+)/);
    if (heading) { current = { title: heading[1], body: [] }; sections.push(current); continue; }
    if (line.startsWith('# ')) continue;
    if (line.trim()) { if (!current) { current = { title: '导读', body: [] }; sections.push(current); } current.body.push(line); }
  }
  let html = `<section style="${GRAPHITE}">`;
  if (evidencePath) html += `<section style="padding:10px 10px 24px;"><img src="${escapeHtml(evidencePath)}" style="max-width:100%;height:auto;display:block;margin:0 auto;"><p style="font-size:12px;color:#A1A1AA;margin:8px 0 0;text-align:center;"><span leaf="">原帖证据截图</span></p></section>`;
  if (title) html += `<h1 style="font-size:24px;line-height:1.4;color:#27272A;margin:24px 10px 12px;"><span leaf="">${escapeHtml(fullWidthPunctuation(title))}</span></h1>`;
  if (digest) html += `<p style="font-size:16px;color:#3F3F46;margin:0 10px 24px;border-left:3px solid #52525B;padding-left:12px;"><span leaf="">${escapeHtml(fullWidthPunctuation(digest))}</span></p>`;
  sections.forEach((section, index) => {
    html += `<section style="margin-top:${index ? 56 : 16}px;margin-bottom:28px;padding:0 10px;"><section style="padding-bottom:14px;border-bottom:1px solid #E4E4E7;"><p style="font-size:42px;font-weight:900;color:#E4E4E7;margin:0;line-height:1;"><span leaf="">${String(index + 1).padStart(2, '0')}</span></p><h3 style="font-size:20px;font-weight:800;color:#27272A;margin:0;line-height:1.4;"><span leaf="">${escapeHtml(fullWidthPunctuation(section.title))}</span></h3></section>`;
    for (const item of section.body) {
      const image = item.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (image) {
        if (evidencePath && (image[1].includes('证据') || image[2] === evidencePath)) continue;
        html += `<img src="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}" style="max-width:100%;height:auto;display:block;margin:20px auto;">`;
        continue;
      }
      if (/^[-*]\s+/.test(item)) { html += `<p style="${BODY}padding-left:14px;"> <span leaf="">• </span>${markKeywords(item.replace(/^[-*]\s+/, ''))}</p>`; continue; }
      if (/^>\s?/.test(item)) { html += `<p style="${BODY}border-left:3px solid #52525B;padding-left:12px;color:#3F3F46;"><span leaf="">${escapeHtml(fullWidthPunctuation(item.replace(/^>\s?/, '')))}</span></p>`; continue; }
      html += `<p style="${BODY}">${inline(item)}</p>`;
    }
    html += '</section>';
  });
  if (sourceUrl) html += `<p style="font-size:12px;color:#A1A1AA;margin:32px 10px;text-align:center;"><span leaf="">来源：${escapeHtml(sourceUrl)}</span></p>`;
  return `${html}</section>`;
}
