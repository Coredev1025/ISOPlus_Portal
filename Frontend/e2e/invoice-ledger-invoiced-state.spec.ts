import { execFileSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "@playwright/test";

import { signInSupportAdmin } from "./helpers/support-auth";

/**
 * KAN-314 — items already invoiced read as invoiced in the Invoice Generator.
 *
 * Seeded by Backend/test/fixtures/care-management-55390-full.json, which marks
 * items as invoiced (INV-1002 on SaH, INV-1003 on NDIS) through every identity store (the item
 * marker log, the pdf link and the ledger `invoices` row). The assertions hold
 * whichever way INVOICE_LEDGER_READ is set (off, shadow or on): the two readers
 * must agree on what the user sees. The table's row highlight is not driven here:
 * the NDIS board renders from a different list that needs live ISO+ budget data.
 *
 * Run it once per mode, restarting the backend with the flag changed; docs/release-runbook.md "Notes for switching the readers".
 */
const WORKSPACE = process.env.E2E_CM_WORKSPACE_ID ?? "55390";
// The NDIS Certification board: its rows pass the timesheet-approval gate, so
// the invoiced one is listed. (The SaH board's INV-1002 items are not approved
// in the fixture and never appear in the list.)
const BOARD = "o24sGM1FoST";
const INVOICE = "INV-1003";
const INVOICED_ITEMS = ["41fdecfd-7949-48bd-b1b1-2b37102a3913"];

const BACKEND =
  process.env.E2E_BACKEND_URL ??
  process.env.NEXT_PUBLIC_BACKEND_URL ??
  "http://localhost:4001";

test.beforeEach(() => {
  // Idempotent. Sets the invoiced state the tests read, so they do not depend
  // on what an earlier spec left behind.
  execFileSync(
    "node",
    ["scripts/dev.mjs", "fixture", "--file", "test/fixtures/care-management-55390-full.json"],
    { cwd: path.resolve(__dirname, "..", ".."), stdio: "pipe" },
  );
});

test("already-invoiced items read as invoiced in the list and the pdf-link lookup", async ({ page }) => {
  await signInSupportAdmin(page);

  // The list endpoint carries the invoice number for every seeded item.
  const res = await page.request.get(
    `${BACKEND}/api/items/${WORKSPACE}/${BOARD}/invoice-generator?page=1&limit=500`,
  );
  expect(res.ok(), `list failed (${res.status()})`).toBeTruthy();
  const rows: Array<{ id: string; invoiceNumber?: string }> = (await res.json()).items ?? [];
  for (const id of INVOICED_ITEMS) {
    const row = rows.find((r) => r.id === id);
    expect(row, `row ${id} should be listed`).toBeTruthy();
    expect(row?.invoiceNumber ?? "", `invoiceNumber of ${id}`).toContain(INVOICE);
  }

  // The pdf-link lookup resolves the plain number and the number with its suffix.
  for (const number of [INVOICE, `${INVOICE} (ISO+™)`]) {
    const link = await page.request.get(
      `${BACKEND}/api/items/${WORKSPACE}/${BOARD}/invoice/${encodeURIComponent(number)}/pdf-link`,
    );
    expect(link.ok(), `pdf-link for ${number} (${link.status()})`).toBeTruthy();
    expect((await link.json()).pdfLink, `pdfLink for ${number}`).toContain(INVOICE);
  }
});
