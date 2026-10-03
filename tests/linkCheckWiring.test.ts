import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('链接检查接线：解析层 → 服务层 → 校对链路', async () => {
  const util = await read('../src/utils/linkCheck.ts');
  const service = await read('../src/services/linkCheck.ts');
  const aiStore = await read('../src/stores/aiStore.ts');

  // 解析层保持零依赖（可被 node:test 直接加载），与 markdownLint 约定一致。
  assert.match(util, /export function collectLocalLinkTargets/);
  assert.match(util, /export function resolveLocalLinkPath/);
  assert.doesNotMatch(util, /\bimport\b/);

  // 服务层：唯一路径去重后一次 invoke，探测异常归为 error（跳过）。
  assert.match(service, /invoke<string\[]>\('check_link_targets',\s*\{ documentPath, targets: unique \}\)/);
  assert.match(service, /export async function findMissingLocalLinks/);
  assert.match(service, /statuses\.get\(target\.path\) === 'missing'/);

  // 静态校对路径合并链接检查结果；设置开关关闭时不运行。
  assert.match(aiStore, /import \{ findMissingLocalLinks \} from '\.\.\/services\/linkCheck'/);
  assert.match(aiStore, /settings\.editor\.check_local_links !== false/);
  assert.match(aiStore, /results\.push\(\.\.\.await collectLinkCheckResults\(trimmedContent, resultOffset\)\)/);

  // 诊断代码与 VMark 的 linkCheck 规则对齐：M001 图片 / M002 链接。
  assert.match(aiStore, /\[M001\] 图片文件不存在/);
  assert.match(aiStore, /\[M002\] 链接文件不存在/);

  // 独立命令：菜单 / Ctrl+Alt+V 显式触发（忽略设置开关）。
  assert.match(aiStore, /runLinkCheck: async \(\) => \{/);
});

test('链接检查接线：Rust 命令注册与路径跳过规则', async () => {
  const commands = await read('../src-tauri/src/commands.rs');
  const main = await read('../src-tauri/src/main.rs');

  assert.match(commands, /pub async fn check_link_targets\(/);
  // UNC 网络路径与驱动器相对路径永不查找；根相对路径拼文档所在盘符。
  assert.match(commands, /fn is_unc_path/);
  assert.match(commands, /fn is_drive_relative_path/);
  assert.match(commands, /fn is_windows_root_relative/);
  assert.match(commands, /fn document_drive_prefix/);
  // 探测异常（权限等）不误报缺失。
  assert.match(commands, /error\.kind\(\) == std::io::ErrorKind::NotFound/);
  // 设置字段带 serde 默认值，旧配置文件兼容。
  assert.match(commands, /check_local_links: bool/);
  assert.match(commands, /fn default_check_local_links/);

  assert.match(main, /commands::check_link_targets,/);
});

test('链接检查接线：菜单入口、快捷键与 F2 结果导航', async () => {
  const menuBar = await read('../src/components/MenuBar/MenuBar.tsx');
  const app = await read('../src/App.tsx');

  // 菜单「功能 → 检查链接」派发命令事件，快捷键展示 Ctrl+Alt+V。
  assert.match(menuBar, /label: t\('检查链接', language\)/);
  assert.match(menuBar, /new CustomEvent\('zeditor-check-links'\)/);
  assert.match(menuBar, /shortcut: 'Ctrl\+Alt\+V'/);

  // App：Ctrl+Alt+V 触发链接检查，F2 / Shift+F2 在结果之间循环跳转。
  assert.match(app, /window\.addEventListener\('zeditor-check-links', runCheck\)/);
  assert.match(app, /event\.altKey && !event\.shiftKey && event\.key\.toLowerCase\(\) === 'v'/);
  assert.match(app, /event\.key === 'F2' && !event\.isComposing/);
  assert.match(app, /navigateResult\(event\.shiftKey \? -1 : 1\)/);
  // 跳转使用编辑器门面定位并选中。
  assert.match(app, /editorView\.setSelection\(next\.from, next\.to\)/);
  assert.match(app, /editorView\.revealOffset\(next\.from\)/);
});

test('链接检查接线：设置开关默认开启且可关闭', async () => {
  const store = await read('../src/stores/appStore.ts');
  const panel = await read('../src/components/Settings/SettingsPanel.tsx');
  const i18n = await read('../src/i18n/index.ts');

  assert.match(store, /check_local_links\?: boolean/);
  assert.match(store, /check_local_links: true/);

  assert.match(panel, /label="检查本地链接"/);
  assert.match(panel, /editor: \{ \.\.\.localSettings\.editor, check_local_links: checked \}/);

  // 新增 UI 文案已登记翻译（UiLanguageBridge 依据条目自动本地化）。
  assert.match(i18n, /'检查链接':/);
  assert.match(i18n, /'正在检查本地链接\.\.\.':/);
});
