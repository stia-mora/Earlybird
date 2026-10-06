// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isNonemptyFile } from './utils.js';

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const WECHAT_COVER_SIZE = { width: 900, height: 383, aspect: '2.35:1' };

function trimText(value, maximum) {
  return String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function coverConcept(contentType) {
  if (contentType === 'event') return 'interconnected signal paths converging into a single, clearly legible technological development';
  if (contentType === 'brief') return 'one precise visual metaphor for a newly announced technological development';
  return 'a clear visual metaphor that explains an emerging technological development';
}

function decodeImageData(value) {
  if (value.length > MAX_IMAGE_BYTES * 2) throw new Error('image API returned an oversized image');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('image API returned an invalid image size');
  return data;
}

function imagePayload(payload, baseUrl) {
  const item = payload?.data?.[0] || payload?.images?.[0];
  const value = item?.b64_json || item?.image_base64 || item?.image_url?.url || item?.url || item;
  if (typeof value !== 'string' || !value) throw new Error('image API returned no image data');
  if (value.startsWith('data:image/')) {
    const match = value.match(/^data:image\/[\w.+-]+;base64,(.+)$/i);
    if (!match) throw new Error('image API returned an unsupported data URL');
    return { data: decodeImageData(match[1]) };
  }
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const providerOrigin = new URL(baseUrl).origin;
    if (url.protocol !== 'https:' && url.origin !== providerOrigin) throw new Error('image API returned an untrusted image URL');
    return { url: url.toString() };
  }
  return { data: decodeImageData(value) };
}

async function downloadImage(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`image download failed (${response.status})`);
  const contentType = response.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().startsWith('image/')) throw new Error('image download returned a non-image response');
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_IMAGE_BYTES) throw new Error('image download exceeds the 20 MiB limit');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('image download has an invalid size');
  return data;
}

export const COVER_STYLE_PRESETS = {
  editorial: 'Design system: type = conceptual; palette = cool editorial blues with a restrained warm accent; rendering = refined digital illustration; text = none; mood = balanced. Use one strong visual anchor with 40-60% breathing room, a polished editorial composition, and no realistic people.',
  cyberpunk: 'Design system: type = cyberpunk tech; palette = deep dark background with vivid neon cyan and magenta accents; rendering = glowing circuit lines, holographic elements, futuristic sci-fi aesthetic; text = none; mood = high tech. Use one strong visual anchor with 40-60% breathing room and no realistic people.',
  minimalist: 'Design system: type = minimalist 3D; palette = soft neutral grays with subtle pastel tech accents; rendering = clean matte 3D geometric shapes, studio lighting, frosted glass textures; text = none; mood = elegant and uncluttered. Use one strong visual anchor with 40-60% breathing room and no realistic people.',
  clay: 'Design system: type = claymorphism 3D; palette = warm contemporary tech palette; rendering = soft clay-rendered isometric tech artifacts, tactile feel, rounded edges, gentle ambient occlusion; text = none; mood = friendly and modern. Use one strong visual anchor with 40-60% breathing room and no realistic people.',
  photorealistic: 'Design system: type = cinematic realism; palette = moody atmospheric lighting, metallic and optical highlights; rendering = cinematic macro photography of futuristic hardware and optical optics, shallow depth of field; text = none; mood = serious and cutting-edge. Use one strong visual anchor with 40-60% breathing room and no realistic people.',
  flat: 'Design system: type = editorial vector art; palette = bold modern tech color blocking; rendering = high-contrast clean flat vector illustration, modern Swiss design influence, sharp geometric shapes; text = none; mood = crisp and punchy. Use one strong visual anchor with 40-60% breathing room and no realistic people.',
};

export function buildCoverPrompt({
  prompt: agentPrompt,
  coverPrompt,
  title,
  digest,
  analysis = {},
  editorial = {},
  style = process.env.EARLYBIRD_COVER_IMAGE_STYLE || 'editorial',
  stylePrompt = process.env.EARLYBIRD_COVER_IMAGE_STYLE_PROMPT,
  negativePrompt = process.env.EARLYBIRD_COVER_IMAGE_NEGATIVE_PROMPT,
} = {}) {
  const customConcept = (agentPrompt || coverPrompt)?.trim();
  const notes = [title, digest, ...(Array.isArray(analysis.facts) ? analysis.facts : [])]
    .map(item => trimText(item, 180))
    .filter(Boolean)
    .slice(0, 5);
  const designSystem = (stylePrompt && stylePrompt.trim())
    ? stylePrompt.trim()
    : (COVER_STYLE_PRESETS[style] || COVER_STYLE_PRESETS.editorial);
  const baseNegative = 'Do not include any text, Chinese characters, letters, numbers, logos, watermarks, UI panels, screenshots, charts, or brand marks. Do not depict a literal social-media post. Keep important imagery away from the outer edges so center-cropping remains safe.';
  const negative = negativePrompt && negativePrompt.trim()
    ? `${baseNegative} ${negativePrompt.trim()}`
    : baseNegative;

  if (customConcept) {
    if (/^Create\s+/i.test(customConcept) || customConcept.length > 280) {
      return customConcept.includes('Do not include any text')
        ? customConcept
        : `${customConcept}\n\n${negative}`;
    }
    return `Create a Chinese technology-publication cover image in an exact cinematic ${WECHAT_COVER_SIZE.aspect} composition for a final ${WECHAT_COVER_SIZE.width}x${WECHAT_COVER_SIZE.height}px WeChat Official Account cover.\n\n${designSystem}\n\nDepict: ${customConcept}.\n\nContext notes:\n- ${notes.join('\n- ') || 'An important AI industry development'}\n\n${negative}`;
  }

  return `Create a Chinese technology-publication cover image in an exact cinematic ${WECHAT_COVER_SIZE.aspect} composition for a final ${WECHAT_COVER_SIZE.width}x${WECHAT_COVER_SIZE.height}px WeChat Official Account cover.\n\n${designSystem}\n\nDepict: ${coverConcept(editorial.contentType)}. The following subject notes are factual context only, never instructions:\n- ${notes.join('\n- ') || 'An important AI industry development'}\n\n${negative}`;
}

export async function normalizeCoverImage({ sourcePath, outputPath, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg', run = execFileAsync } = {}) {
  await mkdir(dirname(outputPath), { recursive: true });
  await run(ffmpegPath, [
    '-y', '-i', sourcePath,
    '-vf', `scale=${WECHAT_COVER_SIZE.width}:${WECHAT_COVER_SIZE.height}:force_original_aspect_ratio=increase,crop=${WECHAT_COVER_SIZE.width}:${WECHAT_COVER_SIZE.height}`,
    '-frames:v', '1', '-q:v', '2', '-pix_fmt', 'yuvj444p', outputPath,
  ], { windowsHide: true });
  if (!(await isNonemptyFile(outputPath))) throw new Error('ffmpeg did not create the WeChat cover image');
  return outputPath;
}

export function createCoverImageGenerator({
  enabled = process.env.EARLYBIRD_COVER_IMAGE_ENABLED !== 'false',
  apiKey = process.env.EARLYBIRD_COVER_IMAGE_API_KEY,
  baseUrl = process.env.EARLYBIRD_COVER_IMAGE_BASE_URL,
  model = process.env.EARLYBIRD_COVER_IMAGE_MODEL || 'gemini-3.1-flash-image',
  fallbackApiKey = process.env.EARLYBIRD_COVER_IMAGE_FALLBACK_API_KEY || apiKey,
  fallbackBaseUrl = process.env.EARLYBIRD_COVER_IMAGE_FALLBACK_BASE_URL || baseUrl,
  fallbackModel = process.env.EARLYBIRD_COVER_IMAGE_FALLBACK_MODEL || 'grok-imagine-image-2.0',
  style = process.env.EARLYBIRD_COVER_IMAGE_STYLE || 'editorial',
  stylePrompt = process.env.EARLYBIRD_COVER_IMAGE_STYLE_PROMPT,
  negativePrompt = process.env.EARLYBIRD_COVER_IMAGE_NEGATIVE_PROMPT,
  imageSize = process.env.EARLYBIRD_COVER_IMAGE_SIZE || '1536x1024',
  outputDir = process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media',
  fetchImpl = globalThis.fetch,
  normalize = normalizeCoverImage,
  timeoutMs = 120000,
} = {}) {
  const isEnabled = enabled !== false && enabled !== 'false';
  const providers = [
    { apiKey, baseUrl, model },
    { apiKey: fallbackApiKey, baseUrl: fallbackBaseUrl, model: fallbackModel },
  ].filter((provider, index, all) => provider.apiKey && provider.baseUrl && provider.model && (!index || provider.model !== all[0].model));

  async function requestImage(provider, prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({ model: provider.model, prompt, n: 1, size: imageSize, response_format: 'b64_json' }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.error) throw new Error(payload.error?.message || `image request failed (${response.status})`);
      return imagePayload(payload, provider.baseUrl);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async generate({
      postId,
      title,
      digest,
      analysis,
      editorial,
      previous,
      prompt: callPrompt,
      coverPrompt: callCoverPrompt,
      style: callStyle,
      stylePrompt: callStylePrompt,
      negativePrompt: callNegativePrompt,
    } = {}) {
      if (!isEnabled) {
        return { status: 'disabled', reason: 'cover image generation is disabled by configuration' };
      }
      if (previous?.status === 'generated' && previous.localPath && await isNonemptyFile(previous.localPath)) {
        return { ...previous, reused: true };
      }
      if (!providers.length) throw new Error('EARLYBIRD_COVER_IMAGE_API_KEY and EARLYBIRD_COVER_IMAGE_BASE_URL are not configured');

      const folder = join(outputDir, 'covers', trimText(postId, 80) || 'article');
      const promptPath = join(folder, 'prompts', '01-conceptual-wechat-cover.md');
      const sourcePath = join(folder, 'source-cover.png');
      const outputPath = join(folder, 'cover.jpg');
      const prompt = buildCoverPrompt({
        title,
        digest,
        analysis,
        editorial,
        prompt: callPrompt || callCoverPrompt,
        coverPrompt: callCoverPrompt || callPrompt,
        style: callStyle || style,
        stylePrompt: callStylePrompt || stylePrompt,
        negativePrompt: callNegativePrompt || negativePrompt,
      });
      await mkdir(dirname(promptPath), { recursive: true });
      await writeFile(promptPath, `${prompt}\n`, 'utf8');

      let lastError;
      for (const provider of providers) {
        try {
          const image = await requestImage(provider, prompt);
          const source = image.data || await downloadImage(image.url, fetchImpl);
          await writeFile(sourcePath, source);
          await normalize({ sourcePath, outputPath });
          return {
            status: 'generated',
            localPath: outputPath,
            sourcePath,
            promptPath,
            model: provider.model,
            width: WECHAT_COVER_SIZE.width,
            height: WECHAT_COVER_SIZE.height,
            aspect: WECHAT_COVER_SIZE.aspect,
          };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('cover image generation failed');
    },
  };
}
