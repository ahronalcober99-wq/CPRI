// ============================================================
//  CPRI — Research Gala program export
//
//  The program of presenters as a PDF or an Excel workbook. Neither needs a
//  dependency: the PDF comes from lib/pdf.js, and an .xlsx is a ZIP of a few XML
//  parts, which a 40-line stored-ZIP writer can produce.
//
//  Both builders take the same rows (see programRows) so the two files always
//  agree.
// ============================================================
'use strict';

import { createPdfDocument, approximateWidth, PAGE_WIDTH, PAGE_HEIGHT } from './pdf.js';
import {
  GALA_STATUS,
  categoryLabel,
  formatLabel,
  formatClock,
  formatDay,
  parseJsonColumn
} from './gala-config.js';

// ---- Rows ----
// Columns in export order. `key` reads from a programRows() entry.
export const PROGRAM_COLUMNS = [
  { key: 'date',       header: 'Date',                 pdf: 62,  xlsx: 14 },
  { key: 'time',       header: 'Time',                 pdf: 48,  xlsx: 10 },
  { key: 'room',       header: 'Room',                 pdf: 78,  xlsx: 18 },
  { key: 'format',     header: 'Format',               pdf: 58,  xlsx: 12 },
  { key: 'title',      header: 'Title of Research',    pdf: 190, xlsx: 52 },
  { key: 'presenters', header: 'Presenter(s)',         pdf: 118, xlsx: 32 },
  { key: 'program',    header: 'Program / Department', pdf: 112, xlsx: 30 },
  { key: 'adviser',    header: 'Adviser',              pdf: 82,  xlsx: 24 }
];

export const EXTENDED_COLUMNS = [
  { key: 'refNo',      header: 'Reference',   xlsx: 18 },
  { key: 'category',   header: 'Category',    xlsx: 24 },
  { key: 'schoolYear', header: 'School Year', xlsx: 14 },
  { key: 'semester',   header: 'Semester',    xlsx: 12 },
  { key: 'status',     header: 'Status',      xlsx: 16 }
];

const SEMESTER_LABELS = { '1st': '1st Semester', '2nd': '2nd Semester', summer: 'Summer' };

/**
 * Sorted, flattened rows. Scheduled entries come first in date/time/room order;
 * entries without a schedule (only present when the caller asked for them) are
 * listed after, by title.
 */
export function programRows(submissions = []) {
  const rows = submissions.map(s => {
    const presenters = parseJsonColumn(s.presenters, null);
    return {
      date: formatDay(s.scheduleDate) || '',
      time: formatClock(s.scheduleTime) || '',
      room: s.scheduleRoom || '',
      format: formatLabel(s.presentationType),
      title: s.title || '',
      presenters: (Array.isArray(presenters) && presenters.length ? presenters : [s.submitterName || s.authors || '']).join(', '),
      program: s.program || '',
      adviser: s.adviser || '',
      refNo: s.refNo || '',
      category: categoryLabel(s.category),
      schoolYear: s.schoolYear || '',
      semester: SEMESTER_LABELS[s.semester] || s.semester || '',
      status: GALA_STATUS[s.status] || s.status || '',
      _sort: `${s.scheduleDate || '9999-99-99'} ${s.scheduleTime || '99:99'} ${s.scheduleRoom || ''} ${s.title || ''}`
    };
  });
  rows.sort((a, b) => a._sort.localeCompare(b._sort));
  return rows;
}

// ---- PDF ----
const MAROON = [0.502, 0, 0];
const GOLD = [0.851, 0.659, 0.169];
const GOLD_SOFT = [1, 0.882, 0.604];
const INK = [0.165, 0.078, 0.086];
const MUTED = [0.46, 0.38, 0.37];
const ZEBRA = [0.973, 0.957, 0.953];

const LANDSCAPE_W = PAGE_HEIGHT; // A4 turned on its side
const LANDSCAPE_H = PAGE_WIDTH;
const MARGIN = 36;

function wrap(text, width, size, bold = false) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (approximateWidth(candidate, size, bold) <= width || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/**
 * The program as a PDF. `heading` is the subtitle (the active filters, or the
 * event), `generatedAt` a Date. Always at least one page, even with no rows.
 */
export function buildProgramPdf(rows, { heading = '', generatedAt = new Date() } = {}) {
  const size = 8;
  const lineHeight = 10;
  const rowPad = 4;
  const tableW = PROGRAM_COLUMNS.reduce((n, c) => n + c.pdf, 0);
  const left = (LANDSCAPE_W - tableW) / 2;
  const headerBandH = 52;
  const colHeadH = 18;
  const bottom = 40;

  const pages = [];
  let page = null;
  let y = 0;

  const startPage = () => {
    page = { lines: [], rects: [] };
    pages.push(page);
    // Maroon masthead with a gold rule.
    page.rects.push({ x: 0, y: LANDSCAPE_H - headerBandH, width: LANDSCAPE_W, height: headerBandH, fill: MAROON });
    page.rects.push({ x: 0, y: LANDSCAPE_H - headerBandH - 3, width: LANDSCAPE_W, height: 3, fill: GOLD });
    page.lines.push({ text: 'CPRI Research Gala - Program of Presenters', x: left, y: LANDSCAPE_H - 27, size: 16, bold: true, color: [1, 1, 1] });
    if (heading) {
      page.lines.push({ text: heading, x: left, y: LANDSCAPE_H - 43, size: 9, color: GOLD_SOFT });
    }
    // Column header band.
    y = LANDSCAPE_H - headerBandH - 3 - 14;
    page.rects.push({ x: left, y: y - colHeadH + 5, width: tableW, height: colHeadH, fill: MAROON });
    let x = left;
    for (const col of PROGRAM_COLUMNS) {
      page.lines.push({ text: col.header, x: x + 4, y: y - 8, size: 8, bold: true, color: [1, 1, 1] });
      x += col.pdf;
    }
    y -= colHeadH + 2;
  };

  startPage();

  rows.forEach((row, index) => {
    const cells = PROGRAM_COLUMNS.map(col => wrap(row[col.key], col.pdf - 8, size, col.key === 'title'));
    const rowH = Math.max(...cells.map(c => c.length)) * lineHeight + rowPad * 2;
    if (y - rowH < bottom) startPage();

    if (index % 2 === 0) {
      page.rects.push({ x: left, y: y - rowH + 6, width: tableW, height: rowH, fill: ZEBRA });
    }
    let x = left;
    PROGRAM_COLUMNS.forEach((col, ci) => {
      cells[ci].forEach((text, li) => {
        page.lines.push({
          text,
          x: x + 4,
          y: y - rowPad - li * lineHeight - 2,
          size,
          bold: col.key === 'title',
          color: INK
        });
      });
      x += col.pdf;
    });
    y -= rowH;
  });

  if (!rows.length) {
    page.lines.push({ text: 'No presenters match these filters yet.', x: left + 4, y: y - 14, size: 10, color: MUTED });
  }

  // Footer on every page: generated date, count, page x of y.
  const stamp = `Generated ${generatedAt.toISOString().slice(0, 10)} - ${rows.length} presentation${rows.length === 1 ? '' : 's'}`;
  pages.forEach((p, i) => {
    p.rects.push({ x: left, y: 30, width: tableW, height: 1, fill: GOLD });
    p.lines.push({ text: stamp, x: left, y: 18, size: 8, color: MUTED });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.lines.push({ text: label, x: left + tableW - approximateWidth(label, 8, false), y: 18, size: 8, color: MUTED });
  });

  return createPdfDocument({
    pages,
    width: LANDSCAPE_W,
    height: LANDSCAPE_H,
    title: 'CPRI Research Gala - Program of Presenters'
  });
}

// ---- XLSX ----
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** A ZIP with every entry stored (no compression). Enough for an .xlsx. */
export function zipStore(entries, now = new Date()) {
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = (Math.max(0, now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // UTF-8 names
    local.writeUInt16LE(0, 8);         // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);      // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// XML 1.0 forbids most control characters, even escaped.
const xmlEscape = (value) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/**
 * The program as an .xlsx. Cells are inline strings, so nothing a presenter
 * typed (a title starting with "=" or "@") can ever be evaluated as a formula.
 */
export function buildProgramXlsx(rows, { heading = '', generatedAt = new Date() } = {}) {
  const columns = [...PROGRAM_COLUMNS, ...EXTENDED_COLUMNS];
  const cell = (c, r, text, style) =>
    `<c r="${columnName(c)}${r}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;

  const sheetRows = [];
  // Row 1: title, row 2: subtitle, row 3 blank, row 4 header.
  sheetRows.push(`<row r="1">${cell(0, 1, 'CPRI Research Gala - Program of Presenters', 3)}</row>`);
  sheetRows.push(`<row r="2">${cell(0, 2, `${heading ? heading + ' - ' : ''}Generated ${generatedAt.toISOString().slice(0, 10)}`, 0)}</row>`);
  const HEADER_ROW = 4;
  sheetRows.push(`<row r="${HEADER_ROW}">${columns.map((col, c) => cell(c, HEADER_ROW, col.header, 1)).join('')}</row>`);
  rows.forEach((row, i) => {
    const r = HEADER_ROW + 1 + i;
    sheetRows.push(`<row r="${r}">${columns.map((col, c) => cell(c, r, row[col.key], 2)).join('')}</row>`);
  });

  const lastRow = HEADER_ROW + Math.max(rows.length, 1);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${HEADER_ROW}" topLeftCell="A${HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${columns.map((col, c) => `<col min="${c + 1}" max="${c + 1}" width="${col.xlsx}" customWidth="1"/>`).join('')}</cols>
<sheetData>${sheetRows.join('')}</sheetData>
<autoFilter ref="A${HEADER_ROW}:${columnName(columns.length - 1)}${lastRow}"/>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FF800000"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF800000"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFEADEDC"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

  const parts = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Program" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet }
  ];
  return zipStore(parts, generatedAt);
}
