import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';

const execFileAsync = promisify(execFile);
const port = Number(process.env.EARLYBIRD_HERMES_RELAY_PORT || 8767);
const target = process.env.EARLYBIRD_HERMES_TARGET || 'feishu';
const tokenFile = process.env.EARLYBIRD_HERMES_RELAY_TOKEN_FILE || './data/earlybird/hermes-relay.token';
const hermes = process.env.HERMES_COMMAND || 'hermes';
const token = (await readFile(tokenFile, 'utf8')).trim();

if (!token) throw new Error('EARLYBIRD_HERMES_RELAY_TOKEN_FILE is empty');

function authorized(value) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(String(value || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 12_000) request.destroy(new Error('payload too large'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/notify') {
    response.writeHead(404).end();
    return;
  }
  if (!authorized(request.headers.authorization)) {
    response.writeHead(401).end();
    return;
  }
  try {
    const payload = JSON.parse(await readBody(request));
    const message = String(payload.message || '').trim();
    const subject = String(payload.subject || '').trim();
    if (!message || message.length > 8_000 || subject.length > 160) throw new Error('invalid notification payload');
    await execFileAsync(hermes, ['send', '--to', target, '--subject', subject, '--quiet', message], { windowsHide: true, timeout: 30_000 });
    response.writeHead(202, { 'content-type': 'application/json' }).end('{"status":"sent"}');
  } catch (error) {
    response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, '0.0.0.0', () => console.log(`EarlyBird Hermes relay listening on ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
