import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { parseCookieString } from '../scrapers/twitter/http/auth.js';

const DENIED_PAGE = /access to x\.com was denied|http error 403|you don't have authorization/i;

export function xBrowserCookies(cookieString = process.env.X_COOKIES || process.env.TWITTER_COOKIES || '') {
  return Object.entries(parseCookieString(cookieString)).map(([name, value]) => ({ name, value, url: 'https://x.com/' }));
}

export function assertTweetEvidence({ pageText = '', articleText = '', hasExpectedStatusLink = true } = {}) {
  if (DENIED_PAGE.test(pageText) || DENIED_PAGE.test(articleText)) throw new Error('X denied access to the post page; evidence screenshot was not created');
  if (!articleText.trim()) throw new Error('X post card was empty; evidence screenshot was not created');
  if (!hasExpectedStatusLink) throw new Error('X post card did not contain the expected status link; evidence screenshot was not created');
}

async function expandTweetCard(card) {
  await card.evaluate(element => {
    for (const control of element.querySelectorAll('[role="button"], a')) {
      if (/^(show more|显示更多|展开)$/i.test(control.textContent?.trim() || '')) control.click();
    }
  });
}

async function addInlineTranslation(card, translation) {
  if (!translation?.trim()) return;
  await card.evaluate((element, value) => {
    const text = element.querySelector('[data-testid="tweetText"]');
    if (!text || element.querySelector('[data-earlybird-translation="true"]')) return;
    const block = document.createElement('div');
    block.dataset.earlybirdTranslation = 'true';
    block.style.cssText = 'margin-top:10px;padding-top:10px;border-top:1px solid rgb(207,217,222);font-size:15px;line-height:1.45;color:rgb(15,20,25);white-space:pre-wrap;';
    block.textContent = value;
    text.insertAdjacentElement('afterend', block);
  }, translation.trim());
}

async function waitForTweetMedia(card) {
  const hasVideo = await card.$('[data-testid="videoPlayer"]');
  if (!hasVideo) return;
  await hasVideo.dispose().catch(() => {});
  const ready = await card.evaluate(async element => {
    element.scrollIntoView({ block: 'center' });
    const video = element.querySelector('[data-testid="videoPlayer"] video');
    if (!video) return false;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || video.poster) return true;
    await Promise.race([
      new Promise(resolve => video.addEventListener('loadeddata', () => resolve(true), { once: true })),
      new Promise(resolve => video.addEventListener('canplay', () => resolve(true), { once: true })),
      new Promise(resolve => setTimeout(resolve, 12000)),
    ]);
    return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || Boolean(video.poster);
  });
  if (!ready) throw new Error('X post video did not render a preview frame; evidence screenshot was not created');
}

async function findTweetCard(page, postId) {
  const cards = await page.$$('article[data-testid="tweet"]');
  for (const card of cards) {
    const statusLink = await card.$(`a[href*="/status/${postId}"]`);
    if (!statusLink) continue;
    await statusLink.dispose().catch(() => {});
    return card;
  }
  return null;
}

export async function captureEvidence({ tweetUrl, postId, translation = '', showTranslation = true, outputPath, browser, launchOptions = {}, thread = [] } = {}) {
  if (!tweetUrl || !outputPath) throw new Error('tweetUrl and outputPath are required');
  if (postId && !/^\d+$/.test(String(postId))) throw new Error('postId must be a numeric X status ID');
  await mkdir(dirname(outputPath), { recursive: true });
  const sandboxArgs = process.env.PUPPETEER_NO_SANDBOX === 'true' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
  const ownBrowser = browser || await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    ...launchOptions,
    args: ['--disable-blink-features=AutomationControlled', ...sandboxArgs, ...(launchOptions.args || [])],
  });
  const page = await ownBrowser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
    const cookies = xBrowserCookies();
    if (cookies.length) await page.setCookie(...cookies);
    const match = new URL(tweetUrl).pathname.match(/^\/([^/]+)\/status\/\d+/);
    const profileUrl = match ? `https://x.com/${match[1]}` : tweetUrl;
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const initialPageText = await page.evaluate(() => document.body?.innerText || '');
    assertTweetEvidence({ pageText: initialPageText, articleText: 'pending' });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
    let shot = postId ? await findTweetCard(page, postId) : (await page.$$('article[data-testid="tweet"]'))[0];
    if (!shot && profileUrl !== tweetUrl) {
      await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });
      shot = postId ? await findTweetCard(page, postId) : (await page.$$('article[data-testid="tweet"]'))[0];
    }
    if (!shot) throw new Error('X post card was not found; evidence screenshot was not created');
    const [pageText, articleText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || ''),
      shot.evaluate(element => element.innerText || ''),
    ]);
    assertTweetEvidence({ pageText, articleText });
    await expandTweetCard(shot);
    await waitForTweetMedia(shot);
    if (showTranslation) await addInlineTranslation(shot, translation);
    const raw = await shot.screenshot({ path: outputPath, type: 'png' });
    return { path: resolve(outputPath), bytes: (await readFile(outputPath)).length, rawBytes: raw.length };
  } finally {
    await page.close().catch(() => {});
    if (!browser) await ownBrowser.close().catch(() => {});
  }
}
