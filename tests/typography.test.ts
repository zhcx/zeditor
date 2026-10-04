import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTypography, typographyCssVariables } from '../src/utils/appearanceSettings.ts';

test('旧设置与未填写值使用 13px 界面字号和 0.6px 字间距', () => {
  assert.deepEqual(normalizeTypography({}), { uiFontSize: 13, letterSpacing: 0.6 });
  assert.deepEqual(normalizeTypography({ ui_font_size: NaN, letter_spacing: null }), { uiFontSize: 13, letterSpacing: 0.6 });
});

test('界面字号和字间距限制在可用范围，保留用户小数间距', () => {
  assert.deepEqual(normalizeTypography({ ui_font_size: 18, letter_spacing: 1.2 }), { uiFontSize: 18, letterSpacing: 1.2 });
  assert.deepEqual(normalizeTypography({ ui_font_size: 100, letter_spacing: -1 }), { uiFontSize: 20, letterSpacing: 0 });
  assert.equal(typographyCssVariables({ letter_spacing: 0.6 })['--text-letter-spacing'], '0.6px');
});
