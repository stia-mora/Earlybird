// Copyright (c) 2024-2026 nich (@nichxbt). Licensed under the Apache License, Version 2.0.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

async function hideOverlappingPageChrome(card) {
  await card.evaluate(element => {
    const cardBox = element.getBoundingClientRect();
    for (const candidate of document.body.querySelectorAll('*')) {
      if (candidate.contains(element) || element.contains(candidate)) continue;
      const style = window.getComputedStyle(candidate);
      if (!['fixed', 'sticky'].includes(style.position)) continue;
      const box = candidate.getBoundingClientRect();
      const overlaps = box.width > 0 && box.height > 0
        && box.left < cardBox.right && box.right > cardBox.left
        && box.top < cardBox.bottom && box.bottom > cardBox.top;
      if (overlaps) candidate.style.setProperty('visibility', 'hidden', 'important');
    }
  });
}

const MEDIA_CONTAINER_SELECTOR = '[data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="tweetPhoto"], [data-testid="card.layoutLarge.media"], [data-testid="card.wrapper"], div[aria-label*="video" i]';

async function addInlineTranslation(card, translation) {
  if (!translation?.trim()) return;
  await card.evaluate((element, value) => {
    const text = element.querySelector('[data-testid="tweetText"]');
    if (!text || element.querySelector('[data-earlybird-translation="true"]')) return;
    const block = document.createElement('div');
    block.dataset.earlybirdTranslation = 'true';
    block.style.cssText = 'margin-top:10px;padding:8px 12px;background:rgba(239,243,244,0.6);border-left:3px solid rgb(29,155,240);border-radius:4px;font-size:15px;line-height:1.45;color:rgb(15,20,25);white-space:pre-wrap;';
    const tag = document.createElement('div');
    tag.style.cssText = 'font-size:12px;font-weight:700;color:rgb(29,155,240);margin-bottom:4px;letter-spacing:0.5px;';
    tag.textContent = '中文翻译：';
    block.appendChild(tag);
    const content = document.createElement('div');
    content.textContent = value;
    block.appendChild(content);
    text.insertAdjacentElement('afterend', block);
  }, translation.trim());
}

async function waitForTweetVideoFrame(card, { hasPoster = false } = {}) {
  const hasMedia = await card.$(MEDIA_CONTAINER_SELECTOR);
  if (!hasMedia) return;
  await hasMedia.dispose().catch(() => {});
  const ready = await card.evaluate(async (element, allowPoster) => {
    element.scrollIntoView({ block: 'center' });

    // Wait for all img elements in card to complete loading
    const images = Array.from(element.querySelectorAll('img'));
    await Promise.all(images.map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(resolve => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
        setTimeout(resolve, 8000);
      });
    }));

    if (allowPoster) return true;

    // Check video readiness
    const video = element.querySelector('video');
    const posterImg = element.querySelector('[data-testid="videoPlayer"] img, [data-testid="videoComponent"] img, [data-testid="card.layoutLarge.media"] img');
    if (posterImg && posterImg.complete && posterImg.naturalWidth > 0) return true;
    if (video) {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return true;
      await Promise.race([
        new Promise(resolve => video.addEventListener('loadeddata', () => resolve(true), { once: true })),
        new Promise(resolve => video.addEventListener('canplay', () => resolve(true), { once: true })),
        new Promise(resolve => setTimeout(resolve, 12000)),
      ]);
      return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    }

    // Check if media container is rendered as an empty/unloaded box
    const mediaContainer = element.querySelector(
      '[data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid="card.layoutLarge.media"]'
    );
    if (mediaContainer) {
      const box = mediaContainer.getBoundingClientRect();
      if (box.width > 80 && box.height > 60) {
        const loadedImg = Array.from(mediaContainer.querySelectorAll('img')).some(i => i.complete && i.naturalWidth > 0);
        if (!loadedImg && !video) return false;
      }
    }

    return true;
  }, hasPoster);
  if (ready) return;
  throw new Error('X post video did not render a preview frame; evidence screenshot was not created');
}

async function compositeVideoFrame({ browser, raw, cardBox, videoBox, mediaPosterPath, outputPath }) {
  if (!mediaPosterPath || !videoBox) {
    await writeFile(outputPath, raw);
    return;
  }

  const width = Math.ceil(cardBox.width);
  const height = Math.ceil(cardBox.height);
  const left = Math.max(0, Math.round(videoBox.x - cardBox.x));
  const top = Math.max(0, Math.round(videoBox.y - cardBox.y));
  const videoWidth = Math.min(width - left, Math.ceil(videoBox.width));
  const videoHeight = Math.min(height - top, Math.ceil(videoBox.height));
  if (videoWidth <= 0 || videoHeight <= 0) {
    await writeFile(outputPath, raw);
    return;
  }

  const [rawData, frameData] = await Promise.all([
    Promise.resolve(raw.toString('base64')),
    readFile(mediaPosterPath).then(file => file.toString('base64')),
  ]);
  const composite = await browser.newPage();
  try {
    await composite.setViewport({ width, height, deviceScaleFactor: 1 });
    await composite.setContent(`<!doctype html><html><body style="margin:0;overflow:hidden;background:#fff"><img alt="X post evidence" src="data:image/png;base64,${rawData}" style="display:block;width:${width}px;height:${height}px"><img alt="X video frame" src="data:image/jpeg;base64,${frameData}" style="position:absolute;left:${left}px;top:${top}px;width:${videoWidth}px;height:${videoHeight}px;object-fit:cover"></body></html>`);
    await composite.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await composite.close().catch(() => {});
  }
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

export async function captureEvidence({ tweetUrl, postId, translation = '', showTranslation = true, mediaPosterPath, outputPath, browser, launchOptions = {}, thread = [] } = {}) {
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
    if (showTranslation) await addInlineTranslation(shot, translation);
    await shot.evaluate(element => element.scrollIntoView({ block: 'start' }));
    await new Promise(resolve => setTimeout(resolve, 300));
    await hideOverlappingPageChrome(shot);
    await waitForTweetVideoFrame(shot, { hasPoster: Boolean(mediaPosterPath) });
    const [cardBox, video] = await Promise.all([
      shot.boundingBox(),
      shot.$(MEDIA_CONTAINER_SELECTOR),
    ]);
    if (!cardBox) throw new Error('X post card could not be measured; evidence screenshot was not created');
    const videoBox = video ? await video.boundingBox() : null;
    await video?.dispose().catch(() => {});
    const raw = await shot.screenshot({ type: 'png' });
    await compositeVideoFrame({
      browser: ownBrowser,
      raw,
      cardBox,
      videoBox,
      mediaPosterPath,
      outputPath,
    });
    return { path: resolve(outputPath), bytes: (await readFile(outputPath)).length, rawBytes: raw.length };
  } finally {
    await page.close().catch(() => {});
    if (!browser) await ownBrowser.close().catch(() => {});
  }
}
