// Repeatable Node-side export benchmark; image delay models loader latency only.
// node scripts/benchmark-docx-export.mjs --output test-output/docx-export/baseline.json
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import JSZip from 'jszip';
import { createDocx } from '../src/utils/docxExport.ts';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=', 'base64'));
const output = process.argv[process.argv.indexOf('--output') + 1];
const iterations = 5;
const samples = [];
for (const rows of [100, 1000, 5000]) {
  const source = `| 名称 | 数量 |\n| :-- | --: |\n${Array.from({ length: rows }, (_, index) => `| 中文第${index + 1}项 & < > | ${index + 1} |`).join('\n')}`;
  samples.push({ name: `table-${rows}-body-rows`, source, expectedRows: rows + 1 });
}
samples.push({ name: '8-distinct-images-40ms-each', source: Array.from({ length: 8 }, (_, index) => `![图${index}](image-${index}.png)`).join('\n\n'), imageCount: 8 });
const results = [];
for (const sample of samples) {
  const timings = [];
  let peakLoads = 0;
  let archiveBytes = 0;
  for (let run = 0; run <= iterations; run += 1) {
    let activeLoads = 0;
    let loadCount = 0;
    const start = performance.now();
    const result = await createDocx(sample.source, {
      title: 'DOCX 性能测量',
      loadImage: async () => {
        loadCount += 1;
        activeLoads += 1;
        peakLoads = Math.max(peakLoads, activeLoads);
        await setTimeout(40);
        activeLoads -= 1;
        return { data: png, type: 'png', width: 1, height: 1 };
      },
    });
    const elapsed = performance.now() - start;
    if (run > 0) timings.push(elapsed);
    const bytes = Buffer.from(result.base64, 'base64');
    archiveBytes = bytes.length;
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const xml = await zip.file('word/document.xml').async('string');
    assert.deepEqual(result.warnings, []);
    if (sample.expectedRows) assert.equal((xml.match(/<w:tr>/g) || []).length, sample.expectedRows);
    if (sample.imageCount) {
      assert.equal((xml.match(/<w:drawing>/g) || []).length, sample.imageCount);
      assert.equal(loadCount, sample.imageCount);
      const mediaFiles = Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('word/media/'));
      assert.ok(mediaFiles.length > 0);
      for (const file of mediaFiles) assert.deepEqual(await file.async('uint8array'), png);
    }
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const result = { name: sample.name, medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)), timingsMs: timings.map(value => Number(value.toFixed(2))), peakLoads, archiveBytes };
  results.push(result);
  console.log(JSON.stringify(result));
}
const report = { node: process.version, platform: process.platform, arch: process.arch, iterations, warmups: 1, results };
if (process.argv.includes('--output')) {
  assert.ok(output && !output.startsWith('--'), '--output needs a file path');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
}
