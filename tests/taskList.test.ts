import { it } from 'node:test';
import assert from 'node:assert/strict';
import { toggleTaskLine } from '../src/utils/taskList.ts';

it('toggles task markers across unordered, ordered, nested and quoted lists', () => {
  for (const prefix of ['- ', '* ', '+ ', '  - ', '\t* ', '> - ', '> > + ', '1. ', '12) ']) {
    assert.equal(toggleTaskLine(`${prefix}[ ] task`), `${prefix}[x] task`);
    assert.equal(toggleTaskLine(`${prefix}[x] task`), `${prefix}[ ] task`);
    assert.equal(toggleTaskLine(`${prefix}[X] task`), `${prefix}[ ] task`);
  }
});

it('leaves body markers and non-task lines intact', () => {
  for (const line of ['text - [ ] task', '- item - [ ] task', '- [ ]suffix', '[ ] task']) {
    assert.equal(toggleTaskLine(line), line);
  }
  assert.equal(toggleTaskLine('- [ ] task - [x] body'), '- [x] task - [x] body');
});
