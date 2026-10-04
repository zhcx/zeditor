import { register } from 'node:module';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

register('./helpers/resolveTypescript.mjs', import.meta.url);
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
const { useAppStore } = await import('../src/stores/appStore.ts');
const { insertImageFromPath } = await import('../src/services/imageAssets.ts');
const { openBase64Document } = await import('../src/services/textDocuments.ts');
const { insertMediaFromPath, resolveMediaSources, clearResolvedMediaCache, invalidateResolvedSource } = await import('../src/services/mediaAssets.ts');

let calls: Array<{ command: string; args: Record<string, unknown> }> = [];
let invokeHandler: (command: string, args: Record<string, unknown>) => Promise<unknown> = async () => undefined;
Object.assign(globalThis, {
  window: { __TAURI_INTERNALS__: {
    async invoke(command: string, args: Record<string, unknown>) {
      calls.push({ command, args });
      const result = await invokeHandler(command, args);
      return command === 'read_text_document' && typeof result === 'string'
        ? { content: result, encoding: args.encoding || 'utf-8' } : result;
    },
    convertFileSrc(path: string) { return `asset://${path}`; },
  } },
});

afterEach(() => {
  for (const tab of [...useAppStore.getState().tabs]) useAppStore.getState().closeTab(tab.id);
  clearResolvedMediaCache();
  calls = [];
  invokeHandler = async () => undefined;
  useAppStore.getState().setUploadStatus('idle');
  useAppStore.getState().setConversionStatus('idle');
  useAppStore.getState().setEncodingDialog(null);
});

test('取消编码读取后，迟到的错误不会重新打开选择窗口', async () => {
  let reject!: (error: Error) => void;
  invokeHandler = () => new Promise((_resolve, fail) => { reject = fail; });
  let cancelled = false;
  const opening = useAppStore.getState().openFile('C:/cancelled.md', 'gbk', () => cancelled);
  cancelled = true;
  reject(new Error('text_encoding_required: 无法解码'));
  await opening;
  assert.equal(useAppStore.getState().encodingDialog, null);
  assert.equal(useAppStore.getState().uploadStatus, 'idle');
});

test('打开非 UTF-8 文档时记住编码，保存继续使用相同编码', async () => {
  invokeHandler = async command => command === 'read_text_document' ? { content: '中文', encoding: 'gbk' } : undefined;
  await useAppStore.getState().openFile('C:/gbk.md');
  const tab = useAppStore.getState().getActiveTab()!;
  assert.equal(tab.encoding, 'gbk');
  await useAppStore.getState().saveTab(tab.id, 'C:/gbk.md');
  assert.equal(calls.find(call => call.command === 'save_file_content')?.args.encoding, 'gbk');
});

test('云端旧编码版本不会作为空文本打开，选择编码后保留原文和编码', async () => {
  const original = useAppStore.getState().addTab({ content: '当前文档' });
  invokeHandler = async (_command, args) => {
    if (!args.encoding) throw new Error('text_encoding_required: 需要指定编码');
    return { content: '备份中文', encoding: 'gbk' };
  };
  await openBase64Document('备份.md', '1tDOxA==');
  assert.equal(useAppStore.getState().activeTabId, original);
  assert.deepEqual(useAppStore.getState().encodingDialog, { mode: 'open', title: '备份.md', dataBase64: '1tDOxA==' });
  await openBase64Document('备份.md', '1tDOxA==', 'gbk');
  const opened = useAppStore.getState().getActiveTab()!;
  assert.equal(opened.content, '备份中文');
  assert.equal(opened.encoding, 'gbk');
  assert.equal(opened.modified, true);
  assert.equal(useAppStore.getState().tabs.find(tab => tab.id === original)?.content, '当前文档');
});

test('取消云端版本的编码读取后不会添加空白或迟到标签', async () => {
  const count = useAppStore.getState().tabs.length;
  invokeHandler = async () => ({ content: '备份', encoding: 'utf-16le-bom' });
  await openBase64Document('备份.md', '', 'utf-16le-bom', () => true);
  assert.equal(useAppStore.getState().tabs.length, count);
});

test('改变保存编码会标记文档，保存途中再次改变编码时保留修改状态', async () => {
  const id = useAppStore.getState().addTab({ content: '正文', path: 'C:/note.md' });
  useAppStore.getState().setTabEncoding(id, 'gbk');
  assert.equal(useAppStore.getState().getActiveTab()?.modified, true);
  const written = deferred<unknown>();
  invokeHandler = () => written.promise;
  const saving = useAppStore.getState().saveTab(id, 'C:/note.md');
  await Promise.resolve();
  useAppStore.getState().setTabEncoding(id, 'utf-8-bom');
  written.resolve(undefined);
  await saving;
  assert.equal(useAppStore.getState().getActiveTab()?.modified, true);
  assert.equal(useAppStore.getState().getActiveTab()?.encoding, 'utf-8-bom');
});

test('以指定编码重新打开时，不覆盖读取期间新增的编辑', async () => {
  const id = useAppStore.getState().addTab({ content: '原文', path: 'C:/note.md' });
  const read = deferred<unknown>();
  invokeHandler = () => read.promise;
  const reopening = useAppStore.getState().reopenTabWithEncoding(id, 'gbk');
  useAppStore.getState().setContent('新增的修改');
  read.resolve({ content: '重新解码', encoding: 'gbk' });
  await assert.rejects(reopening, /已变化|修改/);
  assert.equal(useAppStore.getState().content, '新增的修改');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('重新打开已有标签不读取磁盘且保留未保存内容', async () => {
  const id = useAppStore.getState().addTab({ path: 'C:/docs/a.md', content: '未保存', modified: true });
  invokeHandler = async () => { throw new Error('文件离线'); };
  await useAppStore.getState().openFile('C:/docs/a.md');
  assert.equal(useAppStore.getState().activeTabId, id);
  assert.equal(useAppStore.getState().content, '未保存');
  assert.equal(calls.length, 0);
});

test('打开文件失败向调用方抛错并显示原因', async () => {
  invokeHandler = async () => { throw new Error('权限被拒绝'); };
  await assert.rejects(useAppStore.getState().openFile('C:/docs/missing.md'), /权限被拒绝/);
  assert.equal(useAppStore.getState().uploadStatus, 'error');
  assert.match(useAppStore.getState().uploadMessage, /权限被拒绝/);
});

test('较早的慢读取不会抢走后打开文档的焦点', async () => {
  const firstRead = deferred<unknown>();
  invokeHandler = async (_command, args) => args.path === 'C:/slow.md' ? firstRead.promise : '快速文档';
  const firstOpen = useAppStore.getState().openFile('C:/slow.md');
  await useAppStore.getState().openFile('C:/fast.md');
  firstRead.resolve('较早的文档');
  await firstOpen;
  assert.equal(useAppStore.getState().currentFile, 'C:/fast.md');
  assert.equal(useAppStore.getState().content, '快速文档');
  assert.equal(useAppStore.getState().tabs.find(tab => tab.path === 'C:/slow.md')?.content, '较早的文档');
});

test('并发打开同一文件复用磁盘读取', async () => {
  const read = deferred<unknown>();
  invokeHandler = () => read.promise;
  const first = useAppStore.getState().openFile('C:/shared.md');
  const second = useAppStore.getState().openFile('C:/shared.md');
  read.resolve('共享内容');
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(useAppStore.getState().tabs.filter(tab => tab.path === 'C:/shared.md').length, 1);
});

test('转换期间切换文档时，转换结果以后台标签保留', async () => {
  const converted = deferred<unknown>();
  invokeHandler = async command => command === 'get_converter_module_status' ? { state: 'ready' } : converted.promise;
  const conversion = useAppStore.getState().convertDocument('C:/source.docx');
  await Promise.resolve();
  const selected = useAppStore.getState().addTab({ content: '当前文章' });
  converted.resolve('# 转换结果');
  await conversion;
  assert.equal(useAppStore.getState().activeTabId, selected);
  assert.equal(useAppStore.getState().content, '当前文章');
  const imported = useAppStore.getState().tabs.find(tab => tab.title === 'source.md');
  assert.equal(imported?.content, '# 转换结果');
  assert.equal(imported?.modified, true);
});

for (const kind of ['image', 'media'] as const) {
  test(`${kind} 导入期间切换标签仍写入原文档`, async () => {
    const asset = deferred<unknown>();
    invokeHandler = () => asset.promise;
    const first = useAppStore.getState().addTab({ path: 'C:/docs/first.md', content: '原文档' });
    const result = kind === 'image' ? insertImageFromPath('photo.png') : insertMediaFromPath('clip.mp4');
    const second = useAppStore.getState().addTab({ path: 'C:/docs/second.md', content: '另一文档' });
    asset.resolve({ fileName: kind === 'image' ? 'photo.png' : 'clip.mp4', relativePath: '.assets/file', absolutePath: 'C:/docs/.assets/file', size: 10 });
    assert.equal(await result, true);
    assert.equal(useAppStore.getState().activeTabId, second);
    assert.equal(useAppStore.getState().content, '另一文档');
    assert.match(useAppStore.getState().tabs.find(tab => tab.id === first)!.content, /\.assets\/file/);
  });

  test(`${kind} 导入期间关闭原标签不修改新文档`, async () => {
    const asset = deferred<unknown>();
    invokeHandler = () => asset.promise;
    const id = useAppStore.getState().addTab({ path: 'C:/docs/closed.md', content: '原文档' });
    const result = kind === 'image' ? insertImageFromPath('photo.png') : insertMediaFromPath('clip.mp4');
    useAppStore.getState().closeTab(id);
    const before = useAppStore.getState().content;
    asset.resolve({ fileName: 'file.png', relativePath: '.assets/file', absolutePath: 'C:/docs/.assets/file', size: 10 });
    assert.equal(await result, false);
    assert.equal(useAppStore.getState().content, before);
  });
}

test('同一批并发媒体解析复用正在执行的请求', async () => {
  const result = deferred<unknown>();
  invokeHandler = () => result.promise;
  const first = resolveMediaSources('C:/a.md', ['photo.png']);
  const second = resolveMediaSources('C:/a.md', ['photo.png']);
  result.resolve(['C:/photo.png']);
  assert.equal((await first).get('photo.png'), 'asset://C:/photo.png');
  assert.equal((await second).get('photo.png'), 'asset://C:/photo.png');
  assert.equal(calls.length, 1);
});

test('缺失媒体短暂缓存后重新检查，使外部新增文件可见', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100 });
  invokeHandler = async () => calls.length === 1 ? [null] : ['C:/photo.png'];
  await resolveMediaSources('C:/a.md', ['photo.png']);
  await resolveMediaSources('C:/a.md', ['photo.png']);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(2_001);
  assert.equal((await resolveMediaSources('C:/a.md', ['photo.png'])).get('photo.png'), 'asset://C:/photo.png');
});

test('失效前已发出的媒体解析不能覆盖新请求结果', async () => {
  const old = deferred<unknown>();
  invokeHandler = async () => calls.length === 1 ? old.promise : ['C:/new.png'];
  const oldRequest = resolveMediaSources('C:/a.md', ['photo.png']);
  invalidateResolvedSource('C:/a.md', 'photo.png');
  await resolveMediaSources('C:/a.md', ['photo.png']);
  old.resolve(['C:/old.png']);
  await oldRequest;
  assert.equal((await resolveMediaSources('C:/a.md', ['photo.png'])).get('photo.png'), 'asset://C:/new.png');
});

test('超过缓存容量的一批媒体仍全部返回解析结果', async () => {
  invokeHandler = async (_command, args) => (args.sources as string[]).map(source => `C:/${source}`);
  const sources = Array.from({ length: 600 }, (_, index) => `${index}.png`);
  assert.equal((await resolveMediaSources('C:/a.md', sources)).size, sources.length);
});
