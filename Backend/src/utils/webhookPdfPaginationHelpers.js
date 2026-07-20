function buildEmptyTableContent(rowCount, colCount) {
  return JSON.stringify(
    Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => '')),
  );
}

function parseBaseTableInfo(baseTableSchema, tableHeight) {
  let rowsPerPage = 0;
  let baseTableCols = 0;
  try {
    const parsed = JSON.parse(baseTableSchema.content ?? '[]');
    if (Array.isArray(parsed)) {
      rowsPerPage = parsed.length;
      const firstRow = parsed[0];
      if (Array.isArray(firstRow)) {
        baseTableCols = firstRow.length;
      }
    }
  } catch {
    /* ignore parse errors */
  }
  if (!rowsPerPage || rowsPerPage <= 0) {
    rowsPerPage = 10;
  }
  if (!baseTableCols || baseTableCols <= 0) {
    baseTableCols = Array.isArray(baseTableSchema.head) ? baseTableSchema.head.length : 1;
  }
  return { rowsPerPage, baseTableCols, approxRowHeightBase: (tableHeight > 0 && rowsPerPage > 0) ? (tableHeight / rowsPerPage) : 12 };
}

function computePaginationLayout(template, baseTableSchema, tableBottomY, rowsPerPage, approxRowHeightBase) {
  const padding = template?.basePdf?.padding;
  const topPadding = Array.isArray(padding) ? (Number(padding[0]) || 20) : 20;
  const bottomPadding = Array.isArray(padding) ? (Number(padding[2]) || 20) : 20;
  const pageHeight = Number(template?.basePdf?.height) || 297;
  const EPS = 0.5;
  const ROW_HEIGHT_SAFETY_FACTOR = 1.3;
  const approxRowHeight = approxRowHeightBase * ROW_HEIGHT_SAFETY_FACTOR;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const availableHeightNoFooter = clamp(pageHeight - topPadding - bottomPadding, 40, pageHeight);

  let footerMinY = pageHeight - bottomPadding;
  for (const s of template.schemas?.[0] || []) {
    if (!s || s.type === 'table') continue;
    const y = s.position?.y;
    if (typeof y === 'number' && y > (tableBottomY + EPS)) {
      footerMinY = Math.min(footerMinY, y);
    }
  }

  const availableHeightWithFooter = clamp((footerMinY - topPadding - EPS), 40, availableHeightNoFooter);
  return {
    topPadding,
    EPS,
    tableTopY: Number(baseTableSchema.position?.y) || 0,
    rowsPerPageNoFooter: clamp(Math.floor(availableHeightNoFooter / approxRowHeight), rowsPerPage, 200),
    rowsPerPageLastWithFooter: clamp(Math.floor(availableHeightWithFooter / approxRowHeight), rowsPerPage, 200),
    availableHeightNoFooter,
    availableHeightWithFooter,
  };
}

function buildRowChunks(safeRows, rowsPerPage, rowsPerPageNoFooter, rowsPerPageLastWithFooter) {
  const chunks = [];
  let cursor = 0;
  chunks.push(safeRows.slice(cursor, cursor + rowsPerPage));
  cursor += rowsPerPage;
  while (cursor < safeRows.length) {
    const remaining = safeRows.length - cursor;
    if (remaining <= rowsPerPageLastWithFooter) {
      chunks.push(safeRows.slice(cursor));
      break;
    }
    chunks.push(safeRows.slice(cursor, cursor + rowsPerPageNoFooter));
    cursor += rowsPerPageNoFooter;
  }
  return chunks;
}

function filterFirstPageSchemas(pageSchemasClone, pageTableName, tableBottomY, isLast, EPS) {
  if (isLast) {
    return pageSchemasClone;
  }
  return pageSchemasClone.filter((s) => {
    if (s?.type === 'table' && s?.name === pageTableName) return true;
    const y = s?.position?.y;
    if (typeof y !== 'number') return true;
    return y <= (tableBottomY + EPS);
  });
}

function filterContinuationPageSchemas(pageSchemasClone, pageTableName, tableTopY, isLast, EPS) {
  if (!isLast) {
    return pageSchemasClone.filter((s) => s?.type === 'table' && s?.name === pageTableName);
  }
  return pageSchemasClone.filter((s) => {
    if (s?.type === 'table' && s?.name === pageTableName) return true;
    const y = s?.position?.y;
    if (typeof y !== 'number') return true;
    return y >= (tableTopY - EPS);
  });
}

function configureTableCloneForPage(tableClone, pageIndex, layout, baseTableCols, chunks, pageTableName) {
  if (!tableClone) return;
  const isLast = pageIndex === chunks.length - 1;
  tableClone.name = pageTableName;
  if (pageIndex > 0 && tableClone.position) {
    tableClone.position.y = layout.topPadding;
    tableClone.height = isLast ? layout.availableHeightWithFooter : layout.availableHeightNoFooter;
    const pageRowCapacity = isLast ? layout.rowsPerPageLastWithFooter : layout.rowsPerPageNoFooter;
    tableClone.content = buildEmptyTableContent(pageRowCapacity, baseTableCols);
  }
}

function buildPaginatedSchemas(basePageSchemas, tableSchemaName, chunks, layout, baseTableCols, tableBottomY) {
  const newSchemas = [];
  const tableInputs = {};
  const { topPadding, EPS, tableTopY, availableHeightNoFooter, availableHeightWithFooter, rowsPerPageNoFooter, rowsPerPageLastWithFooter } = layout;

  for (let pageIndex = 0; pageIndex < chunks.length; pageIndex++) {
    const isLast = pageIndex === chunks.length - 1;
    const pageSchemasClone = JSON.parse(JSON.stringify(basePageSchemas));
    const tableClone = pageSchemasClone.find((s) => s?.type === 'table' && s?.name === tableSchemaName);
    const pageTableName = `${tableSchemaName}_${pageIndex + 1}`;

    configureTableCloneForPage(tableClone, pageIndex, {
      topPadding,
      availableHeightNoFooter,
      availableHeightWithFooter,
      rowsPerPageNoFooter,
      rowsPerPageLastWithFooter,
    }, baseTableCols, chunks, pageTableName);

    const pageRows = Array.isArray(chunks[pageIndex]) ? chunks[pageIndex] : [];
    tableInputs[pageTableName] = JSON.stringify(pageRows);

    if (pageIndex === 0) {
      newSchemas.push(filterFirstPageSchemas(pageSchemasClone, pageTableName, tableBottomY, isLast, EPS));
      continue;
    }

    newSchemas.push(filterContinuationPageSchemas(pageSchemasClone, pageTableName, tableTopY, isLast, EPS));
  }

  return { newSchemas, tableInputs };
}

export function paginatePdfmeTemplateTableByRows(template, tableSchemaName, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const pages = template?.schemas;
  if (!template || !Array.isArray(pages) || pages.length === 0) {
    return { template, tableInputs: { [tableSchemaName]: JSON.stringify(safeRows) } };
  }

  const basePageSchemas = pages[0];
  if (!Array.isArray(basePageSchemas)) {
    return { template, tableInputs: { [tableSchemaName]: JSON.stringify(safeRows) } };
  }

  const baseTableSchema = basePageSchemas.find((s) => s?.type === 'table' && s?.name === tableSchemaName);
  if (!baseTableSchema) {
    return { template, tableInputs: { [tableSchemaName]: JSON.stringify(safeRows) } };
  }

  const tableHeight = Number(baseTableSchema.height) || 0;
  const tableBottomY = (Number(baseTableSchema.position?.y) || 0) + tableHeight;
  const { rowsPerPage, baseTableCols, approxRowHeightBase } = parseBaseTableInfo(baseTableSchema, tableHeight);

  if (safeRows.length <= rowsPerPage) {
    return { template, tableInputs: { [tableSchemaName]: JSON.stringify(safeRows) } };
  }

  const layout = computePaginationLayout(template, baseTableSchema, tableBottomY, rowsPerPage, approxRowHeightBase);
  const chunks = buildRowChunks(safeRows, rowsPerPage, layout.rowsPerPageNoFooter, layout.rowsPerPageLastWithFooter);
  const { newSchemas, tableInputs } = buildPaginatedSchemas(
    basePageSchemas,
    tableSchemaName,
    chunks,
    layout,
    baseTableCols,
    tableBottomY,
  );

  return { template: { ...template, schemas: newSchemas }, tableInputs };
}
