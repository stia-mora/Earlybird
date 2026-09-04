import { join } from 'node:path';
import { assembleThread } from './threadAssembler.js';
import { analyzePost, createMultimodalClient } from './aiPipeline.js';
import { humanize } from './humanizer.js';
import { renderGzhMarkdown } from './gzhRenderer.js';
import { captureEvidence } from './evidenceCapture.js';
import { createMediaPipeline } from './mediaPipeline.js';
import { createArticleWriter } from './articleWriter.js';
import { createWeChatClient } from './wechatClient.js';

export function createArticlePipeline({ prisma, scraperFactory, llmClient = createMultimodalClient(), wechatClient = createWeChatClient(), mediaPipeline = createMediaPipeline({ prisma }), evidence = captureEvidence, logger = console } = {}) {
  const writer = createArticleWriter({ client: llmClient });
  return {
    async process(jobId, { force = false } = {}) {
      const job = await prisma.earlyBirdArticleJob.findUnique({ where: { id: jobId }, include: { post: true, source: true, draft: true } });
      if (!job) throw new Error(`EarlyBird job not found: ${jobId}`);
      if (job.draft?.mediaId || (job.status === 'verified' && !force)) return job;
      try {
        const scraper = await scraperFactory(job.source);
        const thread = await assembleThread({ scraper, post: job.post, waitMs: Number(process.env.EARLYBIRD_THREAD_WAIT_MS || 90000) });
        await prisma.earlyBirdPost.update({ where: { id: job.postId }, data: { threadData: thread } });
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'captured', attempts: { increment: 1 }, error: null } });
        const evidencePath = join(process.env.EARLYBIRD_MEDIA_DIR || './data/earlybird/media', `${job.post.postId}-evidence.png`);
        const assets = await mediaPipeline.collect({ post: job.post, thread });
        await evidence({ tweetUrl: job.post.sourceUrl, translation: '', outputPath: evidencePath, thread });
        const analysis = await analyzePost({ client: llmClient, post: job.post.rawData, thread, assets, evidencePath });
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'analyzed', metadata: analysis } });
        await evidence({ tweetUrl: job.post.sourceUrl, translation: analysis.translation, outputPath: evidencePath, thread });
        const article = await writer.write({ post: job.post, thread, analysis, evidencePath, sourceUrl: job.post.sourceUrl });
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'written', markdown: article.markdown } });
        const polished = await humanize({ client: llmClient, markdown: article.markdown, context: { postId: job.post.postId, analysis } });
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: polished.manualReview ? 'manual_review' : 'humanized', markdown: polished.markdown, humanizerScore: polished.score } });
        if (polished.manualReview) return prisma.earlyBirdArticleJob.findUnique({ where: { id: job.id } });
        let evidenceSrc = evidencePath;
        const assetUrls = new Map();
        if (!wechatClient) {
          const html = await renderGzhMarkdown(polished.markdown, { evidencePath, title: article.title, digest: article.digest, sourceUrl: job.post.sourceUrl });
          return prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'rendered', html } });
        }
        if (wechatClient?.uploadArticleImage) {
          const uploadedEvidence = await wechatClient.uploadArticleImage(evidencePath);
          evidenceSrc = uploadedEvidence.url || evidencePath;
        }
        const imageAssets = assets.filter(asset => asset.kind === 'image' && asset.localPath);
        let thumb = null;
        if (imageAssets[0]) thumb = await wechatClient.uploadPermanentMaterial(imageAssets[0].localPath, 'thumb');
        else thumb = await wechatClient.uploadPermanentMaterial(evidencePath, 'thumb');
        for (const asset of imageAssets) {
          const uploaded = await wechatClient.uploadArticleImage(asset.localPath);
          if (uploaded.url) assetUrls.set(asset.localPath, uploaded.url);
          await prisma.earlyBirdAsset.update({ where: { id: asset.id }, data: { wechatUrl: uploaded.url, status: 'uploaded' } });
        }
        for (const asset of assets.filter(item => item.kind === 'video' && item.localPath)) {
          const uploaded = await wechatClient.uploadPermanentMaterial(asset.localPath, 'video', { description: { title: `X 视频 ${job.post.postId}`, introduction: 'EarlyBird 视频素材，仅供草稿编辑使用。' } });
          await prisma.earlyBirdAsset.update({ where: { id: asset.id }, data: { wechatMediaId: uploaded.media_id, status: 'uploaded' } });
        }
        const markdownForRender = [...assetUrls.entries()].reduce((value, [localPath, url]) => value.replaceAll(localPath, url), polished.markdown);
        const html = await renderGzhMarkdown(markdownForRender, { evidencePath: evidenceSrc, title: article.title, digest: article.digest, sourceUrl: job.post.sourceUrl });
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'rendered', html } });
        const draft = await wechatClient.addDraft({ title: article.title.slice(0, 64), author: process.env.WECHAT_AUTHOR || '', digest: article.digest?.slice(0, 120), content: html, content_source_url: job.post.sourceUrl, thumb_media_id: thumb?.media_id || '' });
        const verified = await wechatClient.getDraft(draft.media_id);
        if (!verified?.news_item && !verified?.media_id) throw new Error('WeChat draft verification returned no article');
        await prisma.earlyBirdDraft.upsert({ where: { jobId: job.id }, update: { mediaId: draft.media_id, verification: verified, verified: Boolean(verified?.news_item || verified?.media_id), requestSummary: { title: article.title, sourceUrl: job.post.sourceUrl } }, create: { jobId: job.id, mediaId: draft.media_id, verification: verified, verified: Boolean(verified?.news_item || verified?.media_id), requestSummary: { title: article.title, sourceUrl: job.post.sourceUrl } } });
        return prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'verified' } });
      } catch (error) {
        logger.error?.('EarlyBird article failed', jobId, error);
        await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'failed', error: error.message } });
        throw error;
      }
    },
  };
}
