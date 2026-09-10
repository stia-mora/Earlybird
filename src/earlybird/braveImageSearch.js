import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function extension(url, contentType) {
  if (contentType === 'image/png') return '.png';
  if (contentType === 'image/webp') return '.webp';
  if (contentType === 'image/gif') return '.gif';
  const suffix = extname(url.pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(suffix) ? suffix : '.jpg';
}

function compact(value, maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

export function normalizeBraveImageResult(result, query) {
  const imageUrl = safeUrl(result?.properties?.url || result?.thumbnail?.src);
  const sourcePageUrl = safeUrl(result?.url);
  if (!imageUrl || !sourcePageUrl) return null;
  return {
    imageUrl: imageUrl.toString(),
    sourcePageUrl: sourcePageUrl.toString(),
    sourceDomain: sourcePageUrl.hostname,
    title: compact(result?.title),
    query: compact(query),
    width: Number(result?.properties?.width || result?.thumbnail?.width || 0) || null,
    height: Number(result?.properties?.height || result?.thumbnail?.height || 0) || null,
  };
}

export function createBraveImageSearch({ apiKey = process.env.EARLYBIRD_BRAVE_SEARCH_API_KEY, fetchImpl = globalThis.fetch, endpoint = 'https://api.search.brave.com/res/v1/images/search' } = {}) {
  return {
    configured: Boolean(apiKey),
    async search(query, { count = 8 } = {}) {
      if (!apiKey) return [];
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ q: compact(query, 400), count: String(Math.max(1, Math.min(20, count))), safesearch: 'strict', search_lang: 'en', country: 'ALL' }).toString();
      const response = await fetchImpl(url, { headers: { accept: 'application/json', 'x-subscription-token': apiKey } });
      const data = await response.json();
      if (!response.ok) throw new Error(`Brave image search failed (${response.status}): ${compact(data?.message || data?.error, 180)}`);
      return (data.results || []).map(result => normalizeBraveImageResult(result, query)).filter(Boolean);
    },
  };
}

export async function collectBraveImages({ search = createBraveImageSearch(), prisma, post, visualPlan = [], needed = 0, outputDir = process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', fetchImpl = globalThis.fetch, logger = console } = {}) {
  if (!post || needed <= 0 || !search.configured) return [];
  await mkdir(outputDir, { recursive: true });
  const assets = [];
  const seen = new Set();
  for (const plan of visualPlan) {
    if (assets.length >= needed) break;
    let results = [];
    try {
      results = await search.search(plan.query);
    } catch (error) {
      logger.warn?.('EarlyBird Brave image search failed', error.message);
      continue;
    }
    for (const result of results) {
      if (assets.length >= needed || seen.has(result.imageUrl)) continue;
      seen.add(result.imageUrl);
      try {
        const response = await fetchImpl(result.imageUrl, { signal: AbortSignal.timeout(30000) });
        const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
        if (!response.ok || !ALLOWED_MIME_TYPES.has(contentType)) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) continue;
        const digest = createHash('sha256').update(buffer).digest('hex');
        const localPath = join(outputDir, `${post.postId}-brave-${digest.slice(0, 16)}${extension(new URL(result.imageUrl), contentType)}`);
        await writeFile(localPath, buffer);
        const data = {
          postId: post.id,
          kind: 'web-image',
          sourceUrl: result.imageUrl,
          localPath,
          sha256: digest,
          mimeType: contentType,
          status: 'ready',
          metadata: {
            provider: 'brave-image-search',
            sourcePageUrl: result.sourcePageUrl,
            sourceDomain: result.sourceDomain,
            title: result.title,
            query: result.query,
            purpose: compact(plan.purpose),
            altText: compact(plan.altText || result.title || '来自网页检索的图片', 120),
            attribution: `图片来源：${result.sourceDomain}`,
            retrievedAt: new Date().toISOString(),
            width: result.width,
            height: result.height,
          },
        };
        const asset = prisma?.earlyBirdAsset?.upsert
          ? await prisma.earlyBirdAsset.upsert({ where: { postId_sourceUrl: { postId: post.id, sourceUrl: result.imageUrl } }, update: data, create: data })
          : { ...data, id: `brave-${assets.length}` };
        assets.push(asset);
      } catch (error) {
        logger.warn?.('EarlyBird Brave image download failed', result.imageUrl, error.message);
      }
    }
  }
  return assets;
}
