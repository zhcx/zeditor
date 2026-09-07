import test from 'node:test';
import assert from 'node:assert/strict';
import * as documentSafety from '../src/utils/documentSafety.ts';
import { guardWindowClose } from '../src/utils/windowCloseGuard.ts';
import { createSaveQueue, DocumentSessions, sameDocument } from '../src/utils/documentSafety.ts';

type DeleteTab = { id: string; path: string | null; modified: boolean };
type DeleteDocument = (
  path: string,
  name: string,
  tabs: DeleteTab[],
  options: {
    confirm: (message: string) => boolean | Promise<boolean>;
    deleteItem: () => Promise<void>;
    closeTab: (id: string) => void;
  },
) => Promise<boolean>;

test('concurrent saves stay ordered and a failed write does not poison the queue', async () => {
  const enqueue = createSaveQueue();
  const order: string[] = [];
  let release!: () => void;
  const first = enqueue(async () => { await new Promise<void>(resolve => {release=resolve;}); order.push('old'); throw Error('disk failure'); });
  const rejected = assert.rejects(first, /disk failure/);
  const second = enqueue(async () => {order.push('new');});
  await Promise.resolve();
  assert.deepEqual(order,[]);
  release();
  await rejected; await second;
  assert.deepEqual(order,['old','new']);
});

test('same text in a different tab cannot accept asynchronous edits', () => {
  assert.equal(sameDocument({activeTabId:'a',content:'text'}, {activeTabId:'b',content:'text'}), false);
  assert.equal(sameDocument({activeTabId:'a',content:'text'}, {activeTabId:'a',content:'new'}), false);
  assert.equal(sameDocument({activeTabId:'a',content:'text'}, {activeTabId:'a',content:'text'}), true);
});

test('document sessions retain independent undo state and dispose closed documents', () => {
  const sessions = new DocumentSessions<{undo:string[];dispose():void}>();
  let disposed = 0;
  const a = sessions.get('a', () => ({undo:['A'],dispose(){disposed++;}}));
  const b = sessions.get('b', () => ({undo:['B'],dispose(){disposed++;}}));
  a.undo.push('edited A');
  assert.notEqual(a,b);
  assert.deepEqual(b.undo,['B']);
  assert.equal(sessions.get('a', () => {throw new Error('must reuse');}),a);
  sessions.retain(['b']);
  assert.equal(disposed,1);
  assert.equal(sessions.get('b', () => {throw new Error('must reuse');}),b);
});

test('close refuses edits made while saving', async () => {
  const tabs = [{id:'a',title:'A',path:'a.md',modified:true}];
  const result = await guardWindowClose(tabs, {
    promptAction: async () => 'save', chooseSavePath: async () => null,
    saveTab: async () => {}, getTabs: () => tabs,
  });
  assert.equal(result, 'stay');
});

test('close cancellation during save prevents exit', async () => {
  let cancelled = false;
  const result = await guardWindowClose([{id:'a',title:'A',path:'a.md',modified:true}], {
    promptAction: async () => 'save', chooseSavePath: async () => null,
    saveTab: async () => {cancelled=true;}, isCancelled: () => cancelled,
  });
  assert.equal(result, 'stay');
});

test('new dirty tabs added while saving prevent exit', async () => {
  const result = await guardWindowClose([{id:'a',title:'A',path:'a.md',modified:true}], {
    promptAction: async () => 'save', chooseSavePath: async () => null,
    saveTab: async () => {}, getTabs: () => [{id:'b',title:'B',path:null,modified:true}],
  });
  assert.equal(result, 'stay');
});

test('deleting an open modified document confirms, deletes, then closes its tabs', async () => {
  const deleteDocument = (documentSafety as typeof documentSafety & {
    deleteDocument?: DeleteDocument;
  }).deleteDocument;
  assert.equal(typeof deleteDocument, 'function', 'document deletion helper must be exported');

  const events: string[] = [];
  const tabs: DeleteTab[] = [
    { id: 'open', path: 'C:\\docs\\note.md', modified: true },
    { id: 'other', path: 'C:\\docs\\other.md', modified: false },
  ];
  const confirmed = await deleteDocument!('C:\\docs\\note.md', 'note.md', tabs, {
    confirm: async message => {
      events.push(`confirm:${message}`);
      return true;
    },
    deleteItem: async () => { events.push('delete'); },
    closeTab: id => { events.push(`close:${id}`); },
  });

  assert.equal(confirmed, true);
  assert.match(events[0], /note\.md/);
  assert.match(events[0], /未保存|编辑/);
  assert.deepEqual(events.slice(1), ['delete', 'close:open']);
});

test('cancelling document deletion leaves the file and open tab untouched', async () => {
  const deleteDocument = (documentSafety as typeof documentSafety & {
    deleteDocument?: DeleteDocument;
  }).deleteDocument;
  assert.equal(typeof deleteDocument, 'function', 'document deletion helper must be exported');

  let deleted = false;
  let closed = false;
  const confirmed = await deleteDocument!('C:\\docs\\note.md', 'note.md', [
    { id: 'open', path: 'C:\\docs\\note.md', modified: false },
  ], {
    confirm: () => false,
    deleteItem: async () => { deleted = true; },
    closeTab: () => { closed = true; },
  });

  assert.equal(confirmed, false);
  assert.equal(deleted, false);
  assert.equal(closed, false);
});

test('a failed document deletion does not close its open tab', async () => {
  const deleteDocument = (documentSafety as typeof documentSafety & {
    deleteDocument?: DeleteDocument;
  }).deleteDocument;
  assert.equal(typeof deleteDocument, 'function', 'document deletion helper must be exported');

  let closed = false;
  await assert.rejects(
    deleteDocument!('C:\\docs\\note.md', 'note.md', [{ id: 'open', path: 'C:\\docs\\note.md', modified: true }], {
      confirm: () => true,
      deleteItem: async () => { throw new Error('delete failed'); },
      closeTab: () => { closed = true; },
    }),
    /delete failed/,
  );
  assert.equal(closed, false);
});
