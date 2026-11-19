// Замеры скорости скачивания. Без зависимостей: только встроенный fetch (Node.js 20+).

const USER_AGENT = 'download-speed-meter/1.0';

/**
 * Делает один GET-запрос и дочитывает тело ответа до конца.
 * @returns {Promise<{bytes: number, ms: number}>} размер тела в байтах и время
 *   от отправки запроса до получения последнего байта, в миллисекундах.
 */
export async function downloadOnce(url) {
  const start = performance.now();

  const response = await fetch(url, {
    headers: {
      // Без сжатия: считаем байты, которые реально пришли по сети,
      // а не те, что получились бы после распаковки gzip/br.
      'accept-encoding': 'identity',
      // Некоторые серверы и CDN отклоняют запросы без понятного User-Agent.
      'user-agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    await response.body?.cancel(); // тело не нужно, освобождаем соединение
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  }

  // Читаем поток кусками и считаем только длину: файл целиком в памяти не держим.
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
    }
  }

  return { bytes, ms: performance.now() - start };
}

/** Скорость в мегабитах в секунду (1 Мбит = 1 000 000 бит). */
export function toMbitPerSec(bytes, ms) {
  if (ms <= 0) return 0;
  return (bytes * 8) / 1e6 / (ms / 1000);
}

/**
 * Итоги серии запросов. Скорость считается как «все байты / всё время»,
 * а не как среднее скоростей отдельных запросов: так каждый байт весит одинаково.
 */
export function summarize(results) {
  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
  return {
    count: results.length,
    totalBytes,
    totalMs,
    avgMs: results.length > 0 ? totalMs / results.length : 0,
    mbitPerSec: toMbitPerSec(totalBytes, totalMs),
  };
}

/** 1234567 → "1.23 MB". Десятичные единицы (1 MB = 1 000 000 байт), как у провайдеров. */
export function formatBytes(bytes) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(2)} ${units[unit]}`;
}

/** 812.4 → "812 ms", 12345 → "12.35 s". */
export function formatDuration(ms) {
  return Math.round(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** 9.8765 → "9.88 Mbit/s". */
export function formatSpeed(mbitPerSec) {
  return `${mbitPerSec.toFixed(2)} Mbit/s`;
}
