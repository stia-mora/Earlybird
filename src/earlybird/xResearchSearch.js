// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import puppeteer from 'puppeteer';
import { configuredXCookies } from './sourceMonitor.js';
import { xBrowserCookies } from './evidenceCapture.js';

function compact(value, maximum = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function browserLaunchOptions() {
  const sandboxArgs = process.env.PUPPETEER_NO_SANDBOX === 'true' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
  return {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--disable-blink-features=AutomationControlled', ...sandboxArgs],
  };
}

export async function searchXViaBrowser({ query, cookieHeader, limit = 6, browser, logger = console } = {}) {
  if (!query) return [];
  if (!cookieHeader) throw new Error('X browser search requires configured cookies');
  const ownBrowser = browser || await puppeteer.launch(browserLaunchOptions());
  const page = await ownBrowser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 960 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
    await page.setCookie(...xBrowserCookies(cookieHeader));
    await page.goto(`https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12000 });
    const tweets = new Map();
    for (let attempt = 0; attempt < 4 && tweets.size < limit; attempt += 1) {
      const items = await page.evaluate(() => Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map(article => {
        const text = article.querySelector('[data-testid="tweetText"]')?.textContent || '';
        const status = article.querySelector('a[href*="/status/"]')?.href || '';
        const username = article.querySelector('[data-testid="User-Name"] a[href^="/"]')?.href?.split('/')[3] || '';
        const createdAt = article.querySelector('time')?.getAttribute('datetime') || null;
        const media = article.querySelectorAll('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]').length;
        const id = status.match(/status\/(\d+)/)?.[1] || null;
        return { id, text, createdAt, author: { username }, media: Array.from({ length: media }) };
      }).filter(item => item.id && item.text));
      for (const item of items) {
        if (tweets.size >= limit) break;
        tweets.set(item.id, item);
      }
      if (tweets.size >= limit) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    return [...tweets.values()];
  } catch (error) {
    logger.warn?.('EarlyBird browser X search failed', compact(error.message));
    throw error;
  } finally {
    await page.close().catch(() => {});
    if (!browser) await ownBrowser.close().catch(() => {});
  }
}

export function createEditorialXSearch({ scraperFactory, cookieLoader = configuredXCookies, browserSearch = searchXViaBrowser, logger = console } = {}) {
  return {
    async search(query, { source, limit = 6 } = {}) {
      let httpError;
      try {
        const scraper = await scraperFactory(source);
        if (typeof scraper?.searchTweets !== 'function') throw new Error('X HTTP scraper does not support searchTweets');
        const tweets = await scraper.searchTweets(query, { limit, type: 'Latest' });
        return { tweets, method: 'http' };
      } catch (error) {
        httpError = error;
        logger.warn?.('EarlyBird HTTP X search failed; trying browser fallback', compact(error.message));
      }
      try {
        const cookieHeader = await cookieLoader();
        const tweets = await browserSearch({ query, cookieHeader, limit, logger });
        return { tweets, method: 'browser', httpError: compact(httpError?.message) };
      } catch (browserError) {
        throw new Error(`X search failed via HTTP (${compact(httpError?.message, 180)}) and browser (${compact(browserError.message, 180)})`);
      }
    },
  };
}
