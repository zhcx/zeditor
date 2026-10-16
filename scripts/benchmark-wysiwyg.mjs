import { performance } from 'node:perf_hooks';
import { splitMarkdownDocument } from '../src/utils/wysiwyg/blocks.ts';
const source = Array.from({ length: 6000 }, (_, i) => `段落 ${i}\n\n`).join('\n\n');
const samples = [];
for (let i = 0; i < 6; i++) {
  const start = performance.now();
  const doc = splitMarkdownDocument(source);
  const duration = performance.now() - start;
  if (i > 0) samples.push(duration);
  if (doc.blocks.length !== 12000) throw new Error(`Unexpected blocks: ${doc.blocks.length}`);
}
console.log(JSON.stringify({ characters: source.length, blocks: 12000, samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[2] }));
