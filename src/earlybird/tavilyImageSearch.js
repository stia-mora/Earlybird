// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
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

export function normalizeTavilyImageResult(image, query, sourcePageUrl = null) {
  const imageUrl = safeUrl(typeof image === 'string' ? image : image?.url);
  const sourceUrl = safeUrl(sourcePageUrl || image?.source_url || image?.sourcePageUrl || imageUrl);
  if (!imageUrl || !sourceUrl) return null;
  return {
    imageUrl: imageUrl.toString(),
    sourcePageUrl: sourceUrl.toString(),
    sourceDomain: sourceUrl.hostname,
    title: compact(image?.title),
    description: compact(image?.description),
    query: compact(query),
  };
}

export function createTavilyImageSearch({ apiKey = process.env.EARLYBIRD_TAVILY_API_KEY, fetchImpl = globalThis.fetch, endpoint = 'https://api.tavily.com/search' } = {}) {
  async function request(body) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Tavily search failed (${response.status}): ${compact(data?.detail || data?.error || data?.message, 180)}`);
    return data;
  }
  return {
    configured: Boolean(apiKey),
    async search(query, { count = 8 } = {}) {
      if (!apiKey) return [];
      const data = await request({
        query: compact(query, 400),
        max_results: Math.max(1, Math.min(20, count)),
        search_depth: 'basic',
        include_images: true,
        include_image_descriptions: true,
      });
      const nested = (data.results || []).flatMap(result => (result.images || []).map(image => normalizeTavilyImageResult(image, query, result.url)));
      const topLevel = (data.images || []).map(image => normalizeTavilyImageResult(image, query));
      const seen = new Set();
      return [...nested, ...topLevel].filter(Boolean).filter(image => {
        if (seen.has(image.imageUrl)) return false;
        seen.add(image.imageUrl);
        return true;
      });
    },
    async searchWeb(query, { count = 4, includeDomains = [] } = {}) {
      if (!apiKey) return [];
      const data = await request({
        query: compact(query, 400),
        max_results: Math.max(1, Math.min(8, count)),
        search_depth: 'basic',
        include_answer: false,
        include_images: false,
        include_raw_content: false,
        ...(includeDomains.length ? { include_domains: includeDomains.slice(0, 8) } : {}),
      });
      return (data.results || []).map(result => {
        const url = safeUrl(result?.url);
        if (!url) return null;
        return {
          title: compact(result?.title),
          url: url.toString(),
          sourceDomain: url.hostname,
          excerpt: compact(result?.content, 900),
          score: Number(result?.score) || null,
          query: compact(query),
        };
      }).filter(Boolean);
    },
  };
}

export async function collectTavilyImages({ search = createTavilyImageSearch(), prisma, post, visualPlan = [], needed = 0, completePlan = false, existingAssets = [], outputDir = process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', fetchImpl = globalThis.fetch, logger = console } = {}) {
  if (!post || (!completePlan && needed <= 0) || !search.configured) return [];
  await mkdir(outputDir, { recursive: true });
  const assets = [];
  const seen = new Set(existingAssets.map(asset => asset.sourceUrl).filter(Boolean));
  const hashes = new Set(existingAssets.map(asset => asset.sha256).filter(Boolean));
  for (const plan of visualPlan) {
    if (!completePlan && assets.length >= needed) break;
    let planImages = 0;
    let results = [];
    try {
      results = await search.search(plan.query);
    } catch (error) {
      logger.warn?.('EarlyBird Tavily image search failed', error.message);
      continue;
    }
    for (const result of results) {
      // Sample each story node rather than letting the first query fill the quota.
      if (completePlan ? planImages >= 2 : assets.length >= needed) break;
      if (seen.has(result.imageUrl)) continue;
      seen.add(result.imageUrl);
      try {
        const response = await fetchImpl(result.imageUrl, { signal: AbortSignal.timeout(30000) });
        const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
        if (!response.ok || !ALLOWED_MIME_TYPES.has(contentType)) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) continue;
        const digest = createHash('sha256').update(buffer).digest('hex');
        if (hashes.has(digest)) continue;
        hashes.add(digest);
        const localPath = join(outputDir, `${post.postId}-tavily-${digest.slice(0, 16)}${extension(new URL(result.imageUrl), contentType)}`);
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
            provider: 'tavily-search',
            sourcePageUrl: result.sourcePageUrl,
            sourceDomain: result.sourceDomain,
            title: result.title,
            description: result.description,
            query: result.query,
            purpose: compact(plan.purpose),
            sourceStatus: result.sourcePageUrl === result.imageUrl ? 'original-page-missing' : 'search-result-page',
            altText: compact(plan.altText || result.description || result.title || '来自网页检索的图片', 120),
            attribution: `图片来源：${result.sourceDomain}`,
            retrievedAt: new Date().toISOString(),
          },
        };
        const asset = prisma?.earlyBirdAsset?.upsert
          ? await prisma.earlyBirdAsset.upsert({ where: { postId_sourceUrl: { postId: post.id, sourceUrl: result.imageUrl } }, update: data, create: data })
          : { ...data, id: `tavily-${assets.length}` };
        assets.push(asset);
        planImages += 1;
      } catch (error) {
        logger.warn?.('EarlyBird Tavily image download failed', result.imageUrl, error.message);
      }
    }
  }
  return assets;
}
