import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';
import fs from 'fs';
import { fileURLToPath } from 'url';

function paginatePdfmeTemplateTableByRows(template, tableSchemaName, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const pages = template?.schemas;
  if (!template || !Array.isArray(pages) || pages.length === 0) {
    return { template, tableInputs: { [tableSchemaName]: JSON.stringify(safeRows) } };
  }

  const basePageSchemas = pages[0];
  if (!Array.isArray(basePageSchemas)) {
    return { template, tableInputs: { [tableSchemaName]: JSON.stringify(safeRows) } };
  }

  const baseTableSchema = basePageSchemas.find(
    (s) => s?.type === 'table' && s?.name === tableSchemaName
  );
  if (!baseTableSchema) {
    return { template, tableInputs: { [tableSchemaName]: JSON.stringify(safeRows) } };
  }

  let rowsPerPage = 0;
  try {
    const parsed = JSON.parse(baseTableSchema.content ?? '[]');
    if (Array.isArray(parsed)) rowsPerPage = parsed.length;
  } catch {
    // ignore
  }
  if (!rowsPerPage || rowsPerPage <= 0) rowsPerPage = 10;

  if (safeRows.length <= rowsPerPage) {
    return { template, tableInputs: { [tableSchemaName]: JSON.stringify(safeRows) } };
  }

  const chunks = [];
  for (let i = 0; i < safeRows.length; i += rowsPerPage) {
    chunks.push(safeRows.slice(i, i + rowsPerPage));
  }

  const tableBottomY =
    (Number(baseTableSchema.position?.y) || 0) + (Number(baseTableSchema.height) || 0);

  const newSchemas = [];
  const tableInputs = {};

  for (let pageIndex = 0; pageIndex < chunks.length; pageIndex++) {
    const isLast = pageIndex === chunks.length - 1;
    const pageSchemasClone = JSON.parse(JSON.stringify(basePageSchemas));

    const tableClone = pageSchemasClone.find(
      (s) => s?.type === 'table' && s?.name === tableSchemaName
    );
    const pageTableName = `${tableSchemaName}_${pageIndex + 1}`;
    if (tableClone) tableClone.name = pageTableName;

    const columnCount = Array.isArray(tableClone?.head)
      ? tableClone.head.length
      : Array.isArray(chunks[pageIndex]?.[0])
        ? chunks[pageIndex][0].length
        : 0;

    const paddedRows = [...chunks[pageIndex]];
    while (paddedRows.length < rowsPerPage) {
      paddedRows.push(Array(columnCount).fill(''));
    }

    tableInputs[pageTableName] = JSON.stringify(paddedRows);

    if (!isLast) {
      const filtered = pageSchemasClone.filter((s) => {
        if (s?.type === 'table' && s?.name === pageTableName) return true;
        const y = s?.position?.y;
        if (typeof y !== 'number') return true;
        return y <= tableBottomY + 0.5;
      });
      newSchemas.push(filtered);
    } else {
      newSchemas.push(pageSchemasClone);
    }
  }

  return { template: { ...template, schemas: newSchemas }, tableInputs };
}

function approxPdfPageCount(pdfBytes) {
  const s = new TextDecoder('latin1').decode(pdfBytes);
  const matches = s.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}

async function run(templatePath, columns) {
  const tpl = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const rows = Array.from({ length: 40 }, (_, i) =>
    Array.from({ length: columns }, (_c, j) => `R${i + 1}C${j + 1}`)
  );

  const { template, tableInputs } = paginatePdfmeTemplateTableByRows(tpl, 'orders', rows);
  const inputs = [
    {
      ...tableInputs,
      logo: '',
      subtotal: '$0.00',
      totalGST: '$0.00',
      total: '$0.00',
      clientDetails: '{}',
      invoiceDetails: '{}',
      companyName: '{}',
      companyDetails: '{}',
      dueDate: '',
      'Bank Details': '{}',
    },
  ];

  const pdfBytes = await generate({
    template,
    inputs,
    plugins: { text, image, line, table, multiVariableText },
  });

  console.log(
    `${templatePath.split('/').pop()} -> templatePages=${template.schemas.length}, pdfPages≈${approxPdfPageCount(pdfBytes)}`
  );
}

await run(fileURLToPath(new URL('../src/assets/taxInvoiceAG.json', import.meta.url)), 8);
await run(fileURLToPath(new URL('../src/assets/participantTaxInvoiceAG.json', import.meta.url)), 9);

