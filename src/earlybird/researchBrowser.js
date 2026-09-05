import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer';
import { fileSha256 } from './utils.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function browserOptions(launchOptions = {}) {
  const sandboxArgs = process.env.PUPPETEER_NO_SANDBOX === 'true' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
  return { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, ...launchOptions, args: [...sandboxArgs, ...(launchOptions.args || [])] };
}

function hostFrom(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

export function officialHosts(websites = []) {
  return [...new Set(websites.map(hostFrom).filter(Boolean))];
}

export function isOfficialUrl(value, hosts = []) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

export function normalizeSearchQueries(queries = []) {
  return [...new Set(queries.map(query => String(query || '').replace(/\s+/g, ' ').trim()).filter(query => query.length >= 3 && query.length <= 120))].slice(0, 3);
}

async function search(page, query, hosts) {
  await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const results = await page.$$eval('li.b_algo h2 a', links => links.map(link => ({ url: link.href, title: link.textContent?.trim() || '' })));
  return results.filter(result => isOfficialUrl(result.url, hosts)).slice(0, 3);
}

async function extractPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page.evaluate(() => {
    const meta = selector => document.querySelector(selector)?.getAttribute('content')?.trim() || '';
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    const text = (root?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
    const images = [...document.images]
      .filter(image => image.naturalWidth >= 320 && image.naturalHeight >= 180)
      .map(image => ({ url: image.currentSrc || image.src, alt: image.alt || '', width: image.naturalWidth, height: image.naturalHeight }))
      .filter(image => image.url.startsWith('https://'))
      .slice(0, 4);
    return { title: document.title?.trim() || '', description: meta('meta[name="description"]') || meta('meta[property="og:description"]'), text, images };
  });
}

export async function researchOfficialSources({ queries = [], websites = [], browser, launchOptions, logger = console } = {}) {
  const hosts = officialHosts(websites);
  const safeQueries = normalizeSearchQueries(queries);
  if (!hosts.length || !safeQueries.length || process.env.EARLYBIRD_RESEARCH_ENABLED === 'false') return { citations: [], images: [], queries: safeQueries };
  const ownBrowser = browser || await puppeteer.launch(browserOptions(launchOptions));
  const page = await ownBrowser.newPage();
  const candidates = new Map();
  try {
    for (const query of safeQueries) {
      try {
        for (const result of await search(page, query, hosts)) candidates.set(result.url, result);
      } catch (error) { logger.warn?.(`EarlyBird research search failed: ${error.message}`); }
    }
    const citations = [];
    const images = [];
    for (const [url, result] of [...candidates].slice(0, Number(process.env.EARLYBIRD_RESEARCH_MAX_PAGES || 4))) {
      try {
        const extracted = await extractPage(page, url);
        if (!isOfficialUrl(page.url(), hosts)) continue;
        if (!extracted.text) continue;
        citations.push({ url, title: extracted.title || result.title, description: extracted.description, excerpt: extracted.text.slice(0, 2400) });
        images.push(...extracted.images.map(image => ({ ...image, pageUrl: url, pageTitle: extracted.title || result.title })));
      } catch (error) { logger.warn?.(`EarlyBird research page failed: ${url} ${error.message}`); }
    }
    return { citations, images: images.filter(image => isOfficialUrl(image.url, hosts)).slice(0, 6), queries: safeQueries, allowedHosts: hosts };
  } finally {
    await page.close().catch(() => {});
    if (!browser) await ownBrowser.close().catch(() => {});
  }
}

function imageExtension(url, contentType) {
  if (/png/i.test(contentType)) return '.png';
  if (/webp/i.test(contentType)) return '.webp';
  if (/gif/i.test(contentType)) return '.gif';
  if (/jpe?g/i.test(contentType)) return '.jpg';
  return extname(new URL(url).pathname).match(/^\.(png|webp|gif|jpe?g)$/i)?.[0] || '.jpg';
}

export async function collectResearchImages({ research, post, prisma, outputDir = process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', fetchImpl = globalThis.fetch, logger = console } = {}) {
  if (!post || !research?.images?.length) return [];
  await mkdir(outputDir, { recursive: true });
  const assets = [];
  for (const [index, image] of research.images.entries()) {
    try {
      if (!isOfficialUrl(image.url, research.allowedHosts || [])) continue;
      const response = await fetchImpl(image.url, { signal: AbortSignal.timeout(30000) });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.startsWith('image/')) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) continue;
      const localPath = join(outputDir, `${post.postId}-research-${index + 1}${imageExtension(image.url, contentType)}`);
      await writeFile(localPath, buffer);
      const data = { postId: post.id, kind: 'image', sourceUrl: image.url, localPath, sha256: await fileSha256(localPath), mimeType: contentType.split(';')[0], status: 'ready', metadata: { researchSourceUrl: image.pageUrl, researchSourceTitle: image.pageTitle, altText: image.alt } };
      assets.push(prisma ? await prisma.earlyBirdAsset.upsert({ where: { postId_sourceUrl: { postId: post.id, sourceUrl: image.url } }, update: data, create: data }) : { ...data, id: `research-${index}` });
    } catch (error) { logger.warn?.(`EarlyBird research image failed: ${error.message}`); }
  }
  return assets;
}
