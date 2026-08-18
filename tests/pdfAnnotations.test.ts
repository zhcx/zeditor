import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEmptyPdfAnnotationSidecar,
  getPdfAnnotationSidecarPath,
  isPdfAnnotationCurrent,
  type PdfAnnotationSidecarV1,
} from '../src/utils/pdfAnnotations.ts';

test('creates a versioned empty annotation sidecar without mutating the PDF path', () => {
  const sidecar = createEmptyPdfAnnotationSidecar('C:\\papers\\paper.pdf', 'abc123');

  assert.equal(sidecar.version, 1);
  assert.equal(sidecar.pdfPath, 'C:\\papers\\paper.pdf');
  assert.equal(sidecar.pdfSha256, 'abc123');
  assert.equal(sidecar.activeLayerId, 'default');
  assert.deepEqual(sidecar.layers, [{ id: 'default', name: 'Default', visible: true }]);
  assert.deepEqual(sidecar.strokes, []);
  assert.deepEqual(sidecar.areaHighlights, []);
});

test('uses a sibling sidecar filename and detects source changes', () => {
  const sidecar: PdfAnnotationSidecarV1 = createEmptyPdfAnnotationSidecar('/papers/paper.pdf', 'hash-a');

  assert.equal(getPdfAnnotationSidecarPath(sidecar.pdfPath), '/papers/paper.pdf.zditor-pdf-annotation.json');
  assert.equal(isPdfAnnotationCurrent(sidecar, 'hash-a'), true);
  assert.equal(isPdfAnnotationCurrent(sidecar, 'hash-b'), false);
});
