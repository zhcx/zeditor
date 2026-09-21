import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_FILE_EXTENSIONS,
  extensionOfSource,
  findMediaEmbedAt,
  findMediaEmbeds,
  formatMediaEmbed,
  isMediaFilePath,
  isPlatformPageUrl,
  isRemoteMediaSource,
  mediaDialogFilters,
  mediaKindOfSource,
  parseMediaAttributes,
  parseMediaLine,
  resolveRenderKind,
  videoPlatformEmbed,
  youtubeEmbedUrl,
  youtubeVideoId,
} from '../src/utils/media.ts';

test('classifies media files by extension and ignores query strings', () => {
  assert.equal(mediaKindOfSource('demo.MP4'), 'video');
  assert.equal(mediaKindOfSource('.assets/clip.webm'), 'video');
  assert.equal(mediaKindOfSource('song.mp3?t=3'), 'audio');
  assert.equal(mediaKindOfSource('podcast.m4a#chapter-2'), 'audio');
  assert.equal(mediaKindOfSource('notes.md'), null);
  assert.equal(mediaKindOfSource('.assets/README'), null);
  assert.equal(extensionOfSource('  https://cdn.test/x.FLAC '), 'flac');
  assert.equal(isMediaFilePath('D:\\docs\\.assets\\a.mkv'), true);
  assert.equal(isMediaFilePath('D:\\docs\\a.png'), false);
  assert.equal(MEDIA_FILE_EXTENSIONS.length, 18);
});

test('separates remote sources from document-relative paths', () => {
  assert.equal(isRemoteMediaSource('https://cdn.test/a.mp4'), true);
  assert.equal(isRemoteMediaSource('//cdn.test/a.mp4'), true);
  assert.equal(isRemoteMediaSource('blob:http://localhost/123'), true);
  assert.equal(isRemoteMediaSource('.assets/a.mp4'), false);
  assert.equal(isRemoteMediaSource('D:\\media\\a.mp4'), false);
});

test('builds privacy-preserving and platform embed urls', () => {
  assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://m.youtube.com/shorts/abc123XYZ'), 'abc123XYZ');
  assert.equal(youtubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(youtubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(youtubeEmbedUrl('https://example.com/a.mp4'), null);

  assert.deepEqual(videoPlatformEmbed('https://www.bilibili.com/video/BV1xx411c7mD'), {
    src: 'https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&high_quality=1',
    title: '哔哩哔哩视频',
    platform: 'bilibili',
  });
  assert.deepEqual(videoPlatformEmbed('https://vimeo.com/123456789')?.platform, 'vimeo');
  assert.equal(videoPlatformEmbed('https://cdn.test/a.mp4'), null);

  // 平台页面链接要认出来，但没有可嵌入 id 的短链不能当成可播放直链。
  assert.equal(videoPlatformEmbed('https://b23.tv/abcdef'), null);
  assert.equal(isPlatformPageUrl('https://b23.tv/abcdef'), true);
  assert.equal(isPlatformPageUrl('https://www.bilibili.com/video/BV1xx411c7mD'), true);
  assert.equal(isPlatformPageUrl('https://cdn.test/a.mp4'), false);
});

test('resolves the render kind for local files, direct links and platforms', () => {
  assert.equal(resolveRenderKind({ kind: 'video', src: '.assets/demo.mp4' }), 'video');
  assert.equal(resolveRenderKind({ kind: 'audio', src: '.assets/podcast.mp3' }), 'audio');
  assert.equal(resolveRenderKind({ kind: 'video', src: 'https://cdn.test/a.mp4' }), 'video');
  assert.equal(resolveRenderKind({ kind: 'audio', src: 'https://cdn.test/a.mp3' }), 'audio');
  assert.equal(resolveRenderKind({ kind: 'video', src: 'https://youtu.be/dQw4w9WgXcQ' }), 'youtube');
  assert.equal(resolveRenderKind({ kind: 'video', src: 'https://www.bilibili.com/video/BV1xx411c7mD' }), 'embed');
  // 扩展名无法判断时，按 @[audio] / @[video] 的声明处理。
  assert.equal(resolveRenderKind({ kind: 'audio', src: '.assets/recording' }), 'audio');
  assert.equal(resolveRenderKind({ kind: 'video', src: '.assets/recording' }), 'video');
});

test('parses and formats media directives with attributes', () => {
  assert.deepEqual(parseMediaLine('@[video](demo.mp4){title="演示" poster="cover.jpg"}'), {
    kind: 'video',
    src: 'demo.mp4',
    title: '演示',
    poster: 'cover.jpg',
  });
  assert.deepEqual(parseMediaLine('@[audio](podcast.mp3)'), { kind: 'audio', src: 'podcast.mp3' });
  assert.deepEqual(parseMediaLine('@[youtube](https://youtu.be/dQw4w9WgXcQ)')?.kind, 'youtube');
  assert.deepEqual(parseMediaLine('@[embed](https://youtu.be/dQw4w9WgXcQ)')?.kind, 'youtube');
  assert.equal(parseMediaLine('这是一段普通文字'), null);
  assert.equal(parseMediaLine('@[image](a.mp4)'), null);

  assert.equal(
    formatMediaEmbed({ kind: 'video', src: 'demo.mp4', title: '演示', poster: 'cover.jpg' }),
    '@[video](demo.mp4){title="演示" poster="cover.jpg"}',
  );
  // 封面只对视频生效，音频语法保持简洁。
  assert.equal(formatMediaEmbed({ kind: 'audio', src: 'a.mp3', poster: 'cover.jpg' }), '@[audio](a.mp3)');
  assert.equal(formatMediaEmbed({ kind: 'youtube', src: 'https://youtu.be/x' }), '@[youtube](https://youtu.be/x)');
});

test('attribute values survive quotes and escapes', () => {
  const spec = { kind: 'video' as const, src: 'demo.mp4', title: '他说"你好"' };
  const formatted = formatMediaEmbed(spec);
  assert.equal(formatted, '@[video](demo.mp4){title="他说\\"你好\\""}');
  assert.deepEqual(parseMediaLine(formatted), spec);
  assert.deepEqual(parseMediaAttributes(`title='单引号' poster="p.jpg"`), { title: '单引号', poster: 'p.jpg' });
  assert.deepEqual(parseMediaAttributes(`title=`), {});
});

test('finds directive and image-syntax media while skipping code fences', () => {
  const content = [
    '# 标题',
    '',
    '  @[video](.assets/demo.mp4){title="演示"}',
    '',
    '配乐：![片头曲](.assets/theme.mp3)',
    '',
    '```md',
    '@[video](ignored.mp4)',
    '![](ignored.mp3)',
    '```',
  ].join('\n');

  const matches = findMediaEmbeds(content);
  assert.equal(matches.length, 2);

  const [video, audio] = matches;
  assert.equal(video.syntax, 'directive');
  assert.equal(video.line, 3);
  assert.equal(video.index, 0);
  assert.equal(video.title, '演示');
  assert.equal(content.slice(video.from, video.to), video.raw);
  assert.equal(video.raw, '@[video](.assets/demo.mp4){title="演示"}');

  assert.equal(audio.syntax, 'image');
  assert.equal(audio.line, 5);
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.src, '.assets/theme.mp3');
  assert.equal(audio.title, '片头曲');
  assert.equal(content.slice(audio.from, audio.to), '![片头曲](.assets/theme.mp3)');

  assert.equal(findMediaEmbedAt(content, 3)?.src, '.assets/demo.mp4');
  assert.equal(findMediaEmbedAt(content, 5, '.assets/theme.mp3')?.kind, 'audio');
  assert.equal(findMediaEmbedAt(content, 42), null);
});

test('exposes dialog filters that match the desktop extension whitelist', () => {
  assert.deepEqual(mediaDialogFilters('video')[0].extensions.slice(0, 3), ['mp4', 'm4v', 'webm']);
  assert.equal(mediaDialogFilters('auto')[0].extensions.length, MEDIA_FILE_EXTENSIONS.length);
  assert.ok(mediaDialogFilters('auto')[0].extensions.includes('mp3'));
  assert.equal(mediaDialogFilters('audio')[0].extensions.length, 9);
});
