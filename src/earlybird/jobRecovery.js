// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
export async function enqueueInterruptedJobs({ prisma, queue, now = () => Date.now(), delayMs = 10000 } = {}) {
  if (!prisma?.earlyBirdArticleJob || !queue) throw new Error('job recovery requires prisma and queue');
  const jobs = await prisma.earlyBirdArticleJob.findMany({
    where: { status: 'failed', error: { contains: 'terminated', mode: 'insensitive' } },
    select: { id: true },
  });
  const runId = now();
  await Promise.all(jobs.map((job, index) => queue.add('process', { jobId: job.id }, {
    jobId: `earlybird-article-recovery-${job.id}-${runId}`,
    delay: delayMs + index * 1000,
    removeOnComplete: 100,
    removeOnFail: 100,
  })));
  return jobs.length;
}

export async function enqueueLegacyEditorialJobs({ prisma, queue, now = () => Date.now(), delayMs = 10000 } = {}) {
  if (!prisma?.earlyBirdArticleJob || !queue) throw new Error('legacy editorial recovery requires prisma and queue');
  const jobs = await prisma.earlyBirdArticleJob.findMany({
    where: { status: { in: ['ignored', 'merged', 'held'] }, draft: null },
    select: { id: true },
  });
  if (!jobs.length) return 0;

  await prisma.earlyBirdArticleJob.updateMany({
    where: { id: { in: jobs.map(job => job.id) } },
    data: { status: 'detected', error: null },
  });
  const runId = now();
  await Promise.all(jobs.map((job, index) => queue.add('process', { jobId: job.id }, {
    jobId: `earlybird-article-policy-retry-${job.id}-${runId}`,
    delay: delayMs + index * 1000,
    removeOnComplete: 100,
    removeOnFail: 100,
  })));
  return jobs.length;
}
