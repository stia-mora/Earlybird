// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { assembleThread } from './threadAssembler.js';
import { renderGzhMarkdown, validateGzhHtml } from './gzhRenderer.js';
import { captureEvidence } from './evidenceCapture.js';
import { isNonemptyFile, sanitizeUnicode } from './utils.js';

function compactText(value, max = 500) {
  return sanitizeUnicode(String(value || '')).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Tool 1: 抓推 (fetch_tweet_thread)
 * 抓取指定推文及其所属的完整推文串（Thread），获取原文、作者、发表时间、完整上下文与媒体附件信息。
 */
export function createFetchTweetThreadTool({ scraperFactory, defaultScraper, logger = console } = {}) {
  return {
    name: 'fetch_tweet_thread',
    label: '抓取推文及上下文',
    description: '抓取指定推文及其所属的完整推文串（Thread），获取原文、作者、发表时间、完整上下文与媒体附件信息。用于补齐发帖背景和后续回复。',
    parameters: Type.Object({
      tweetUrl: Type.Optional(Type.String({ description: '推文 URL，例如 https://x.com/username/status/123456' })),
      postId: Type.Optional(Type.String({ description: '推文 ID' })),
      author: Type.Optional(Type.String({ description: '推文作者 handle（无前缀@）' })),
      waitMs: Type.Optional(Type.Number({ description: '等待回复的毫秒数，默认为 0' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const postId = params.postId || (params.tweetUrl?.match(/status\/(\d+)/)?.[1]) || '';
        const author = params.author || (params.tweetUrl?.match(/(?:x|twitter)\.com\/([^/]+)\/status/)?.[1]) || '';
        const sourceUrl = params.tweetUrl || (postId ? `https://x.com/${author || 'user'}/status/${postId}` : '');
        const post = {
          id: postId,
          postId,
          authorUsername: author,
          sourceUrl,
          text: '',
          rawData: { id: postId },
        };
        const scraper = defaultScraper || (scraperFactory ? await scraperFactory({ handle: author }) : null);
        if (!scraper) {
          return {
            content: [{ type: 'text', text: `抓推失败：未配置推文抓取器（scraper）` }],
            details: { error: 'no scraper configured' },
            isError: true,
          };
        }
        const thread = await assembleThread({
          scraper,
          post,
          waitMs: params.waitMs ?? 0,
          timeoutMs: 30000,
          logger,
        });
        const tweetsSummary = (thread || []).map((t, idx) => ({
          index: idx + 1,
          id: t.id || t.id_str,
          author: t.author?.username || t.user?.screen_name || author,
          text: t.text || t.full_text || '',
          createdAt: t.createdAt || t.created_at,
          mediaUrls: (t.extended_entities?.media || t.entities?.media || []).map(m => m.media_url_https || m.url).filter(Boolean),
        }));
        const fullContent = tweetsSummary.map(t => `[#${t.index} @${t.author}]: ${t.text}`).join('\n\n');
        return {
          content: [{
            type: 'text',
            text: fullContent || `成功检索推文，但未返回正文内容。推文数：${tweetsSummary.length}`,
          }],
          details: { thread: tweetsSummary, count: tweetsSummary.length },
          structuredContent: { tweets: tweetsSummary },
        };
      } catch (err) {
        logger.warn?.('fetch_tweet_thread tool failed:', err.message);
        return {
          content: [{ type: 'text', text: `抓推出现异常：${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },
  };
}

/**
 * Tool 2: 网页检索 (search_web_research)
 * 在全网检索最新事实背景、官方公告、技术博客、对比评测或第三方报道，返回可信引用与来源链接。
 */
export function createSearchWebResearchTool({ imageSearch, tavilySearch, logger = console } = {}) {
  const searcher = imageSearch || tavilySearch;
  return {
    name: 'search_web_research',
    label: '网页搜索与深度调研',
    description: '在全网检索最新事实背景、官方公告、技术博客、对比评测或权威报道，返回可信引用与来源链接。用于事实核查、背景增量和技术说明。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索关键词或核查问题，例如 "DeepSeek V3 official release benchmark"' }),
      domains: Type.Optional(Type.Array(Type.String(), { description: '限定检索的域名列表，如 huggingface.co, github.com 等' })),
      count: Type.Optional(Type.Number({ description: '返回结果数量，默认 5' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        if (!searcher) {
          return {
            content: [{ type: 'text', text: `网页检索未配置（缺少 Tavily 或搜索接口）` }],
            details: { error: 'searcher not configured' },
            isError: true,
          };
        }
        const count = params.count || 5;
        let results = [];
        if (typeof searcher.search === 'function') {
          results = await searcher.search(params.query, { count, domains: params.domains });
        } else if (typeof searcher === 'function') {
          results = await searcher(params.query, { count, domains: params.domains });
        }
        const items = (Array.isArray(results) ? results : results?.results || []).slice(0, count);
        if (!items.length) {
          return {
            content: [{ type: 'text', text: `未找到关于 "${params.query}" 的相关搜索结果。` }],
            details: { query: params.query, count: 0 },
          };
        }
        const formatted = items.map((item, idx) => {
          const title = item.title || item.name || 'Untitled';
          const url = item.url || item.sourcePageUrl || item.imageUrl || '';
          const snippet = item.snippet || item.description || item.content || '';
          return `${idx + 1}. [${title}](${url})\n   摘要: ${compactText(snippet, 300)}`;
        }).join('\n\n');
        return {
          content: [{ type: 'text', text: formatted }],
          details: { query: params.query, results: items },
          structuredContent: { results: items },
        };
      } catch (err) {
        logger.warn?.('search_web_research tool failed:', err.message);
        return {
          content: [{ type: 'text', text: `网页搜索失败：${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },
  };
}

/**
 * Tool 3: 推文截图 / 存证 (capture_tweet_evidence)
 * 使用无头浏览器对指定推文进行截图存证，生成带真实时间戳与作者样式的证据图片，可用作文章插图。
 */
export function createCaptureTweetEvidenceTool({ evidence = captureEvidence, mediaDir = process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', logger = console } = {}) {
  return {
    name: 'capture_tweet_evidence',
    label: '推文截图存证',
    description: '使用无头浏览器对指定推文进行真实截图存证（含作者、时间戳、正文及媒体海报），生成已验证的高清事实证据图片，用作公众号插图。',
    parameters: Type.Object({
      tweetUrl: Type.String({ description: '推文的完整 URL，例如 https://x.com/elonmusk/status/123456789' }),
      postId: Type.String({ description: '推文 ID' }),
      translation: Type.Optional(Type.String({ description: '配图下方的中文译文说明' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const postId = params.postId || params.tweetUrl?.match(/status\/(\d+)/)?.[1] || 'tweet';
        const outputPath = join(mediaDir, `${postId}-evidence.png`);
        await evidence({
          tweetUrl: params.tweetUrl,
          postId,
          translation: params.translation || '',
          outputPath,
        });
        const hasFile = await isNonemptyFile(outputPath);
        if (!hasFile) {
          throw new Error('Screenshot file was not produced or is empty');
        }
        return {
          content: [{
            type: 'text',
            text: `已成功生成推文截图存证：${outputPath}。可在文章 Markdown 中使用: ![推文证据截图](${outputPath})`,
          }],
          details: { localPath: outputPath, tweetUrl: params.tweetUrl, postId: params.postId },
          structuredContent: { localPath: outputPath, tweetUrl: params.tweetUrl, postId: params.postId },
        };
      } catch (err) {
        logger.warn?.('capture_tweet_evidence tool failed:', err.message);
        return {
          content: [{ type: 'text', text: `推文截图存证失败：${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },
  };
}

/**
 * Tool 4: 公众号排版与合规校验 (render_gzh_draft)
 * 将 Markdown 初稿按微信公众号（Graphite规范）渲染为 HTML，并进行结构合规与标签校验。
 */
export function createRenderGzhDraftTool({ runValidator, logger = console } = {}) {
  return {
    name: 'render_gzh_draft',
    label: '公众号排版与格式合规校验',
    description: '将 Markdown 正文按微信公众号专用 Graphite 样式渲染为 HTML，并进行合规检查（禁止粗体下划线等原始标记残留、单段字数超限、标题层级及图片配置）。',
    parameters: Type.Object({
      markdown: Type.String({ description: '待渲染校验的完整 Markdown 正文' }),
      title: Type.String({ description: '文章主标题' }),
      digest: Type.String({ description: '文章摘要导读（12-60字）' }),
      contentType: Type.Optional(Type.String({ description: '文章类型：brief（快讯）/ explainer（深度解读）/ event（事件报道）' })),
      references: Type.Optional(Type.Array(Type.String(), { description: '引用来源链接列表' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const html = await renderGzhMarkdown(params.markdown, {
          title: params.title,
          digest: params.digest,
          contentType: params.contentType || 'brief',
          references: params.references || [],
        });
        let validatorResult = 'valid';
        try {
          await validateGzhHtml(html, { run: runValidator });
        } catch (validationErr) {
          validatorResult = validationErr.message;
        }
        const isValid = validatorResult === 'valid' || !validatorResult.includes('failed');
        const summary = [
          `HTML 渲染成功（长度：${html.length} 字符）。`,
          `合规校验状态：${isValid ? '通过 (Compliant)' : '存在告警或违规'}`,
          isValid ? '' : `违规详情：\n${validatorResult}`,
        ].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: summary }],
          details: {
            isValid,
            htmlLength: html.length,
            validationReport: validatorResult,
          },
          structuredContent: { isValid, htmlLength: html.length },
          isError: !isValid,
        };
      } catch (err) {
        logger.warn?.('render_gzh_draft tool failed:', err.message);
        return {
          content: [{ type: 'text', text: `排版渲染失败：${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },
  };
}

/**
 * Tool 5: X 平台关联检索 (search_x_posts)
 * 在 X 平台上检索与该事件相关的行业大V讨论、官方声明或后续补充推文。
 */
export function createSearchXPostsTool({ xSearch, logger = console } = {}) {
  return {
    name: 'search_x_posts',
    label: 'X平台关联讨论检索',
    description: '在 X 平台上检索与该事件相关的行业大V讨论、官方声明或后续补充推文，用于扩充事实或核查争议。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索关键词，例如 "from:sama Orion model" 或 "DeepSeek V3"' }),
      limit: Type.Optional(Type.Number({ description: '最多返回条数，默认 5' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        if (!xSearch) {
          return {
            content: [{ type: 'text', text: 'X 平台检索未配置或不可用' }],
            details: { error: 'xSearch not configured' },
            isError: true,
          };
        }
        const limit = params.limit || 5;
        let tweets = [];
        if (typeof xSearch.search === 'function') {
          tweets = await xSearch.search(params.query, { limit });
        } else if (typeof xSearch === 'function') {
          tweets = await xSearch(params.query, { limit });
        }
        const items = (Array.isArray(tweets) ? tweets : []).slice(0, limit);
        if (!items.length) {
          return {
            content: [{ type: 'text', text: `在 X 上未检索到与 "${params.query}" 相关的推文。` }],
            details: { query: params.query, count: 0 },
          };
        }
        const text = items.map((t, idx) => {
          const author = t.author?.username || t.author || 'unknown';
          const tweetText = t.text || '';
          const url = t.url || (t.id ? `https://x.com/${author}/status/${t.id}` : '');
          return `${idx + 1}. [@${author}](${url}): ${compactText(tweetText, 250)}`;
        }).join('\n\n');
        return {
          content: [{ type: 'text', text }],
          details: { query: params.query, results: items },
          structuredContent: { tweets: items },
        };
      } catch (err) {
        logger.warn?.('search_x_posts tool failed:', err.message);
        return {
          content: [{ type: 'text', text: `X 平台检索失败：${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },
  };
}

/**
 * Tool 6: 封面图创作与生成 (generate_cover_image)
 * Agent 自主构思视觉隐喻并调用图像模型生成 900x383 微信公众号封面图。
 */
export function createGenerateCoverImageTool({ coverImageGenerator, logger = console } = {}) {
  return {
    name: 'generate_cover_image',
    label: '公众号封面图生成',
    description: '由 Agent 自主构思创意视觉隐喻，调用图像模型生成符合微信公众号规范（900x383, 2.35:1 宽幅无字科技插画）的文章封面。',
    parameters: Type.Object({
      prompt: Type.String({ description: '由你自主构思的英文生图提示词或视觉主体隐喻描述，例如 "a glowing robotic arm delicately adjusting an intricate holographic clockwork mechanism, dark cosmic background with cyan and warm amber rim lights, minimalist 3D rendering, no text"' }),
      visualMetaphor: Type.Optional(Type.String({ description: '中文视觉隐喻构思说明，阐释为什么这样设计封面' })),
      style: Type.Optional(Type.String({ description: '可选风格预设：editorial（科技编辑，默认）/ cyberpunk（赛博朋克）/ minimalist（极简3D）/ clay（粘土）/ photorealistic（微距拟真）/ flat（扁平矢量）' })),
      postId: Type.Optional(Type.String({ description: '推文或文章任务 ID' })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        if (!coverImageGenerator) {
          return {
            content: [{ type: 'text', text: '封面图生成器未配置或不可用' }],
            details: { error: 'coverImageGenerator not configured' },
            isError: true,
          };
        }
        const result = await coverImageGenerator.generate({
          postId: params.postId || `agent-cover-${Date.now()}`,
          prompt: params.prompt,
          coverPrompt: params.prompt,
          style: params.style,
          analysis: { facts: [] },
          editorial: { contentType: 'brief' },
        });
        if (result.status === 'disabled') {
          return {
            content: [{ type: 'text', text: '封面生图已在配置中禁用，将降级使用文章正文素材' }],
            details: result,
          };
        }
        return {
          content: [{
            type: 'text',
            text: `封面图生成成功！\n文件路径: ${result.localPath}\n尺寸: ${result.width}x${result.height} (${result.aspect})\n采用模型: ${result.model}\n视觉构思: ${params.visualMetaphor || '自主构思'}`,
          }],
          details: { ...result, visualMetaphor: params.visualMetaphor, prompt: params.prompt },
          structuredContent: { ...result, visualMetaphor: params.visualMetaphor, prompt: params.prompt },
        };
      } catch (err) {
        logger.warn?.('generate_cover_image tool failed:', err.message);
        return {
          content: [{ type: 'text', text: `封面图生成失败：${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },
  };
}

/**
 * 集中创建并打包 EarlyBird Pi Agent 工具集合
 */
export function createEarlyBirdTools({
  scraperFactory,
  defaultScraper,
  imageSearch,
  tavilySearch,
  evidence,
  mediaDir,
  runValidator,
  xSearch,
  coverImageGenerator,
  logger = console,
} = {}) {
  const fetchTweetThread = createFetchTweetThreadTool({ scraperFactory, defaultScraper, logger });
  const searchWebResearch = createSearchWebResearchTool({ imageSearch, tavilySearch, logger });
  const captureTweetEvidence = createCaptureTweetEvidenceTool({ evidence, mediaDir, logger });
  const renderGzhDraft = createRenderGzhDraftTool({ runValidator, logger });
  const searchXPosts = createSearchXPostsTool({ xSearch, logger });
  const generateCoverImage = createGenerateCoverImageTool({ coverImageGenerator, logger });

  return [fetchTweetThread, searchWebResearch, captureTweetEvidence, renderGzhDraft, searchXPosts, generateCoverImage];
}
