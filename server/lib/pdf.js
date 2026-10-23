// ============================================================
//  CPRI — tiny, dependency-free PDF writer
//
//  The app has no PDF library (and none is installed), but the ethics
//  clearance certificate must be downloadable as a real .pdf. Rather than
//  pulling in a large dependency for one page of text, this module writes the
//  minimal PDF 1.4 structure the format requires:
//
//    • one page per call, A4 portrait (595 × 842 pt),
//    • the two standard Type1 fonts every PDF reader has (Helvetica and
//      Helvetica-Bold), so nothing has to be embedded,
//    • an optional border rectangle,
//    • text as a list of { text, x, y, size, bold, align } operations.
//
//  Coordinates are PDF user space: origin at the BOTTOM-left, y grows upward.
//  `escapeText` strips characters the standard fonts cannot show and escapes
//  the three characters that are special inside a PDF string, so a researcher
//  named "O'Brien (Jr.) \\ Smith" cannot break the file.
// ============================================================

const PAGE_WIDTH = 595.28;   // A4 portrait, in points (72 per inch)
const PAGE_HEIGHT = 841.89;

// WinAnsi/Helvetica cannot render arbitrary Unicode. Drop anything outside
// Latin-1 and normalise the few typographic characters we produce ourselves.
function toWinAnsi(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

function escapeText(value) {
  return toWinAnsi(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Rough width estimate for Helvetica at a given size, used only to centre text.
// Helvetica averages ~0.5 em per glyph for mixed case; using per-character
// factors for the common narrow/wide glyphs is close enough for a certificate.
function approximateWidth(text, size, bold) {
  const narrow = 'iljtfrI.,:;()[]\'"!|';
  const wide = 'mwMW@';
  let factor = 0;
  for (const ch of toWinAnsi(text)) {
    if (narrow.includes(ch)) factor += 0.3;
    else if (wide.includes(ch)) factor += 0.85;
    else if (ch === ' ') factor += 0.28;
    else if (ch >= 'A' && ch <= 'Z') factor += 0.7;
    else factor += 0.53;
  }
  return factor * size * (bold ? 1.06 : 1);
}

// Colours are [r, g, b] in 0..1 (PDF's DeviceRGB).
const rgb = (c) => c.map(n => Math.min(1, Math.max(0, Number(n) || 0)).toFixed(3)).join(' ');

function pageContent(page, width) {
  const ops = [];

  if (page.border) {
    // `re` draws a rectangle path, `S` strokes it — a simple framed border.
    ops.push('0.85 w');
    ops.push(`${page.border.x} ${page.border.y} ${page.border.width} ${page.border.height} re S`);
  }

  // Filled rectangles (table header bands, accent rules) go first so text sits on top.
  for (const r of page.rects || []) {
    ops.push(`${rgb(r.fill)} rg ${r.x.toFixed(2)} ${r.y.toFixed(2)} ${r.width.toFixed(2)} ${r.height.toFixed(2)} re f`);
  }
  if ((page.rects || []).length) ops.push('0 g');

  for (const line of page.lines || []) {
    if (line === null || line === undefined) continue;
    const text = line.text === '' || line.text === undefined ? '' : String(line.text);
    const size = line.size || 12;
    const bold = !!line.bold;
    const font = bold ? '/F2' : '/F1';
    let x = line.x ?? 72;
    if (line.align === 'center') {
      x = (width - approximateWidth(text, size, bold)) / 2;
    } else if (line.align === 'right') {
      x = width - 72 - approximateWidth(text, size, bold);
    }
    if (text === '') {
      continue;
    }
    const colour = line.color ? `${rgb(line.color)} rg ` : '';
    const reset = line.color ? ' 0 g' : '';
    ops.push(`${colour}BT ${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${line.y.toFixed(2)} Tm (${escapeText(text)}) Tj ET${reset}`);
  }
  return ops.join('\n');
}

/**
 * Build a PDF from one or more pages of positioned text.
 *
 * @param {object} options
 * @param {Array<{lines:Array, rects?:Array, border?:object}>} options.pages
 * @param {number} [options.width]  page width in points (default A4 portrait)
 * @param {number} [options.height] page height in points
 * @param {string} [options.title]  Document title metadata
 * @returns {Buffer}
 */
export function createPdfDocument({ pages = [], width = PAGE_WIDTH, height = PAGE_HEIGHT, title = 'Document' } = {}) {
  const pageList = pages.length ? pages : [{ lines: [] }];

  // Object layout: 1 catalog, 2 page tree, 3-4 fonts, then a page object and a
  // content stream per page.
  const firstPageObject = 5;
  const kids = pageList.map((_, i) => `${firstPageObject + i * 2} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageList.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  ];
  pageList.forEach((page, i) => {
    const content = pageContent(page, width);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${firstPageObject + i * 2 + 1} 0 R >>`
    );
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });

  // Assemble the file while recording each object's byte offset for the xref.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const infoOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `${objects.length + 1} 0 obj\n<< /Title (${escapeText(title)}) /Producer (CPRI) >>\nendobj\n`;

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  const count = objects.length + 2; // +1 for the free object, +1 for the Info dict
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  xref += `${String(infoOffset).padStart(10, '0')} 00000 n \n`;
  pdf += xref;
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R /Info ${objects.length + 1} 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * Build a one-page PDF from text lines.
 *
 * @param {object} options
 * @param {Array<{text:string,x?:number,y:number,size?:number,bold?:boolean,align?:'left'|'center'|'right'}>} options.lines
 * @param {{x:number,y:number,width:number,height:number}} [options.border]
 * @param {string} [options.title] Document title metadata
 * @returns {Buffer}
 */
export function createPdf({ lines = [], border = null, title = 'Document' } = {}) {
  return createPdfDocument({ pages: [{ lines, border }], title });
}

export { PAGE_WIDTH, PAGE_HEIGHT, escapeText, toWinAnsi, approximateWidth };
