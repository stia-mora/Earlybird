import { postUrl } from './utils.js';

const MAX_X_QUERIES = 3;
const MAX_WEB_QUERIES = 3;
const MAX_X_RESULTS_PER_QUERY = 6;
const MAX_WEB_RESULTS_PER_QUERY = 4;

function compact(value, maximum = 320) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function queryPlan(value, maximum) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).map(item => ({
    query: compact(typeof item === 'string' ? item : item?.query, 320),
    purpose: compact(typeof item === 'object' ? item?.purpose : '', 240),
    scope: item?.scope === 'web' ? 'web' : 'official',
  })).filter(item => {
    if (!item.query || seen.has(item.query.toLowerCase())) return false;
    seen.add(item.query.toLowerCase());
    return true;
  }).slice(0, maximum);
}

function sourceDomain(source) {
  try { return new URL(source?.website).hostname; } catch { return ''; }
}

export function normalizeResearchPlan(value) {
  const plan = value && typeof value === 'object' ? value : {};
  return {
    xQueries: queryPlan(plan.xQueries, MAX_X_QUERIES),
    webQueries: queryPlan(plan.webQueries, MAX_WEB_QUERIES),
  };
}

export function hasResearchPlan(plan) {
  return Boolean(plan?.xQueries?.length || plan?.webQueries?.length);
}

function tweetEvidence(tweet, query, method = 'http') {
  const url = postUrl(tweet);
  if (!tweet?.id || !url || !tweet.text) return null;
  return {
    kind: 'x',
    id: `x:${tweet.id}`,
    url,
    author: tweet.author?.username || 'unknown',
    createdAt: tweet.createdAt || null,
    text: compact(tweet.text, 1_200),
    mediaCount: Array.isArray(tweet.media) ? tweet.media.length : 0,
    query: compact(query),
    method,
  };
}

function webEvidence(result) {
  if (!result?.url || !result?.excerpt) return null;
  return {
    kind: 'web',
    id: `web:${result.url}`,
    url: result.url,
    title: compact(result.title),
    sourceDomain: compact(result.sourceDomain, 160),
    excerpt: compact(result.excerpt, 1_200),
    query: compact(result.query),
  };
}

export function emptyEditorialResearch(plan = normalizeResearchPlan()) {
  return { plan, xEvidence: [], webEvidence: [], failures: [], searchedAt: new Date().toISOString() };
}

export async function gatherEditorialResearch({ plan, scraperFactory, xSearch, source, tavilySearch, logger = console } = {}) {
  const normalizedPlan = normalizeResearchPlan(plan);
  const research = emptyEditorialResearch(normalizedPlan);
  const seenUrls = new Set();

  if (normalizedPlan.xQueries.length) {
    try {
      for (const request of normalizedPlan.xQueries) {
        try {
          const result = xSearch
            ? await xSearch.search(request.query, { source, limit: MAX_X_RESULTS_PER_QUERY })
            : { tweets: await (await scraperFactory(source)).searchTweets(request.query, { limit: MAX_X_RESULTS_PER_QUERY, type: 'Latest' }), method: 'http' };
          const tweets = Array.isArray(result) ? result : result.tweets;
          const method = Array.isArray(result) ? 'http' : result.method;
          for (const tweet of tweets || []) {
            const evidence = tweetEvidence(tweet, request.query, method);
            if (!evidence || seenUrls.has(evidence.url)) continue;
            seenUrls.add(evidence.url);
            research.xEvidence.push(evidence);
          }
        } catch (error) {
          research.failures.push({ provider: 'x', query: request.query, error: compact(error.message, 500) });
          logger.warn?.('EarlyBird editorial X search failed', request.query, error.message);
        }
      }
    } catch (error) {
      for (const request of normalizedPlan.xQueries) research.failures.push({ provider: 'x', query: request.query, error: compact(error.message, 500) });
      logger.warn?.('EarlyBird editorial X search was unavailable', error.message);
    }
  }

  if (normalizedPlan.webQueries.length) {
    if (!tavilySearch?.configured || typeof tavilySearch.searchWeb !== 'function') {
      for (const request of normalizedPlan.webQueries) research.failures.push({ provider: 'tavily', query: request.query, error: 'Tavily web search is not configured' });
    } else {
      for (const request of normalizedPlan.webQueries) {
        try {
          const officialDomain = sourceDomain(source);
          const results = await tavilySearch.searchWeb(request.query, {
            count: MAX_WEB_RESULTS_PER_QUERY,
            includeDomains: request.scope === 'official' && officialDomain ? [officialDomain] : [],
          });
          for (const result of results || []) {
            const evidence = webEvidence(result);
            if (!evidence || seenUrls.has(evidence.url)) continue;
            seenUrls.add(evidence.url);
            research.webEvidence.push(evidence);
          }
        } catch (error) {
          research.failures.push({ provider: 'tavily', query: request.query, error: compact(error.message, 500) });
          logger.warn?.('EarlyBird editorial Tavily search failed', request.query, error.message);
        }
      }
    }
  }

  return research;
}

export function selectEditorialResearch(research, urls = []) {
  const all = [...(research?.xEvidence || []), ...(research?.webEvidence || [])];
  const known = new Set(all.map(item => item.url));
  const selected = [...new Set((urls || []).filter(url => known.has(url)))];
  const chosen = all.filter(item => selected.includes(item.url));
  return {
    xEvidence: chosen.filter(item => item.kind === 'x'),
    citations: chosen.filter(item => item.kind === 'web').map(item => ({ title: item.title, url: item.url, excerpt: item.excerpt, sourceDomain: item.sourceDomain })),
    references: chosen.map(item => item.url),
  };
}
