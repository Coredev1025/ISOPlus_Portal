// Check what an automation run actually produced, and optionally export it.
//
//   node scripts/verify-automation-output.mjs [--workspace 55390] [--out <dir>]
//
// Run it after `npm run tick`. It reads the offline store the worker wrote to
// (.local-s3/output/<workspace> and .local-s3/outbox/<workspace>) and answers
// the two questions a green tick does not: is every generated PDF actually
// populated, and does every composed email carry only its own board's
// documents. Exits non-zero when either fails, so it can gate a demo.
//
// With --out it also copies the PDFs and emails there, writes verification.json
// and a README, and renders page 1 of each PDF to PNG so a blank page is
// visible without opening sixteen files. The PNG step needs macOS `sips` and
// is skipped with a note anywhere else — the checks themselves are pure Node.

import { createRequire } from 'node:module';
import {
  copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classifyPdf, foreignAttachments, pdfTextVolume, summariseRun } from './verifyAutomationShape.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument } = require('@pdfme/pdf-lib');

const LOCAL_S3 = fileURLToPath(new URL('../.local-s3', import.meta.url));

function parseArgs(argv) {
  const args = { workspace: '55390', out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace') args.workspace = argv[i + 1];
    if (argv[i] === '--out') args.out = argv[i + 1];
  }
  return args;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
}

function readDirSafe(dir) {
  try {
    return walk(dir);
  } catch {
    return [];
  }
}

async function collectPdfs(root) {
  const pdfs = [];
  for (const file of readDirSafe(root).filter((f) => f.endsWith('.pdf'))) {
    const buf = readFileSync(file);
    const doc = await PDFDocument.load(buf);
    const rel = relative(root, file);
    pdfs.push({
      file: rel,
      path: file,
      board: rel.split('/')[0],
      kind: classifyPdf(rel),
      bytes: statSync(file).size,
      pages: doc.getPageCount(),
      textChars: pdfTextVolume(buf),
    });
  }
  return pdfs.sort((a, b) => a.file.localeCompare(b.file));
}

function collectEmails(root) {
  return readDirSafe(root)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const composed = JSON.parse(readFileSync(file, 'utf8'));
      return {
        file: basename(file),
        path: file,
        boardId: composed.boardId,
        subject: composed.subject,
        attachments: composed.attachments ?? [],
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Page 1 of each PDF as a PNG. Best-effort: macOS only, never fatal. */
async function renderPreviews(pdfs, dir) {
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('sips', ['--version'], { stdio: 'ignore' });
  } catch {
    return 'skipped (sips not available — macOS only)';
  }

  for (const pdf of pdfs) {
    const slug = pdf.file.replace(/[/ ]/g, '_').replace(/\.pdf$/, '');
    const onePage = await PDFDocument.create();
    const [page] = await onePage.copyPages(await PDFDocument.load(readFileSync(pdf.path)), [0]);
    onePage.addPage(page);
    const tmp = join(dir, `${slug}.pdf`);
    writeFileSync(tmp, await onePage.save());
    execFileSync('sips', ['-s', 'format', 'png', '--resampleWidth', '1300', tmp, '--out', join(dir, `${slug}.png`)], { stdio: 'ignore' });
    rmSync(tmp);
  }
  return `${pdfs.length} rendered`;
}

function writeReadme(dir, { workspace, summary, pdfs, emails, previews }) {
  const rows = pdfs.map((p) =>
    `| ${p.file} | ${p.kind} | ${p.pages} | ${p.bytes.toLocaleString()} | ${p.textChars.toLocaleString()} |`);
  const emailRows = emails.map((e) =>
    `| ${e.file} | ${e.boardId} | ${e.subject} | ${e.attachments.length} | ${foreignAttachments(e).length} |`);

  writeFileSync(join(dir, 'README.md'), [
    `# Automation run output — workspace ${workspace}`,
    '',
    `${summary.ok ? 'PASS' : 'FAIL'} · ${summary.counts.pdfs} PDFs `
      + `(${summary.counts.invoices} invoices, ${summary.counts.statements} statements), `
      + `${summary.counts.emails} composed emails.`,
    '',
    `- Blank PDFs (no embedded text): **${summary.blankPdfs.length}**`,
    `- Emails carrying another board's documents: **${summary.bleedingEmails.length}**`,
    `- Page-1 previews: ${previews}`,
    '',
    '| File | Kind | Pages | Bytes | Text chars |',
    '|---|---|---:|---:|---:|',
    ...rows,
    '',
    '## Composed emails',
    '',
    '| File | Board | Subject | Attachments | From other boards |',
    '|---|---|---|---:|---:|',
    ...emailRows,
    '',
    'Text chars counts characters inside the PDF\'s text-showing operators —',
    'the check that separates a populated document from a rendered template',
    'with no values on it, which has a perfectly healthy file size.',
  ].join('\n'));
}

async function main() {
  const { workspace, out } = parseArgs(process.argv.slice(2));
  const outputRoot = join(LOCAL_S3, 'output', workspace);
  const outboxRoot = join(LOCAL_S3, 'outbox', workspace);

  const pdfs = await collectPdfs(outputRoot);
  const emails = collectEmails(outboxRoot);
  const summary = summariseRun({ pdfs, emails });

  console.log(`workspace ${workspace}: ${summary.counts.pdfs} PDFs `
    + `(${summary.counts.invoices} invoices, ${summary.counts.statements} statements), `
    + `${summary.counts.emails} emails`);
  if (summary.counts.pdfs === 0) {
    console.error('no PDFs found — did the tick run, and is AUTOMATION_ENABLED set?');
  }
  for (const file of summary.blankPdfs) console.error(`blank (no embedded text): ${file}`);
  for (const file of summary.bleedingEmails) console.error(`carries another board's documents: ${file}`);

  if (out) {
    rmSync(out, { recursive: true, force: true });
    for (const pdf of pdfs) {
      const target = join(out, 'pdfs', pdf.file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(pdf.path, target);
    }
    mkdirSync(join(out, 'emails'), { recursive: true });
    for (const email of emails) copyFileSync(email.path, join(out, 'emails', email.file));

    const previews = await renderPreviews(pdfs, join(out, 'page-1-previews'));
    writeFileSync(join(out, 'verification.json'), JSON.stringify({
      workspace, generatedAt: new Date().toISOString(), ...summary,
      pdfs: pdfs.map(({ path, ...rest }) => rest),
      emails: emails.map(({ path, ...rest }) => ({ ...rest, foreign: foreignAttachments(rest).length })),
    }, null, 2));
    writeReadme(out, { workspace, summary, pdfs, emails, previews });
    console.log(`exported to ${out} (previews: ${previews})`);
  }

  console.log(summary.ok ? 'PASS' : 'FAIL');
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
