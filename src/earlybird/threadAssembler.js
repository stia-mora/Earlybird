// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { withTimeout } from './utils.js';

export async function assembleThread({ scraper, post, waitMs = 90000, timeoutMs = 60000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), logger = console } = {}) {
  if (!scraper) throw new Error('thread assembler requires scraper');
  if (waitMs > 0) await sleep(waitMs);
  const rootId = post.rootPostId || post.postId || post.id;
  const fallback = [post.rawData || post];
  let result;
  try {
    result = await withTimeout(
      scraper.scrapeFullThread
        ? scraper.scrapeFullThread(rootId)
        : scraper.scrapeThread
          ? scraper.scrapeThread(rootId)
          : fallback,
      timeoutMs,
      'thread fetch',
    );
  } catch (error) {
    logger.warn?.(`EarlyBird thread fetch fell back to the root post: ${error.message}`);
    return fallback;
  }
  const tweets = Array.isArray(result)
    ? result
    : result?.tweets || result?.thread || [result?.rootTweet, ...(result?.authorReplies || [])].filter(Boolean);
  return tweets.filter(Boolean).sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
}
