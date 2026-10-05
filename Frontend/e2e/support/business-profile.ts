import { execFileSync } from "node:child_process";

/**
 * Business profiles for the KAN-322 spec, written straight to Mongo.
 *
 * The bad stored values (a BSB or ABN in the wrong format) are exactly what a
 * redacted production copy holds, and no page can save them, so they cannot be
 * created through the UI. Every workspace id carries the prefix below, which is
 * the only handle cleanup deletes by, so a parallel spec's rows are never touched.
 */
const DB = process.env.E2E_MONGO_DB ?? "business-dashboard";

export const KAN322_PREFIX = "e2e-kan322-";

function mongoEval(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", "isoplus-mongo", "mongosh", DB, "--quiet", "--eval", script],
    { encoding: "utf8", stdio: "pipe" },
  );
}

/** A fresh workspace id with no business profile, like a brand-new workspace. */
export function newWorkspaceId(label: string): string {
  return `${KAN322_PREFIX}${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
}

/**
 * A profile whose first document numbers are already set, so a Finance
 * Settings save asks for nothing but the fields under test.
 */
export function seedBusiness(
  workspaceId: string,
  fields: Record<string, unknown>,
): void {
  const doc = {
    workspaceId,
    name: "E2E Care",
    documentNumberingInitialized: true,
    documentNumbering: {
      invoice: { prefix: "INV-", nextNumber: 1001 },
      purchaseOrder: { prefix: "PO-", nextNumber: 101 },
      quote: { prefix: "QT-", nextNumber: 1 },
      statement: { prefix: "STM-", nextNumber: 1 },
      statementOfAccount: { prefix: "SOA-", nextNumber: 1 },
    },
    ...fields,
  };
  mongoEval(`db.businesses.insertOne(${JSON.stringify(doc)});`);
}

/** The stored profile, to assert a save left the other page's fields alone. */
export function readBusiness(workspaceId: string): Record<string, any> | null {
  const out = mongoEval(
    `JSON.stringify(db.businesses.findOne({ workspaceId: "${workspaceId}" }))`,
  ).trim();
  return out === "null" ? null : JSON.parse(out);
}

export function clearKan322Businesses(): void {
  mongoEval(
    `db.businesses.deleteMany({ workspaceId: { $regex: "^${KAN322_PREFIX}" } });`,
  );
}
