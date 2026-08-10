import { describe, it, expect } from 'vitest';
import { paginatePdfmeTemplateTableByRows } from '../../../src/utils/webhookPdfPaginationHelpers.js';

// ---------------------------------------------------------------------------
// Fixture mirrors the real committed pdfme templates (src/assets/*.json):
// a single page of schemas, a `basePdf` with width/height/padding, an image +
// multiVariableText header above the table, and text/line footer schemas below
// it. The numbers below are chosen so every layout figure can be derived by
// hand; each expectation in this file is a literal, never computed with the
// code under test.
//
// Derivation for `makeTemplate()` (documented once, referenced throughout):
//
//   rowsPerPage              = 5      (rows in the table schema's `content`)
//   baseTableCols            = 3      (columns in the first content row)
//   tableHeight              = 100
//   approxRowHeightBase      = 100 / 5                       = 20
//   approxRowHeight          = 20 * 1.3 (safety factor)      = 26
//   tableTopY                = 60
//   tableBottomY             = 60 + 100                      = 160
//   topPadding / bottom      = 20 / 20      (basePdf.padding = [20,20,20,20])
//   pageHeight               = 300
//   availableHeightNoFooter  = clamp(300 - 20 - 20, 40, 300) = 260
//   footerMinY               = min(300 - 20, 200, 210)       = 200
//     (only non-table schemas with y > tableBottomY + 0.5 = 160.5 count:
//      `total` at 200 and `bankDetails` at 210)
//   availableHeightWithFooter= clamp(200 - 20 - 0.5, 40, 260)= 179.5
//   rowsPerPageNoFooter      = clamp(floor(260   / 26), 5, 200) = 10
//   rowsPerPageLastWithFooter= clamp(floor(179.5 / 26), 5, 200) = 6
// ---------------------------------------------------------------------------

const emptyContent = (rows, cols) =>
  JSON.stringify(Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')));

function makeTemplate(tableOverrides = {}, basePdfOverrides = {}) {
  return {
    basePdf: { width: 210, height: 300, padding: [20, 20, 20, 20], ...basePdfOverrides },
    schemas: [[
      { name: 'logo', type: 'image', position: { x: 20, y: 25 }, width: 30, height: 20, content: '' },
      { name: 'clientDetails', type: 'multiVariableText', position: { x: 20, y: 40 }, width: 80, height: 20, content: '{}' },
      {
        name: 'orders',
        type: 'table',
        position: { x: 20, y: 60 },
        width: 170,
        height: 100,
        head: ['Date', 'Description', 'Total Amount'],
        content: emptyContent(5, 3),
        ...tableOverrides,
      },
      { name: 'total', type: 'text', position: { x: 150, y: 200 }, width: 40, height: 7, content: '' },
      { name: 'bankDetails', type: 'multiVariableText', position: { x: 20, y: 210 }, width: 80, height: 20, content: '{}' },
    ]],
  };
}

const makeRows = (n) =>
  Array.from({ length: n }, (_, i) => [`0${(i % 9) + 1}/01/2026`, `Service ${i + 1}`, `$${i + 1}.00`]);

const namesOf = (pageSchemas) => pageSchemas.map((s) => s?.name ?? null);
const tableOf = (pageSchemas, name) => pageSchemas.find((s) => s?.type === 'table' && s?.name === name);

describe('paginatePdfmeTemplateTableByRows', () => {
  describe('cases that do not paginate', () => {
    it('returns the same template object and one input keyed by the raw table name when rows fit exactly', () => {
      const template = makeTemplate();
      const rows = makeRows(5); // rowsPerPage is 5 — exactly one page

      const result = paginatePdfmeTemplateTableByRows(template, 'orders', rows);

      expect(result.template).toBe(template);
      expect(Object.keys(result.tableInputs)).toEqual(['orders']);
      expect(JSON.parse(result.tableInputs.orders)).toEqual(rows);
    });

    it('returns "[]" for a null, undefined or non-array rows argument', () => {
      const template = makeTemplate();

      expect(paginatePdfmeTemplateTableByRows(template, 'orders', null).tableInputs)
        .toEqual({ orders: '[]' });
      expect(paginatePdfmeTemplateTableByRows(template, 'orders', undefined).tableInputs)
        .toEqual({ orders: '[]' });
      expect(paginatePdfmeTemplateTableByRows(template, 'orders', 'not-rows').tableInputs)
        .toEqual({ orders: '[]' });
    });

    it('passes a null template straight back with the rows serialised', () => {
      const rows = makeRows(50);

      const result = paginatePdfmeTemplateTableByRows(null, 'orders', rows);

      expect(result.template).toBe(null);
      expect(JSON.parse(result.tableInputs.orders)).toEqual(rows);
    });

    it('gives up when schemas is missing, not an array, or empty', () => {
      const rows = makeRows(50);

      const noSchemas = { basePdf: { height: 300 } };
      expect(paginatePdfmeTemplateTableByRows(noSchemas, 'orders', rows).template).toBe(noSchemas);

      const schemasObject = { basePdf: { height: 300 }, schemas: { 0: [] } };
      expect(paginatePdfmeTemplateTableByRows(schemasObject, 'orders', rows).template).toBe(schemasObject);

      const emptySchemas = { basePdf: { height: 300 }, schemas: [] };
      expect(paginatePdfmeTemplateTableByRows(emptySchemas, 'orders', rows).template).toBe(emptySchemas);
    });

    it('gives up when the first page is not an array of schemas', () => {
      const template = { basePdf: { height: 300 }, schemas: [{ notAnArray: true }] };

      const result = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(50));

      expect(result.template).toBe(template);
      expect(result.tableInputs).toEqual({ orders: JSON.stringify(makeRows(50)) });
    });

    it('gives up when no table schema carries the requested name', () => {
      const template = makeTemplate({ name: 'lineItems' });

      const result = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(50));

      expect(result.template).toBe(template);
      expect(Object.keys(result.tableInputs)).toEqual(['orders']);
    });

    it('ignores a non-table schema that happens to share the table name', () => {
      const template = makeTemplate({ name: 'orders' });
      // The header text is also called "orders" but is type text, so the finder
      // must skip it and still locate the real table.
      template.schemas[0].unshift({ name: 'orders', type: 'text', position: { x: 20, y: 10 }, height: 7, content: '' });

      const result = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(6));

      expect(result.template).not.toBe(template);
      expect(result.template.schemas).toHaveLength(2);
    });
  });

  describe('the row-per-page boundary', () => {
    it('splits one row past capacity into a 5 + 1 two-page document', () => {
      const template = makeTemplate();
      const rows = makeRows(6);

      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(template, 'orders', rows);

      expect(paginated.schemas).toHaveLength(2);
      expect(Object.keys(tableInputs)).toEqual(['orders_1', 'orders_2']);
      expect(JSON.parse(tableInputs.orders_1)).toEqual(rows.slice(0, 5));
      expect(JSON.parse(tableInputs.orders_2)).toEqual([rows[5]]);
    });

    it('keeps a final chunk that exactly fills the with-footer capacity on the second page', () => {
      // 11 rows: 5 on page 1, remaining 6 === rowsPerPageLastWithFooter, so the
      // loop takes the "remaining fits" branch rather than emitting a 10-row page.
      const rows = makeRows(11);

      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(makeTemplate(), 'orders', rows);

      expect(paginated.schemas).toHaveLength(2);
      expect(JSON.parse(tableInputs.orders_1)).toHaveLength(5);
      expect(JSON.parse(tableInputs.orders_2)).toHaveLength(6);
      expect(JSON.parse(tableInputs.orders_2)).toEqual(rows.slice(5));
    });

    it('overfills the last page when the remainder is one row past the with-footer capacity', () => {
      // 12 rows: remaining 7 > 6, so a 10-row no-footer slice is taken — but only
      // 7 rows are left, and that 7-row chunk is also the last page, which is
      // sized for 6. Characterising the real behaviour, not endorsing it.
      const rows = makeRows(12);

      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(makeTemplate(), 'orders', rows);

      expect(paginated.schemas).toHaveLength(2);
      expect(JSON.parse(tableInputs.orders_2)).toHaveLength(7);

      const lastTable = tableOf(paginated.schemas[1], 'orders_2');
      expect(lastTable.height).toBe(179.5);
      expect(JSON.parse(lastTable.content)).toHaveLength(6); // 6 placeholder rows for 7 real rows
    });

    it('splits 20 rows into 5 + 10 + 5 across three pages', () => {
      const rows = makeRows(20);

      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(makeTemplate(), 'orders', rows);

      expect(paginated.schemas).toHaveLength(3);
      expect(Object.keys(tableInputs)).toEqual(['orders_1', 'orders_2', 'orders_3']);
      expect(JSON.parse(tableInputs.orders_1)).toEqual(rows.slice(0, 5));
      expect(JSON.parse(tableInputs.orders_2)).toEqual(rows.slice(5, 15));
      expect(JSON.parse(tableInputs.orders_3)).toEqual(rows.slice(15, 20));
    });

    it('splits 22 rows into 5 + 10 + 7', () => {
      const rows = makeRows(22);

      const { tableInputs } = paginatePdfmeTemplateTableByRows(makeTemplate(), 'orders', rows);

      expect(JSON.parse(tableInputs.orders_1)).toHaveLength(5);
      expect(JSON.parse(tableInputs.orders_2)).toHaveLength(10);
      expect(JSON.parse(tableInputs.orders_3)).toHaveLength(7);
    });

    it('every row appears exactly once, in order, across a long document', () => {
      const rows = makeRows(41); // 5 + 10 + 10 + 10 + 6
      const { tableInputs } = paginatePdfmeTemplateTableByRows(makeTemplate(), 'orders', rows);

      const keys = Object.keys(tableInputs);
      expect(keys).toEqual(['orders_1', 'orders_2', 'orders_3', 'orders_4', 'orders_5']);
      const lengths = keys.map((k) => JSON.parse(tableInputs[k]).length);
      expect(lengths).toEqual([5, 10, 10, 10, 6]);
      expect(keys.flatMap((k) => JSON.parse(tableInputs[k]))).toEqual(rows);
    });
  });

  describe('per-page schema selection', () => {
    it('drops footer schemas from the first page and header schemas from continuation pages', () => {
      const { template: paginated } = paginatePdfmeTemplateTableByRows(makeTemplate(), 'orders', makeRows(20));

      // page 1: everything at or above tableBottomY + 0.5 (160.5), plus the table
      expect(namesOf(paginated.schemas[0])).toEqual(['logo', 'clientDetails', 'orders_1']);
      // middle page: the table and nothing else
      expect(namesOf(paginated.schemas[1])).toEqual(['orders_2']);
      // last page: the table plus everything at or below tableTopY - 0.5 (59.5)
      expect(namesOf(paginated.schemas[2])).toEqual(['orders_3', 'total', 'bankDetails']);
    });

    it('repositions and resizes the table on continuation pages but leaves page one alone', () => {
      const { template: paginated } = paginatePdfmeTemplateTableByRows(makeTemplate(), 'orders', makeRows(20));

      const first = tableOf(paginated.schemas[0], 'orders_1');
      expect(first.position).toEqual({ x: 20, y: 60 }); // untouched
      expect(first.height).toBe(100);
      expect(JSON.parse(first.content)).toHaveLength(5);

      const middle = tableOf(paginated.schemas[1], 'orders_2');
      expect(middle.position).toEqual({ x: 20, y: 20 }); // moved to topPadding
      expect(middle.height).toBe(260); // availableHeightNoFooter
      expect(JSON.parse(middle.content)).toEqual(JSON.parse(emptyContent(10, 3)));

      const last = tableOf(paginated.schemas[2], 'orders_3');
      expect(last.position).toEqual({ x: 20, y: 20 });
      expect(last.height).toBe(179.5); // availableHeightWithFooter
      expect(JSON.parse(last.content)).toEqual(JSON.parse(emptyContent(6, 3)));
    });

    it('keeps schemas with no numeric y on both the first and the last page', () => {
      const template = makeTemplate();
      template.schemas[0].push({ name: 'watermark', type: 'text', height: 7, content: '' });
      template.schemas[0].push({ name: 'stringY', type: 'text', position: { x: 1, y: '250' }, height: 7, content: '' });

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(6));

      expect(namesOf(paginated.schemas[0])).toEqual(['logo', 'clientDetails', 'orders_1', 'watermark', 'stringY']);
      expect(namesOf(paginated.schemas[1])).toEqual(['orders_2', 'total', 'bankDetails', 'watermark', 'stringY']);
    });

    it('survives a null entry in the schema array and keeps it on both pages', () => {
      const template = makeTemplate();
      template.schemas[0].push(null);

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(6));

      expect(namesOf(paginated.schemas[0])).toEqual(['logo', 'clientDetails', 'orders_1', null]);
      expect(namesOf(paginated.schemas[1])).toEqual(['orders_2', 'total', 'bankDetails', null]);
    });

    it('does not mutate the input template', () => {
      const template = makeTemplate();
      const before = JSON.stringify(template);

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(20));

      expect(JSON.stringify(template)).toBe(before);
      expect(paginated).not.toBe(template);
      expect(paginated.basePdf).toBe(template.basePdf); // shallow copy of everything but schemas
    });

    it('uses only page one of a multi-page template as the base and replaces every page', () => {
      const template = makeTemplate();
      template.schemas.push([{ name: 'appendix', type: 'text', position: { x: 20, y: 30 }, height: 7, content: '' }]);

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(6));

      expect(paginated.schemas).toHaveLength(2);
      expect(paginated.schemas.flatMap(namesOf)).not.toContain('appendix');
    });
  });

  describe('reading the base table', () => {
    it('falls back to 10 rows per page when the table content is not valid JSON', () => {
      const template = makeTemplate({ content: '{not json' });

      // 10 rows still fit the fallback page size...
      expect(Object.keys(paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(10)).tableInputs))
        .toEqual(['orders']);
      // ...11 do not.
      const { tableInputs } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(11));
      expect(JSON.parse(tableInputs.orders_1)).toHaveLength(10);
      expect(JSON.parse(tableInputs.orders_2)).toHaveLength(1);
    });

    it('falls back to 10 rows per page and to head.length columns for empty content', () => {
      const template = makeTemplate({ content: '[]' });

      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(11));

      expect(JSON.parse(tableInputs.orders_1)).toHaveLength(10);
      // approxRowHeightBase = 100 / 10 = 10, * 1.3 = 13
      // rowsPerPageLastWithFooter = clamp(floor(179.5 / 13), 10, 200) = 13
      const last = tableOf(paginated.schemas[1], 'orders_2');
      expect(JSON.parse(last.content)).toEqual(JSON.parse(emptyContent(13, 3)));
    });

    it('takes the column count from head when the first content row is not an array', () => {
      // content is a flat array of 3 strings: rowsPerPage = 3, first row is a
      // string, so baseTableCols falls back to head.length = 3.
      // approxRowHeightBase = 90 / 3 = 30, * 1.3 = 39
      // tableBottomY = 60 + 90 = 150; footerMinY = 200
      // rowsPerPageNoFooter       = clamp(floor(260   / 39), 3, 200) = 6
      // rowsPerPageLastWithFooter = clamp(floor(179.5 / 39), 3, 200) = 4
      const template = makeTemplate({ height: 90, content: '["x","y","z"]' });

      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(10));

      expect(Object.keys(tableInputs)).toEqual(['orders_1', 'orders_2', 'orders_3']);
      expect([tableInputs.orders_1, tableInputs.orders_2, tableInputs.orders_3].map((s) => JSON.parse(s).length))
        .toEqual([3, 6, 1]);
      expect(JSON.parse(tableOf(paginated.schemas[1], 'orders_2').content)).toEqual(JSON.parse(emptyContent(6, 3)));
    });

    it('falls back to a single column when head is missing too', () => {
      const template = makeTemplate({ height: 90, content: '["x","y","z"]', head: undefined });

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(10));

      expect(JSON.parse(tableOf(paginated.schemas[1], 'orders_2').content)).toEqual(JSON.parse(emptyContent(6, 1)));
    });

    it('uses a 12pt default row height when the table declares no height', () => {
      // tableHeight = 0 -> approxRowHeightBase = 12, * 1.3 = 15.6
      // tableBottomY = 60; footerMinY = 200; availableHeightWithFooter = 179.5
      // rowsPerPageNoFooter       = clamp(floor(260   / 15.6), 5, 200) = 16
      // rowsPerPageLastWithFooter = clamp(floor(179.5 / 15.6), 5, 200) = 11
      const template = makeTemplate({ height: 0 });

      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(30));

      expect([tableInputs.orders_1, tableInputs.orders_2, tableInputs.orders_3].map((s) => JSON.parse(s).length))
        .toEqual([5, 16, 9]);
      expect(JSON.parse(tableOf(paginated.schemas[1], 'orders_2').content)).toEqual(JSON.parse(emptyContent(16, 3)));
      expect(JSON.parse(tableOf(paginated.schemas[2], 'orders_3').content)).toEqual(JSON.parse(emptyContent(11, 3)));
    });
  });

  describe('layout clamps', () => {
    it('never lets a continuation page hold fewer rows than the base table', () => {
      // tableHeight 300 over 5 rows -> approxRowHeight = 60 * 1.3 = 78.
      // floor(260 / 78) = 3, which is clamped up to rowsPerPage = 5.
      // tableBottomY = 360, so no schema sits below it and footerMinY stays
      // 300 - 20 = 280 -> availableHeightWithFooter = clamp(259.5, 40, 260) = 259.5,
      // floor(259.5 / 78) = 3, clamped up to 5 as well.
      const template = makeTemplate({ height: 300 });

      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(12));

      expect([tableInputs.orders_1, tableInputs.orders_2, tableInputs.orders_3].map((s) => JSON.parse(s).length))
        .toEqual([5, 5, 2]);
      expect(tableOf(paginated.schemas[1], 'orders_2').height).toBe(260);
      expect(tableOf(paginated.schemas[2], 'orders_3').height).toBe(259.5);
    });

    it('caps a continuation page at 200 rows however small the rows are', () => {
      // tableHeight 2 over 5 rows -> approxRowHeight = 0.4 * 1.3 = 0.52.
      // floor(260 / 0.52) = 500 and floor(179.5 / 0.52) = 345, both clamped to 200.
      const template = makeTemplate({ height: 2 });

      const { tableInputs } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(210));

      expect([tableInputs.orders_1, tableInputs.orders_2, tableInputs.orders_3].map((s) => JSON.parse(s).length))
        .toEqual([5, 200, 5]);
    });

    it('floors the usable page height at 40 for an absurdly short page', () => {
      // pageHeight 50 - 20 - 20 = 10, clamped up to 40; the with-footer height is
      // then clamped to that same 40.
      const template = makeTemplate({}, { height: 50 });

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(12));

      expect(paginated.schemas).toHaveLength(3);
      expect(tableOf(paginated.schemas[1], 'orders_2').height).toBe(40);
      expect(tableOf(paginated.schemas[2], 'orders_3').height).toBe(40);
    });
  });

  describe('padding and positioning', () => {
    it('treats a missing or non-array padding as 20 on both edges', () => {
      const template = makeTemplate({}, { padding: undefined });

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(6));

      expect(tableOf(paginated.schemas[1], 'orders_2').position.y).toBe(20);
      expect(tableOf(paginated.schemas[1], 'orders_2').height).toBe(179.5);
    });

    it('treats a zero padding as 20, because 0 is falsy', () => {
      const template = makeTemplate({}, { padding: [0, 0, 0, 0] });

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(6));

      expect(tableOf(paginated.schemas[1], 'orders_2').position.y).toBe(20);
    });

    it('honours a real asymmetric padding', () => {
      // topPadding 30, bottomPadding 40 -> availableHeightNoFooter = clamp(230, 40, 300) = 230
      // availableHeightWithFooter = clamp(200 - 30 - 0.5, 40, 230) = 169.5
      const template = makeTemplate({}, { padding: [30, 10, 40, 10] });

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(20));

      expect(tableOf(paginated.schemas[1], 'orders_2').position.y).toBe(30);
      expect(tableOf(paginated.schemas[1], 'orders_2').height).toBe(230);
      expect(tableOf(paginated.schemas[2], 'orders_3').height).toBe(169.5);
    });

    it('defaults the page height to A4 297mm when basePdf declares none', () => {
      // availableHeightNoFooter = clamp(297 - 20 - 20, 40, 297) = 257
      const template = makeTemplate({}, { height: undefined });

      const { template: paginated } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(20));

      expect(tableOf(paginated.schemas[1], 'orders_2').height).toBe(257);
    });

    it('leaves a table with no position untouched on continuation pages', () => {
      const template = makeTemplate({ position: undefined });
      // tableTopY = 0 and tableBottomY = 100, so `total` (200) and `bankDetails`
      // (210) still count as footer schemas; every non-table schema sits at or
      // above tableTopY - 0.5, so the last page keeps them all.
      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(6));

      const continuation = tableOf(paginated.schemas[1], 'orders_2');
      expect(continuation.position).toBeUndefined();
      expect(continuation.height).toBe(100); // never resized
      expect(JSON.parse(continuation.content)).toHaveLength(5); // never re-padded
      expect(JSON.parse(tableInputs.orders_2)).toHaveLength(1);
      expect(namesOf(paginated.schemas[1]))
        .toEqual(['logo', 'clientDetails', 'orders_2', 'total', 'bankDetails']);
    });
  });

  describe('against the committed participantTaxInvoiceAG.json template', () => {
    // Values read from src/assets/participantTaxInvoiceAG.json:
    //   basePdf 210 x 297, padding [20,20,20,20]
    //   table "orders" at y 94, height 125.08784, 9 content rows x 8 columns
    //   footer text starts at y 227 (subtotalLabel/subtotal)
    //   approxRowHeightBase = 125.08784 / 9 = 13.898649, * 1.3 = 18.068244
    //   availableHeightNoFooter   = 297 - 20 - 20            = 257
    //   availableHeightWithFooter = 227 - 20 - 0.5           = 206.5
    //   rowsPerPageNoFooter       = floor(257   / 18.068244) = 14
    //   rowsPerPageLastWithFooter = floor(206.5 / 18.068244) = 11
    const loadRealTemplate = async () => {
      const { readFile } = await import('node:fs/promises');
      const url = new URL('../../../src/assets/participantTaxInvoiceAG.json', import.meta.url);
      return JSON.parse(await readFile(url, 'utf8'));
    };

    it('does not paginate the 9 rows the template already has room for', async () => {
      const template = await loadRealTemplate();

      const result = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(9));

      expect(result.template).toBe(template);
      expect(Object.keys(result.tableInputs)).toEqual(['orders']);
    });

    it('splits 30 real rows into 9 + 14 + 7 and moves the footer to the last page', async () => {
      const template = await loadRealTemplate();

      const { template: paginated, tableInputs } = paginatePdfmeTemplateTableByRows(template, 'orders', makeRows(30));

      expect(paginated.schemas).toHaveLength(3);
      expect([tableInputs.orders_1, tableInputs.orders_2, tableInputs.orders_3].map((s) => JSON.parse(s).length))
        .toEqual([9, 14, 7]);

      expect(namesOf(paginated.schemas[0])).toEqual([
        'logo', 'title', 'clientDetails', 'invoiceDetails', 'companyName', 'companyDetails', 'orders_1',
      ]);
      expect(namesOf(paginated.schemas[1])).toEqual(['orders_2']);
      expect(namesOf(paginated.schemas[2])).toEqual([
        'orders_3', 'subtotalLabel', 'subtotal', 'totalGST', 'line',
        'totalLabel', 'total', 'Bank Details', 'duedateLabel', 'dueDate', 'gstLabel',
      ]);

      const middle = tableOf(paginated.schemas[1], 'orders_2');
      expect(middle.position.y).toBe(20);
      expect(middle.height).toBe(257);
      expect(JSON.parse(middle.content)).toEqual(JSON.parse(emptyContent(14, 8)));

      const last = tableOf(paginated.schemas[2], 'orders_3');
      expect(last.height).toBe(206.5);
      expect(JSON.parse(last.content)).toEqual(JSON.parse(emptyContent(11, 8)));
    });
  });
});
