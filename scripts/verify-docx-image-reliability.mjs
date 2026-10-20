// Real browser image decoders; HTTP and local IPC responses are isolated fixtures.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const fixtures = [];
for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'], ['avif', 'image/avif']]) {
  const bytes = await sharp({ create: { width: 24, height: 16, channels: 4, background: '#df3c42' } }).toFormat(format).toBuffer();
  fixtures.push({ mime, url: `data:${mime};base64,${bytes.toString('base64')}` });
}
const bmp = Buffer.alloc(54 + 24 * 16 * 3, 100);
bmp.write('BM'); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(0, 6); bmp.writeUInt32LE(54, 10);
bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(24, 18); bmp.writeInt32LE(16, 22);
bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(0, 30); bmp.writeUInt32LE(24 * 16 * 3, 34);
for (let offset = 38; offset < 54; offset += 4) bmp.writeUInt32LE(0, offset);
fixtures.push({ mime: 'image/bmp', url: `data:image/bmp;base64,${bmp.toString('base64')}` });
fixtures.push({ mime: 'image/svg+xml', url: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="red"/></svg>').toString('base64')}` });
const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.ZEDITOR_TEST_URL || 'http://127.0.0.1:1425');
  const result = await page.evaluate(async fixtures => {
    const { loadDocxImage } = await import('/src/utils/docxImages.ts');
    const decoded = [];
    for (const fixture of fixtures) {
      const image = await loadDocxImage(fixture.url, null);
      const original = Uint8Array.from(atob(fixture.url.split(',')[1]), value => value.charCodeAt(0));
      decoded.push({ mime: fixture.mime, type: image.type, width: image.width, height: image.height,
        unchanged: image.data.length === original.length && image.data.every((value, index) => value === original[index]),
        png: image.data.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10' });
    }
    const failure = async (source, expected) => {
      try { await loadDocxImage(source, null); throw new Error(`Unexpected success: ${expected}`); }
      catch (error) {
        if (String(error).includes('Unexpected success')) throw error;
        if (expected && !String(error).includes(expected)) throw new Error(`Expected ${expected}: ${error}`);
        return String(error);
      }
    };
    const failures = [];
    failures.push(await failure('data:image/png;base64,AAAA'));
    failures.push(await failure('data:image/tiff;base64,AAAA', '类型不受支持'));
    failures.push(await failure('data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"/>'), '4000 万像素'));
    const originalFetch = window.fetch;
    let request;
    let cancelled = false;
    try {
      window.fetch = async (url, options) => {
        request = { url, credentials: options.credentials, referrerPolicy: options.referrerPolicy, hasSignal: options.signal instanceof AbortSignal };
        const bytes = Uint8Array.from(atob(fixtures[0].url.split(',')[1]), value => value.charCodeAt(0));
        return new Response(bytes, { headers: { 'content-type': 'image/png; charset=binary' } });
      };
      const remote = await loadDocxImage('https://fixture.invalid/image.png', null);
      if (remote.type !== 'png' || remote.width !== 24 || remote.height !== 16) throw new Error('Remote image decode mismatch');
      window.fetch = async () => new Response(null, { status: 404 });
      failures.push(await failure('https://fixture.invalid/404.png', 'HTTP 404'));
      window.fetch = async () => new Response(null, { headers: { 'content-length': String(21 * 1024 * 1024) } });
      failures.push(await failure('https://fixture.invalid/oversize.png', '20 MiB'));
      window.fetch = async () => new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(20 * 1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'image/png' } });
      failures.push(await failure('https://fixture.invalid/stream.png', '20 MiB'));
    } finally { window.fetch = originalFetch; }
    return { decoded, failures, request, cancelled };
  }, fixtures);
  assert.deepEqual(result.decoded.map(value => value.type), ['png', 'jpg', 'gif', 'png', 'png', 'bmp', 'png']);
  assert.ok(result.decoded.every(value => value.width === 24 && value.height === 16));
  assert.ok(result.decoded.filter(value => ['image/png', 'image/jpeg', 'image/gif', 'image/bmp'].includes(value.mime)).every(value => value.unchanged));
  assert.ok(result.decoded.filter(value => ['image/webp', 'image/avif', 'image/svg+xml'].includes(value.mime)).every(value => value.png));
  assert.equal(result.failures.length, 6);
  assert.deepEqual(result.request, { url: 'https://fixture.invalid/image.png', credentials: 'omit', referrerPolicy: 'no-referrer', hasSignal: true });
  assert.equal(result.cancelled, true);
  assert.deepEqual(errors, []);
  await mkdir('test-output/docx-export', { recursive: true });
  await writeFile('test-output/docx-export/image-reliability.json', JSON.stringify({ ...result, errors }, null, 2));
  console.log('DOCX image reliability passed: 7 real decoders, original Office-image bytes, modern-format PNG conversion, corrupt/unsupported/oversize rejection, remote request isolation and stream cancellation.');
} finally { await browser.close(); }
