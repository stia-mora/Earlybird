export function pollIntervalMs(source) {
  return Math.max(15000, Number(source.pollIntervalSeconds || 300) * 1000);
}

function rateLimitResetAt(source) {
  const match = String(source.lastError || '').match(/^X rate limited until (.+)$/);
  const resetAt = match && Date.parse(match[1]);
  return Number.isFinite(resetAt) ? resetAt : null;
}

export function startupPollDelay(source, { index = 0, total = 1, now = Date.now(), random = Math.random } = {}) {
  const interval = pollIntervalMs(source);
  const slot = Math.max(1000, Math.floor(interval / Math.max(1, total)));
  const offset = index * slot + Math.floor(random() * slot);
  const resetAt = rateLimitResetAt(source);
  if (resetAt && resetAt > now) return resetAt - now + offset;
  const lastPolledAt = Date.parse(source.lastPolledAt || '');
  if (Number.isFinite(lastPolledAt) && lastPolledAt + interval > now) return lastPolledAt + interval - now;
  return Math.max(1000, offset);
}
