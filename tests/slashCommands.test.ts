import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSlashCommands,
  findSlashCommandTrigger,
  SLASH_COMMANDS,
} from '../src/utils/slashCommands.ts';

test('opens slash commands for the first token on a line', () => {
  assert.deepEqual(findSlashCommandTrigger('/h2', 20, 23), {
    from: 20,
    to: 23,
    query: 'h2',
  });

  assert.deepEqual(findSlashCommandTrigger('  /表格', 8, 13), {
    from: 10,
    to: 13,
    query: '表格',
  });
});

test('does not open slash commands in prose, URLs, or after whitespace', () => {
  assert.equal(findSlashCommandTrigger('正文 /h1', 0, 6), null);
  assert.equal(findSlashCommandTrigger('https://example.com', 0, 8), null);
  assert.equal(findSlashCommandTrigger('/heading one', 0, 12), null);
});

test('filters commands by shortcut, Chinese title, and English aliases', () => {
  assert.deepEqual(filterSlashCommands('h2').map((command) => command.id), ['heading-2']);
  assert.deepEqual(filterSlashCommands('表格').map((command) => command.id), ['table']);
  assert.ok(filterSlashCommands('formula').some((command) => command.id === 'math'));
});

test('every slash command has a valid post-insertion selection', () => {
  for (const command of SLASH_COMMANDS) {
    const { text, selectionStart = text.length, selectionEnd = selectionStart } = command.insertion;
    assert.ok(selectionStart >= 0 && selectionStart <= text.length, command.id);
    assert.ok(selectionEnd >= selectionStart && selectionEnd <= text.length, command.id);
  }
});

test('diagram commands preselect their placeholder text', () => {
  const placeholders: Record<string, string> = {
    gantt: '项目计划',
    sequence: '用户',
    state: '待处理',
    'class-diagram': '类名',
  };

  for (const [id, expected] of Object.entries(placeholders)) {
    const command = SLASH_COMMANDS.find((item) => item.id === id);
    assert.ok(command, id);
    const { text, selectionStart, selectionEnd } = command.insertion;
    assert.equal(text.slice(selectionStart, selectionEnd), expected, id);
    assert.ok(text.startsWith('```mermaid'), id);
  }
});

test('table command defaults to a 3 × 3 table with the header cell selected', () => {
  const command = SLASH_COMMANDS.find((item) => item.id === 'table');
  assert.ok(command);
  assert.equal(command.description, '插入 3 × 3 表格');

  const { text, selectionStart, selectionEnd } = command.insertion;
  const rows = text.split('\n');
  assert.equal(rows.length, 3 + 1, '表头 + 分隔行 + 两行正文');
  rows.forEach((row) => assert.equal(row.split('|').length - 2, 3, row));
  assert.match(rows[1], /^\|\s*---\s*\|\s*---\s*\|\s*---\s*\|$/);
  assert.equal(text.slice(selectionStart, selectionEnd), '列 1');
});

test('slide separator command inserts a horizontal rule', () => {
  const command = SLASH_COMMANDS.find((item) => item.id === 'slide');
  assert.ok(command);
  assert.match(command.insertion.text, /^---$/m);
});
