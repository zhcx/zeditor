import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ICON_GEOMETRY, getCommandIcon } from '../src/components/Icons/iconGeometry.ts';
import { SLASH_COMMANDS } from '../src/utils/slashCommands.ts';
import { BUILTIN_GENIES } from '../src/utils/aiGenies.ts';

test('所有内置插入命令和 AI 指令有用途明确的图标', () => {
  for (const command of [...SLASH_COMMANDS, ...BUILTIN_GENIES]) {
    assert.notEqual(getCommandIcon(command.id), 'sparkles', `${command.id} 不能退回通用占位图标`);
  }
});

test('易混淆模块使用不同轮廓，避免依靠颜色区分用途', () => {
  for (const [first, second] of [['settings', 'sun'], ['chatAi', 'terminal'], ['languages', 'webSearch'], ['fileCheck', 'checkCircle'], ['fileText', 'folder'], ['paperclip', 'link']] as const) {
    assert.notDeepEqual(ICON_GEOMETRY[first], ICON_GEOMETRY[second]);
  }
});

test('全部图标在 16px 下可以正确渲染并保留可见图形', async () => {
  for (const [name, geometry] of Object.entries(ICON_GEOMETRY)) {
    const shapes = geometry.map(shape => `<${shape.tag} ${Object.entries(shape.attrs).map(([key, value]) => `${key}="${value}"`).join(' ')}/>`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#20252b" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0;
    for (let index = 3; index < data.length; index += info.channels) if (data[index] > 0) visible += 1;
    assert.ok(visible > 2, `${name} 在小尺寸下不能为空白`);
  }
});
