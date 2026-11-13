/**
 * Minimal, dependency-free PDF writer.
 *
 * We only need one thing: a deterministic, valid PDF 1.4 document with a few
 * dozen lines of Helvetica text (loan agreements, statements, forensic
 * reports). Pulling a full PDF library would add a large attack surface for
 * that, so this module emits the objects by hand.
 *
 * The output is byte-for-byte stable for the same input, which matters
 * because the agreement's SHA-256 fingerprint is what gets shown to both
 * parties and later compared during an integrity check.
 */

export interface PdfLine {
  text: string;
  /** Font size in points. Defaults to 10.5. */
  size?: number;
  bold?: boolean;
  /** Extra vertical space before this line, in points. */
  gapBefore?: number;
  /** Left indent in points. */
  indent?: number;
}

const PAGE_WIDTH = 595; // A4 in points
const PAGE_HEIGHT = 842;
const MARGIN_LEFT = 56;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 60;
const MAX_CHARS_PER_LINE = 92;

/** Escapes the three characters that are special inside a PDF string. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Hard-wraps long text so nothing runs off the page. */
function wrap(text: string, width = MAX_CHARS_PER_LINE): string[] {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Builds a PDF from a list of lines. Supports multiple pages; returns the
 * file as a Buffer ready to be written to disk.
 */
export function renderPdf(lines: PdfLine[]): Buffer {
  // --- Lay the lines out into pages -------------------------------------
  const pages: string[] = [];
  let current: string[] = [];
  let y = PAGE_HEIGHT - MARGIN_TOP;

  const flush = () => {
    if (current.length > 0) pages.push(current.join('\n'));
    current = [];
    y = PAGE_HEIGHT - MARGIN_TOP;
  };

  for (const line of lines) {
    const size = line.size ?? 10.5;
    const font = line.bold ? '/F2' : '/F1';
    const indent = line.indent ?? 0;

    for (const [index, chunk] of wrap(line.text).entries()) {
      const gap = (line.gapBefore ?? 0) + (index === 0 ? 0 : 2);
      const lineHeight = size * 1.45 + gap;
      if (y - lineHeight < MARGIN_BOTTOM) flush();
      y -= lineHeight;
      current.push(
        `BT ${font} ${size} Tf ${MARGIN_LEFT + indent} ${y.toFixed(2)} Td (${escapeText(chunk)}) Tj ET`,
      );
    }
  }
  flush();
  if (pages.length === 0) pages.push('');

  // --- Assemble the object graph ----------------------------------------
  // 1 catalog, 2 pages, then per page: page object + content stream,
  // and finally the two fonts.
  const objects: string[] = [];
  const pageObjectIds: number[] = [];
  const firstPageId = 3;
  pages.forEach((_, index) => pageObjectIds.push(firstPageId + index * 2));
  const fontRegularId = firstPageId + pages.length * 2;
  const fontBoldId = fontRegularId + 1;

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds
    .map((id) => `${id} 0 R`)
    .join(' ')}] >>`;

  pages.forEach((content, index) => {
    const pageId = pageObjectIds[index];
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });

  objects[fontRegularId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[fontBoldId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  // --- Serialise with a correct xref table ------------------------------
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];

  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info << /Producer (SecureMicrofinance) ` +
    `/Creator (SecureMicrofinance) >> >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
