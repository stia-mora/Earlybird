const SHANGHAI_OFFSET = '+08:00';

function chinaDay(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shanghaiDayRange(now = new Date()) {
  const day = chinaDay(now);
  const start = new Date(`${day}T00:00:00${SHANGHAI_OFFSET}`);
  return { day, start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function compact(value, maximum = 88) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function excludedReason(job) {
  if (!job) return '未进入文章处理队列';
  if (job.status === 'ignored') return `旧版筛选历史：${compact(job.metadata?.editorial?.reason || '该帖未按旧版规则独立制作', 120)}`;
  if (job.status === 'merged') return '旧版事件合并历史';
  if (job.status === 'manual_review') return '质量审校要求人工处理';
  if (job.status === 'failed') return `处理失败：${compact(job.error || '未知错误', 100)}`;
  return `仍在处理中：${job.status}`;
}

export async function buildDailySummary({ prisma, now = new Date() } = {}) {
  if (!prisma) throw new Error('daily summary requires prisma');
  const { day, start, end } = shanghaiDayRange(now);
  const [sources, posts] = await Promise.all([
    prisma.earlyBirdSource.findMany({ where: { enabled: true }, select: { id: true, handle: true } }),
    prisma.earlyBirdPost.findMany({
      where: {
        OR: [
          { createdAt: { gte: start, lt: end } },
          { createdAt: null, capturedAt: { gte: start, lt: end } },
        ],
      },
      include: { source: { select: { id: true, handle: true } }, jobs: { include: { draft: true }, take: 1, orderBy: { updatedAt: 'desc' } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const perSource = new Map(sources.map(source => [source.id, { handle: source.handle, posts: 0, drafts: 0 }]));
  const excluded = [];
  let verifiedDrafts = 0;
  for (const post of posts) {
    const source = perSource.get(post.sourceId) || { handle: post.source?.handle || post.authorUsername, posts: 0, drafts: 0 };
    source.posts += 1;
    perSource.set(post.sourceId, source);
    const job = post.jobs?.[0];
    if (job?.draft?.verified) {
      verifiedDrafts += 1;
      source.drafts += 1;
      continue;
    }
    excluded.push({ handle: source.handle, postId: post.postId, text: compact(post.text), reason: excludedReason(job) });
  }
  const sourceLines = [...perSource.values()].map(source => `@${source.handle}：新帖 ${source.posts} 条，草稿 ${source.drafts} 篇`);
  const reasonCounts = new Map();
  for (const item of excluded) {
    const category = item.reason.split('：')[0];
    reasonCounts.set(category, (reasonCounts.get(category) || 0) + 1);
  }
  const lines = [
    `EarlyBird 日报｜${day}`,
    `已监测官方渠道 ${sources.length} 个；今日新帖 ${posts.length} 条；已验证公众号草稿 ${verifiedDrafts} 篇。`,
    '',
    '按渠道：',
    ...sourceLines,
  ];
  if (!excluded.length) lines.push('', '其余新帖均已制作为草稿。');
  else {
    lines.push('', `未制作 ${excluded.length} 条：`);
    for (const [reason, count] of reasonCounts) lines.push(`- ${reason}：${count} 条`);
    lines.push('', '明细：');
    for (const item of excluded.slice(0, 20)) lines.push(`- @${item.handle}：${item.text || item.postId}；${item.reason}`);
    if (excluded.length > 20) lines.push(`- 另有 ${excluded.length - 20} 条，详见 EarlyBird 轮询与任务记录。`);
  }
  return { day, start, end, sourceCount: sources.length, detectedPosts: posts.length, verifiedDrafts, excluded, message: lines.join('\n') };
}
