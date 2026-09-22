import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_FILE_EXTENSIONS,
  findImage,
  findImages,
  formatImageMarkdown,
  isImageFilePath,
  normalizeImageSize,
  parseImageAttributes,
  withImageSize,
} from '../src/utils/imageSyntax.ts';

test('image extensions classify local pictures without touching media files', () => {
  assert.equal(isImageFilePath('D:\\docs\\风景.PNG'), true);
  assert.equal(isImageFilePath('.assets/cover.jpeg'), true);
  assert.equal(isImageFilePath('.assets/cover.webp?raw=1'), true);
  assert.equal(isImageFilePath('.assets/clip.mp4'), false);
  assert.equal(isImageFilePath('song.mp3'), false);
  assert.equal(IMAGE_FILE_EXTENSIONS.includes('avif'), true);
});

test('image sizes accept pixels only', () => {
  assert.equal(normalizeImageSize('320'), 320);
  assert.equal(normalizeImageSize('320px'), 320);
  assert.equal(normalizeImageSize(' 480 '), 480);
  assert.equal(normalizeImageSize('3.5'), undefined);
  assert.equal(normalizeImageSize('50%'), undefined);
  assert.equal(normalizeImageSize('abc'), undefined);
  assert.equal(normalizeImageSize(undefined), undefined);
  assert.deepEqual(parseImageAttributes('width=320 height="200px"'), { width: 320, height: 200 });
  assert.deepEqual(parseImageAttributes('width=big'), {});
});

test('formatImageMarkdown round-trips alt text, title and size', () => {
  const markdown = formatImageMarkdown({
    alt: '风景',
    src: '.assets/风景.png',
    title: '封面 "主图"',
    width: 320,
    height: 200,
  });
  assert.equal(markdown, '![风景](.assets/风景.png "封面 \\"主图\\""){width=320 height=200}');
});

test('findImages reports offsets, line numbers and attributes', () => {
  const content = [
    '# 标题',
    '',
    '段落 ![小图](pic/a.png){width=240} 结束',
    '',
    '```md',
    '![代码里的图](pic/ignored.png)',
    '```',
    '',
    "![带标题](pic/b.png '说明')",
    '![](clip.mp4)',
  ].join('\n');

  const images = findImages(content);
  assert.equal(images.length, 3);

  const [first, second] = images;
  assert.equal(first.src, 'pic/a.png');
  assert.equal(first.width, 240);
  assert.equal(first.line, 3);
  assert.equal(content.slice(first.from, first.to), '![小图](pic/a.png){width=240}');

  assert.equal(second.alt, '带标题');
  assert.equal(second.title, '说明');
  assert.equal(second.src, 'pic/b.png');
  assert.equal(second.line, 9);
  // 音视频虽然也写进 ![]()，但由媒体通道渲染成播放器，预览里不会出现 <img>
  assert.equal(images[2].src, 'clip.mp4');
});

test('withImageSize drops the attribute suffix when no size is given', () => {
  const spec = { alt: '图', src: '.assets/a.png', width: 320, height: 200 };
  assert.equal(formatImageMarkdown(withImageSize(spec, undefined, undefined)), '![图](.assets/a.png)');
  assert.equal(formatImageMarkdown(withImageSize(spec, 640, undefined)), '![图](.assets/a.png){width=640}');
  assert.equal(formatImageMarkdown(withImageSize(spec, undefined, 480)), '![图](.assets/a.png){height=480}');
});

test('findImage locates a picture by source and alternative text', () => {
  const content = '![A](pic/a.png)\n![B](pic/a.png)';
  assert.equal(findImage(content, 'pic/a.png', 'B')?.from, content.indexOf('![B]'));
  assert.equal(findImage(content, 'pic/a.png')?.alt, 'A');
  assert.equal(findImage(content, 'missing.png'), null);
});
