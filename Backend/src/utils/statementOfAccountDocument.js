/**
 * Assembling the statement of account's non-ledger blocks.
 *
 * Section 4.2 of the invoice selection spec: header, recipient, meta and
 * payment block. The ledger and ageing arrive already settled from
 * statementLedger.js; this file only decides where each printed string comes
 * from, so the renderer takes one object and the service that fetches the data
 * does no formatting.
 *
 * Nothing here throws. A statement with a blank address line is a cosmetic
 * problem the client can fix on the profile; refusing to state the account
 * because a postcode is missing is not.
 */

import { REF_ATTRIBUTE_NAMES } from '../constants/monthlyStatementAttributes.js';

const str = (value) => String(value ?? '').trim();

/** The non-empty parts, comma-joined — so a missing suburb does not print ", ,". */
const joinParts = (parts) => parts.map(str).filter(Boolean).join(', ');

function businessAddress(business) {
  const a = business?.address ?? {};
  const locality = [str(a.state), str(a.postcode)].filter(Boolean).join(' ');
  return joinParts([a.street, a.suburb, locality, a.country]);
}

/**
 * The participant's address, from whichever of the two postcode spellings the
 * board uses. Both appear in REF_ATTRIBUTE_NAMES because both appear in real
 * ISO+ workspaces.
 */
function profileAddress(profile) {
  const data = profile?.data ?? {};
  const read = (name) => str(data[name]);
  const postcode = read(REF_ATTRIBUTE_NAMES.PROFILE_POSTCODE)
    || read(REF_ATTRIBUTE_NAMES.PROFILE_POST_CODE);
  const locality = [read(REF_ATTRIBUTE_NAMES.PROFILE_STATE), postcode].filter(Boolean).join(' ');
  return joinParts([
    read(REF_ATTRIBUTE_NAMES.PROFILE_ADDRESS),
    read(REF_ATTRIBUTE_NAMES.PROFILE_SUBURB),
    locality,
  ]);
}

/**
 * The statement, in the shape `renderStatementOfAccountPdf` takes.
 *
 * The account reference is the participant's name rather than an id: it is
 * what the client recognises, and it is the same handle the invoice and the
 * email already use. The payment reference is the statement number, so a
 * transfer can be matched back to the document that prompted it.
 *
 * `logo` arrives already resolved — a data URI, not the S3 key stored on the
 * business — because this module is pure by design and reading the image is
 * I/O. The service that already loads the business does that read.
 */
export function buildStatementDocument({
  business, profile, participant, statementNumber, period, ledger, ageing, logo,
}) {
  const bank = business?.bankDetails ?? {};
  return {
    provider: {
      name: str(business?.name),
      abn: str(business?.abn),
      address: businessAddress(business),
      logo: str(logo),
    },
    recipient: {
      name: str(participant),
      address: profileAddress(profile),
    },
    meta: {
      statementNumber: str(statementNumber),
      statementDate: period.end,
      periodStart: period.start,
      periodEnd: period.end,
      accountNumber: str(participant),
    },
    ledger,
    ageing,
    bank: {
      accountName: str(bank.accountName),
      bankName: str(bank.bankName),
      bsb: str(bank.bsb),
      accountNumber: str(bank.accountNumber),
      reference: str(statementNumber),
    },
  };
}
