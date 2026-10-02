// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { postUrl } from './utils.js';

export function createCapturePipeline({ prisma, mediaPipeline, threadAssembler } = {}) {
  return {
    async capture(jobId, { scraper } = {}) {
      const job = await prisma.earlyBirdArticleJob.findUnique({ where: { id: jobId }, include: { post: true, source: true } });
      if (!job) throw new Error(`EarlyBird job not found: ${jobId}`);
      const thread = threadAssembler ? await threadAssembler({ scraper, post: job.post }) : [job.post.rawData];
      const root = thread[0] || job.post.rawData;
      const assets = mediaPipeline ? await mediaPipeline.collect({ post: job.post, thread }) : [];
      const postRecord = await prisma.earlyBirdPost.update({ where: { id: job.postId }, data: {
        rootPostId: String(root.id || job.post.postId), threadData: thread, mediaData: assets,
        sourceUrl: postUrl(root), capturedAt: new Date(),
      } });
      await prisma.earlyBirdArticleJob.update({ where: { id: job.id }, data: { status: 'captured' } });
      return { job, post: postRecord, thread, assets };
    },
  };
}
