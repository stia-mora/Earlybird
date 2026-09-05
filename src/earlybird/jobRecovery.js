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
