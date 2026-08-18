import { parseDocumentAnalysis } from './documentAnalysis.ts';

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function decodePart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extendedReferenceHtml(label: string, destination: string) {
  const parts = destination.split('|');
  const target = decodePart(parts.shift()?.trim() || '');
  const metadata: Record<string, string> = {};
  let mode = '';
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = decodePart(part.slice(separator + 1).trim());
    if (key === 'mode') mode = value;
    else metadata[key] = value;
  }
  if (!['tip', 'revision', 'supertag', 'pdf-card'].includes(mode)) return null;

  const attributes = [
    'class="zeditor-mark zeditor-' + escapeHtml(mode) + '"',
    'data-mode="' + escapeHtml(mode) + '"',
    'data-reference-target="' + escapeHtml(target) + '"',
  ];
  for (const [key, value] of Object.entries(metadata)) {
    if (/^[\w-]+$/.test(key)) attributes.push('data-' + key + '="' + escapeHtml(value) + '"');
  }

  const safeLabel = escapeHtml(decodePart(label));
  if (mode === 'tip') {
    const explanation = escapeHtml(metadata.text || target);
    attributes.push('title="' + explanation + '"');
    return '<span ' + attributes.join(' ') + '>' + safeLabel + '</span>';
  }
  if (mode === 'revision') {
    const advice = escapeHtml(metadata.advice || '');
    return '<span ' + attributes.join(' ') + '><del>' + safeLabel + '</del><ins>' + advice + '</ins></span>';
  }
  return '<span ' + attributes.join(' ') + '>' + (mode === 'supertag' ? '#' : '▣') + ' ' + safeLabel + '</span>';
}

function renderExtendedReferences(source: string) {
  return source.replace(/(!?)\[([^\]\n]+)\]\(([^)\n]+)\)/g, (whole, image, label, destination) => {
    if (image) return whole;
    return extendedReferenceHtml(label, destination) || whole;
  });
}

function renderFootnotes(source: string) {
  const analysis = parseDocumentAnalysis(source);
  if (analysis.footnotes.length === 0) return source;

  const withoutDefinitions = source.replace(/^\[\^(\d+)\]:[^\n]*(?:\n {2,}[^\n]*)*/gm, '');
  const withReferences = withoutDefinitions.replace(/\[\^(\d+)\]/g, (_match, label) => (
    '<sup class="zeditor-footnote-ref" data-footnote="' + label + '"><a href="#zeditor-footnote-' + label + '">' + label + '</a></sup>'
  ));
  const list = analysis.footnotes.map((footnote) => (
    '<li id="zeditor-footnote-' + footnote.label + '" data-footnote="' + footnote.label + '">' +
    escapeHtml(footnote.content) +
    ' <a class="zeditor-footnote-backlink" href="#zeditor-footnote-ref-' + footnote.label + '">↩</a></li>'
  )).join('');
  return withReferences + '\n\n<section class="zeditor-footnotes"><h3>Footnotes</h3><ol>' + list + '</ol></section>';
}

export function prepareMarkdownSource(source: string) {
  const analysis = parseDocumentAnalysis(source);
  const body = analysis.frontmatter.present ? source.slice(analysis.frontmatter.bodyStart) : source;
  return renderFootnotes(renderExtendedReferences(body));
}
