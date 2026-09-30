import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLocalLinkTargets, resolveLocalLinkPath } from '../src/utils/linkCheck.ts';

test('收集本地链接与图片目标，计算 UTF-16 区间', () => {
  const source = '见 [文档](./docs/a.md) 与 ![图](./img/b.png)。';
  const targets = collectLocalLinkTargets(source);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].kind, 'link');
  assert.equal(targets[0].path, './docs/a.md');
  assert.equal(source.slice(targets[0].from, targets[0].to), '[文档](./docs/a.md)');
  assert.equal(targets[1].kind, 'image');
  assert.equal(targets[1].path, './img/b.png');
  assert.equal(source.slice(targets[1].from, targets[1].to), '![图](./img/b.png)');
});

test('resolveLocalLinkPath：跳过外部地址、片段与网络路径', () => {
  // 外部 URL（任何协议与协议相对 URL）不是本地文件。
  assert.equal(resolveLocalLinkPath('https://example.com/a'), null);
  assert.equal(resolveLocalLinkPath('mailto:a@b.com'), null);
  assert.equal(resolveLocalLinkPath('vscode://file/x'), null);
  assert.equal(resolveLocalLinkPath('obsidian://open'), null);
  assert.equal(resolveLocalLinkPath('//cdn.example.com/a.png'), null);
  // 仅片段链接由 W04 锚点规则负责，这里跳过。
  assert.equal(resolveLocalLinkPath('#section'), null);
  assert.equal(resolveLocalLinkPath(''), null);
  // UNC 网络路径与驱动器相对路径永不查找。
  assert.equal(resolveLocalLinkPath('\\\\server\\share\\a.md'), null);
  assert.equal(resolveLocalLinkPath('C:file.md'), null);
  // Windows 盘符绝对路径与根相对路径仍按文件路径检查。
  assert.equal(resolveLocalLinkPath('C:\\docs\\a.md'), 'C:\\docs\\a.md');
  assert.equal(resolveLocalLinkPath('C:/docs/a.md'), 'C:/docs/a.md');
  assert.equal(resolveLocalLinkPath('/docs/a.md'), '/docs/a.md');
  // 片段与查询串不是文件路径的一部分。
  assert.equal(resolveLocalLinkPath('./a.md#sec'), './a.md');
  assert.equal(resolveLocalLinkPath('./a.md?raw=1'), './a.md');
  // 尖括号写法与尾部 title。
  assert.equal(resolveLocalLinkPath('<./my file.md>'), './my file.md');
  assert.equal(resolveLocalLinkPath('./a.md "标题"'), './a.md');
  assert.equal(resolveLocalLinkPath("./a.md 'title'"), './a.md');
  // 普通相对路径原样保留。
  assert.equal(resolveLocalLinkPath('../shared.md'), '../shared.md');
  assert.equal(resolveLocalLinkPath('images/logo.png'), 'images/logo.png');
});

test('跳过代码块与行内代码中的链接', () => {
  const source = '```md\n[伪造](./fake.md)\n```\n\n`[行内](./inline.md)`\n\n[真实](./real.md)';
  const targets = collectLocalLinkTargets(source);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].path, './real.md');

  // 未闭合围栏之后的内容全部视为代码。
  const unclosed = '```\n[断链](./broken.md)';
  assert.equal(collectLocalLinkTargets(unclosed).length, 0);
});

test('转义写法不视为链接', () => {
  const source = '\\[不是链接\\](./x.md) 和 [是链接](./y.md)';
  const targets = collectLocalLinkTargets(source);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].path, './y.md');
  assert.equal(source.slice(targets[0].from, targets[0].to), '[是链接](./y.md)');
});

test('媒体指令指向本地文件时纳入检查，在线平台跳过', () => {
  const source = '@[video](./demo.mp4)\n\n@[youtube](https://youtu.be/abc123)\n\n@[audio](../audio/bgm.mp3)';
  const targets = collectLocalLinkTargets(source);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].kind, 'media');
  assert.equal(targets[0].path, './demo.mp4');
  assert.equal(targets[1].path, '../audio/bgm.mp3');

  // 图片语法中的媒体文件自动提升播放器，仍按图片目标检查。
  const elevated = collectLocalLinkTargets('![](./demo.mp4)');
  assert.equal(elevated.length, 1);
  assert.equal(elevated[0].kind, 'image');
});

test('引用式定义的本地目标纳入检查，重复定义不误报', () => {
  const source = '[ref]: ./doc.md\n[site]: https://example.com\n\n正文 [ref] 与 [site]';
  const targets = collectLocalLinkTargets(source);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kind, 'reference');
  assert.equal(targets[0].path, './doc.md');
  assert.equal(source.slice(targets[0].from, targets[0].to), '[ref]: ./doc.md');
});

test('图片与链接的 title、片段不参与路径解析', () => {
  const source = '![a](./img.png "标题") 与 [b](./x.md#sec "标题")';
  const targets = collectLocalLinkTargets(source);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].path, './img.png');
  assert.equal(targets[0].kind, 'image');
  assert.equal(targets[1].path, './x.md');
});

test('空地址与未命名目标不进入检查列表', () => {
  assert.equal(collectLocalLinkTargets('[文字]()').length, 0);
  assert.equal(collectLocalLinkTargets('[ref]:').length, 0);
  assert.equal(collectLocalLinkTargets('').length, 0);
});

test('结果按文档顺序排列，CRLF 换行偏移正确', () => {
  const source = '[a](./a.md)\r\n[b](./b.md)';
  const targets = collectLocalLinkTargets(source);
  assert.equal(targets.length, 2);
  assert.equal(source.slice(targets[0].from, targets[0].to), '[a](./a.md)');
  assert.equal(source.slice(targets[1].from, targets[1].to), '[b](./b.md)');
});
