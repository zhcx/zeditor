import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSvgFenceLanguage,
  validateSvgSource,
  type SvgXmlParseOutcome,
} from '../src/utils/svgFigure.ts';
import { clipboardImageExtension } from '../src/utils/imageSyntax.ts';

const okParser = (): SvgXmlParseOutcome => ({ ok: true, rootTag: 'svg' });
const failParser = (): SvgXmlParseOutcome => ({ ok: false, rootTag: '' });
const htmlRootParser = (): SvgXmlParseOutcome => ({ ok: true, rootTag: 'html' });

test('recognizes the svg fence language case-insensitively', () => {
  assert.equal(isSvgFenceLanguage('svg'), true);
  assert.equal(isSvgFenceLanguage('SVG'), true);
  assert.equal(isSvgFenceLanguage(' svg '), true);
  assert.equal(isSvgFenceLanguage('mermaid'), false);
  assert.equal(isSvgFenceLanguage(''), false);
  assert.equal(isSvgFenceLanguage(null), false);
  assert.equal(isSvgFenceLanguage(undefined), false);
});

test('accepts well-formed svg documents with an svg root', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const result = validateSvgSource(source, okParser);
  assert.deepEqual(result, { ok: true, source, message: '' });
});

test('accepts documents starting with an xml declaration', () => {
  const source = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const result = validateSvgSource(source, okParser);
  assert.equal(result.ok, true);
});

test('rejects empty sources and sources not starting with svg or xml declaration', () => {
  assert.equal(validateSvgSource('', okParser).ok, false);
  assert.equal(validateSvgSource('   ', okParser).ok, false);
  const notSvg = validateSvgSource('<div></div>', okParser);
  assert.equal(notSvg.ok, false);
  if (!notSvg.ok) assert.match(notSvg.message, /<\?xml|开头/);
  // 行内文本里的 <svg 字样不算数：必须出现在文档开头。
  assert.equal(validateSvgSource('hello <svg></svg>', okParser).ok, false);
  // HTML 注释开头同样拒绝。
  assert.equal(validateSvgSource('<!-- x --><svg></svg>', okParser).ok, false);
});

test('strips a UTF-8 BOM before validation', () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  const result = validateSvgSource(`﻿${source}`, okParser);
  assert.deepEqual(result, { ok: true, source, message: '' });
});

test('rejects malformed xml and non-svg roots via the parser outcome', () => {
  const malformed = validateSvgSource('<svg><rect></svg>', failParser);
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.match(malformed.message, /解析失败/);

  const wrongRoot = validateSvgSource('<?xml version="1.0"?><html></html>', htmlRootParser);
  assert.equal(wrongRoot.ok, false);
  if (!wrongRoot.ok) assert.match(wrongRoot.message, /根元素/);
});

test('normalizes clipboard image mime types to importable extensions', () => {
  // 回归：image/svg+xml 此前被切成 "svg+xml" 而遭后端白名单拒绝。
  assert.equal(clipboardImageExtension('image/svg+xml'), 'svg');
  assert.equal(clipboardImageExtension('image/svg+xml; charset=utf-8'), 'svg');
  assert.equal(clipboardImageExtension('image/jpeg'), 'jpg');
  assert.equal(clipboardImageExtension('image/png'), 'png');
  assert.equal(clipboardImageExtension('image/webp'), 'webp');
  assert.equal(clipboardImageExtension('application/pdf'), 'png', '未知类型回退 png');
  assert.equal(clipboardImageExtension(''), 'png');
});
