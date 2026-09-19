import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdownToSlides, isSlideCompatible } from '../src/utils/markdownToSlides.ts';

describe('splitMarkdownToSlides', () => {
  it('requires a closing fence to have no trailing text', () => {
    assert.deepEqual(splitMarkdownToSlides('```md\n```text\n---\n```\n---\nB'), ['```md\n```text\n---\n```', 'B']);
  });

  it('does not treat indented code as a top-level fence', () => {
    assert.deepEqual(splitMarkdownToSlides('    ```\n---\nB'), ['    ```', 'B']);
  });
  it('splits by --- into separate slides', () => {
    const md = '# Slide 1\nHello\n---\n# Slide 2\nWorld';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 2);
    assert.equal(slides[0], '# Slide 1\nHello');
    assert.equal(slides[1], '# Slide 2\nWorld');
  });

  it('handles multiple --- separators', () => {
    const md = 'A\n---\nB\n---\nC';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 3);
    assert.deepEqual(slides, ['A', 'B', 'C']);
  });

  it('does NOT split on --- inside fenced code blocks (backticks)', () => {
    const md = '# Slide 1\n```\nsome---code\n---\n```\n---\n# Slide 2';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 2);
    assert.ok(slides[0].includes('---\n```'));
    assert.equal(slides[1], '# Slide 2');
  });

  it('does NOT split on --- inside fenced code blocks (tildes)', () => {
    const md = '# Slide 1\n~~~\n---\n~~~\n---\n# Slide 2';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 2);
  });

  it('returns a single slide when there is no ---', () => {
    const md = '# Just one slide\nSome content here.';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 1);
    assert.equal(slides[0], md);
  });

  it('treats a leading --- without YAML fields as a separator', () => {
    const md = '---\n# Slide 1\n---\n# Slide 2';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 3);
    assert.equal(slides[0], '');
    assert.equal(slides[1], '# Slide 1');
    assert.equal(slides[2], '# Slide 2');
  });

  it('removes YAML frontmatter from the deck', () => {
    const md = '---\ntitle: Hello\ntags: [a, b]\n---\n# Slide 1\n---\n# Slide 2';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 2);
    assert.equal(slides[0], '# Slide 1');
    assert.equal(slides[1], '# Slide 2');
    assert.ok(!slides.join('\n').includes('title: Hello'));
  });

  it('keeps a --- block without YAML fields inside the deck', () => {
    const md = '---\n普通文本\n---\n# Slide 2';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 3);
    assert.equal(slides[1], '普通文本');
  });

  it('handles ---- (more than three dashes) as a separator', () => {
    const md = 'A\n----\nB';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 2);
  });

  it('does not treat --- with trailing text as a separator', () => {
    const md = 'A\n--- not a separator\nB';
    const slides = splitMarkdownToSlides(md);
    assert.equal(slides.length, 1);
  });
});

describe('isSlideCompatible', () => {
  it('returns true when there are at least 2 slides', () => {
    assert.equal(isSlideCompatible('A\n---\nB'), true);
  });

  it('ignores empty fragments produced by consecutive separators', () => {
    assert.equal(isSlideCompatible('A\n---\n---\nB'), true);
    assert.equal(isSlideCompatible('A\n---\n---'), false);
  });

  it('returns false when there is only 1 slide', () => {
    assert.equal(isSlideCompatible('Just one slide'), false);
  });

  it('returns false for empty content', () => {
    assert.equal(isSlideCompatible(''), false);
  });
});
