#!/usr/bin/env node
// CLI: node index.js <url> [-n 10]
import { parseArgs } from 'node:util';
import {
  downloadOnce,
  summarize,
  toMbitPerSec,
  formatBytes,
  formatDuration,
  formatSpeed,
} from './lib/measure.js';

const DEFAULT_COUNT = 10;

const USAGE = `Usage: node index.js <url> [options]

Sends N GET requests to <url> one after another, waits for each full response
and prints the average request time, total downloaded size and download speed.

Options:
  -n, --count <N>  number of requests (default: ${DEFAULT_COUNT})
  -h, --help       show this help

Example:
  node index.js "https://speed.cloudflare.com/__down?bytes=10000000"`;

// Ошибка в аргументах командной строки: к ней добавляем подсказку про --help.
class UsageError extends Error {}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        count: { type: 'string', short: 'n', default: String(DEFAULT_COUNT) },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new UsageError(err.message); // неизвестный флаг, --count без значения и т.п.
  }

  const { values, positionals } = parsed;
  if (values.help) return { help: true };

  if (positionals.length !== 1) {
    throw new UsageError('expected exactly one URL');
  }

  let url;
  try {
    url = new URL(positionals[0]);
  } catch {
    throw new UsageError(`invalid URL: ${positionals[0]}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError('only http:// and https:// URLs are supported');
  }

  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1) {
    throw new UsageError(`--count must be a positive integer, got "${values.count}"`);
  }

  return { help: false, url: url.href, count };
}

// fetch кладёт настоящую причину сетевой ошибки (DNS, отказ соединения...) в err.cause.
function describeError(err) {
  return err.cause?.message || err.cause?.code || err.message;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const { url, count } = options;

  console.log(`URL:      ${url}`);
  console.log(`Requests: ${count}, one after another\n`);

  const results = [];
  for (let i = 1; i <= count; i++) {
    let result;
    try {
      // await внутри цикла: следующий запрос уходит только после полного ответа на предыдущий.
      result = await downloadOnce(url);
    } catch (err) {
      throw new Error(`request #${i} failed: ${describeError(err)}`);
    }
    results.push(result);

    const size = formatBytes(result.bytes).padStart(10);
    const time = formatDuration(result.ms).padStart(9);
    const speed = formatSpeed(toMbitPerSec(result.bytes, result.ms)).padStart(14);
    console.log(`  #${String(i).padEnd(3)}${size}  ${time}  ${speed}`);
  }

  const summary = summarize(results);
  console.log('');
  console.log(`Total downloaded: ${formatBytes(summary.totalBytes)} (${summary.totalBytes} bytes)`);
  console.log(`Average time:     ${formatDuration(summary.avgMs)} per request`);
  console.log(
    `Download speed:   ${formatSpeed(summary.mbitPerSec)} (${(summary.mbitPerSec / 8).toFixed(2)} MB/s)`,
  );
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  if (err instanceof UsageError) console.error('Run with --help to see usage.');
  process.exitCode = 1;
});
