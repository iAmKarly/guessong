import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';

import { serveStatic, stripProxyPrefix } from './static.ts';
import { isInInstance, resetInstances } from './discord.ts';

// --- Serving the frontend -----------------------------------------------------

let root: string;

before(async () => {
  root = (await mkdtemp(join(tmpdir(), 'guessong-dist-'))) + sep;
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<html>app</html>');
  await writeFile(join(root, 'assets', 'index-abc123.js'), 'console.log(1)');
});

after(() => rm(root, { recursive: true, force: true }));

/** A stand-in response that records the head and collects the body. */
function fakeResponse() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const result = { status: 0, headers: {} as Record<string, unknown>, body: () => Buffer.concat(chunks).toString() };
  const res = Object.assign(stream, {
    writeHead(status: number, headers: Record<string, unknown>) {
      result.status = status;
      result.headers = headers;
      return res;
    },
  });
  const finished = new Promise((resolve) => stream.on('end', resolve));
  return { res: res as unknown as ServerResponse, result, finished };
}

async function get(pathname: string) {
  const { res, result, finished } = fakeResponse();
  const served = await serveStatic(root, pathname, res);
  if (served) await finished;
  return { served, ...result };
}

test('serves real files with the right type and caching', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.equal(page.body(), '<html>app</html>');
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-cache', 'index.html must never be stale');

  const script = await get('/assets/index-abc123.js');
  assert.match(String(script.headers['content-type']), /javascript/);
  assert.match(String(script.headers['cache-control']), /immutable/, 'hashed assets cache forever');
});

test('unknown pages get the app, but missing files are a 404', async () => {
  assert.equal((await get('/some/screen')).body(), '<html>app</html>');
  assert.equal((await get('/assets/gone-999.js')).served, false);
});

test('no path can escape the website folder', async () => {
  for (const attempt of ['/../../../../etc/passwd', '/..%2f..%2f..%2fetc%2fpasswd', '/assets/../../secret.txt', '/%E0%A4%A']) {
    const response = await get(attempt);
    assert.ok(!response.served || response.body() === '<html>app</html>', attempt);
  }
});

test("Discord's /.proxy prefix is optional", () => {
  assert.equal(stripProxyPrefix('/.proxy/api/token'), '/api/token');
  assert.equal(stripProxyPrefix('/api/token'), '/api/token');
  assert.equal(stripProxyPrefix('/.proxy'), '/');
  assert.equal(stripProxyPrefix('/.proxyish/x'), '/.proxyish/x', 'only the exact prefix');
});

// --- Checking Activity membership with Discord -------------------------------

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  resetInstances();
});

function discordReturns(...responses: { status: number; users?: string[] }[]) {
  const calls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    const next = responses.shift() ?? { status: 404 };
    return new Response(JSON.stringify({ users: next.users ?? [] }), { status: next.status });
  });
  return calls;
}

/** Let pending promises settle, then move fake time past the retry wait. */
async function passRetryWait() {
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(1_500);
}

test('a player Discord lists in the instance is let in straight away', async () => {
  const calls = discordReturns({ status: 200, users: ['111', '222'] });
  assert.equal(await isInInstance('i-123', '222'), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /\/activity-instances\/i-123$/);
});

test('someone not in the instance is refused, after one re-check', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const calls = discordReturns({ status: 200, users: ['111'] }, { status: 200, users: ['111'] });
  const answer = isInInstance('i-123', 'intruder');
  await passRetryWait();
  assert.equal(await answer, false);
  assert.equal(calls.length, 2);
});

test('a player who only just launched is found on the re-check', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  discordReturns({ status: 200, users: ['111'] }, { status: 200, users: ['111', 'new'] });
  const answer = isInInstance('i-123', 'new');
  await passRetryWait();
  assert.equal(await answer, true);
});

test('an instance that does not exist lets nobody in', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  discordReturns({ status: 404 }, { status: 404 });
  const answer = isInInstance('i-made-up', '111');
  await passRetryWait();
  assert.equal(await answer, false);
});
