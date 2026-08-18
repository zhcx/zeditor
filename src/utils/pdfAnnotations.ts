export interface PdfLayer {
  id: string;
  name: string;
  visible: boolean;
}

export interface PdfPoint {
  x: number;
  y: number;
}

export interface PdfStroke {
  id: string;
  page: number;
  points: PdfPoint[];
  color: string;
  width: number;
}

export interface PdfAreaHighlight {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  comment: string;
  color: string;
  thumbnail?: string;
  layerId: string;
}

export interface PdfAnnotationSidecarV1 {
  version: 1;
  pdfPath: string;
  pdfSha256: string;
  activeLayerId: string;
  layers: PdfLayer[];
  strokes: PdfStroke[];
  areaHighlights: PdfAreaHighlight[];
}

export function createEmptyPdfAnnotationSidecar(pdfPath: string, pdfSha256: string): PdfAnnotationSidecarV1 {
  return {
    version: 1,
    pdfPath,
    pdfSha256,
    activeLayerId: 'default',
    layers: [{ id: 'default', name: 'Default', visible: true }],
    strokes: [],
    areaHighlights: [],
  };
}

export function getPdfAnnotationSidecarPath(pdfPath: string) {
  return pdfPath + '.zditor-pdf-annotation.json';
}

export function isPdfAnnotationCurrent(sidecar: PdfAnnotationSidecarV1, pdfSha256: string) {
  return sidecar.pdfSha256 === pdfSha256;
}
