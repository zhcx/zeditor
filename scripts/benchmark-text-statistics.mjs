import assert from 'node:assert/strict';
import { calculateTextStatistics } from '../src/utils/textStatistics.ts';

// 保留优化前的算法作为比较基准，时间只报告，不设容易受机器负载影响的测试阈值。
function beforeOptimization(content) {
  return {
    wordCount: (content.match(/\p{Script=Han}/gu)?.length ?? 0)
      + (content.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0),
    totalCharacters: Array.from(content).length,
  };
}
const content = '中文 English 👋 写作性能测试\n'.repeat(100_000);
assert.deepEqual(calculateTextStatistics(content), beforeOptimization(content));
const measure = (calculate) => {
  const samples = [];
  for (let index = 0; index < 12; index += 1) {
    const start = performance.now();
    calculate(content);
    if (index >= 2) samples.push(performance.now() - start);
  }
  return samples.sort((left, right) => left - right)[Math.floor(samples.length / 2)];
};
console.log(JSON.stringify({
  utf16Length: content.length,
  beforeMedianMs: measure(beforeOptimization),
  afterMedianMs: measure(calculateTextStatistics),
}, null, 2));
