// Тесты без сети: поднимаем локальный HTTP-сервер и гоняем против него и функции, и CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  downloadOnce,
  summarize,
  toMbitPerSec,
  formatBytes,
  formatDuration,
} from '../lib/measure.js';

const runNode = promisify(execFile);
const CLI = fileURLToPath(new URL('../index.js', import.meta.url));

const FILE_SIZE = 300_000;
const file = Buffer.alloc(FILE_SIZE, 1);

let server;
let baseUrl;
let lastHeaders;
let requests = 0;
let active = 0; // сколько запросов сервер обрабатывает прямо сейчас
let maxActive = 0; // максимум одновременных: у последовательного клиента должен быть 1

before(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    if (req.url !== '/file') {
      res.writeHead(404).end('not found');
      return;
    }
    requests++;
    active++;
    maxActive = Math.max(maxActive, active);
    res.on('finish', () => active--);
    // Небольшая задержка: если бы клиент слал запросы параллельно, они бы пересеклись.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': FILE_SIZE });
      res.end(file);
    }, 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('downloadOnce reads the whole body and asks for an uncompressed response', async () => {
  const { bytes, ms } = await downloadOnce(`${baseUrl}/file`);
  assert.equal(bytes, FILE_SIZE);
  assert.ok(ms >= 20, `expected at least the server delay, got ${ms} ms`);
  assert.equal(lastHeaders['accept-encoding'], 'identity');
});

test('downloadOnce rejects non-2xx responses', async () => {
  await assert.rejects(downloadOnce(`${baseUrl}/missing`), /HTTP 404/);
});

test('summarize: speed is total bytes over total time, not the mean of speeds', () => {
  // 1 МБ за 0.5 с (16 Мбит/с) и 1 МБ за 1.5 с (5.33 Мбит/с): 16 Мбит за 2 с = 8 Мбит/с.
  // Среднее скоростей дало бы 10.67, то есть завысило бы результат.
  const s = summarize([
    { bytes: 1_000_000, ms: 500 },
    { bytes: 1_000_000, ms: 1500 },
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.totalBytes, 2_000_000);
  assert.equal(s.avgMs, 1000);
  assert.equal(s.mbitPerSec, 8);
});

test('formatters and edge cases', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1_234_567), '1.23 MB');
  assert.equal(formatDuration(812.4), '812 ms');
  assert.equal(formatDuration(12_345), '12.35 s');
  assert.equal(toMbitPerSec(1000, 0), 0);
});

test('CLI makes N strictly sequential requests and prints the totals', async () => {
  requests = 0;
  maxActive = 0;
  const { stdout } = await runNode(process.execPath, [CLI, `${baseUrl}/file`, '--count', '4']);
  assert.equal(requests, 4);
  assert.equal(maxActive, 1);
  assert.match(stdout, /Total downloaded: 1\.20 MB \(1200000 bytes\)/);
  assert.match(stdout, /Average time: +\d+ ms per request/);
  assert.match(stdout, /Download speed: +[\d.]+ Mbit\/s/);
});

test('CLI exits with code 1 and a hint on a bad URL', async () => {
  await assert.rejects(runNode(process.execPath, [CLI, 'not-a-url']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /invalid URL/);
    assert.match(err.stderr, /--help/);
    return true;
  });
});

test('CLI says which request failed and why', async () => {
  await assert.rejects(runNode(process.execPath, [CLI, `${baseUrl}/missing`]), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /request #1 failed: HTTP 404/);
    return true;
  });
});
