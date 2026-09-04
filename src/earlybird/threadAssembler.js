export async function assembleThread({ scraper, post, waitMs = 90000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!scraper) throw new Error('thread assembler requires scraper');
  if (waitMs > 0) await sleep(waitMs);
  const rootId = post.rootPostId || post.postId || post.id;
  const result = scraper.scrapeFullThread
    ? await scraper.scrapeFullThread(rootId)
    : scraper.scrapeThread
      ? await scraper.scrapeThread(rootId)
      : [post.rawData || post];
  const tweets = Array.isArray(result) ? result : (result?.tweets || result?.thread || [result]);
  return tweets.filter(Boolean).sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
}
