import path from 'path';
import { deleteFileFromS3, uploadFileToS3 } from './uploadS3.js';
import { setLogo } from '../services/isoplus.js';

const LOGO_UPLOADS = [
  { field: 'defaultLogo', pathPrefix: 'default-logo', syncToIsoplus: null },
  { field: 'squareLogo', pathPrefix: 'square-logo', syncToIsoplus: 'form' },
  { field: 'wideLogo', pathPrefix: 'wide-logo', syncToIsoplus: 'document' },
];

async function uploadLogoFile({ workspaceId, business, field, file, pathPrefix, syncToIsoplus, authorization, req }) {
  if (business?.[field]) {
    await deleteFileFromS3(business[field], false);
  }

  const logoPath = `logos/${workspaceId}/${pathPrefix}${path.extname(file.originalname)}`;
  await uploadFileToS3(file.buffer, logoPath, false);

  if (syncToIsoplus) {
    setLogo(authorization, workspaceId, file, syncToIsoplus, req);
  }

  return logoPath;
}

async function removeLogoField(business, field) {
  if (!business?.[field]) return false;
  await deleteFileFromS3(business[field], false);
  return true;
}

export async function applyBusinessLogoUpdates({
  workspaceId,
  business,
  files,
  removals,
  authorization,
  req,
}) {
  const updateData = {};

  for (const { field, pathPrefix, syncToIsoplus } of LOGO_UPLOADS) {
    const uploaded = files?.[field]?.[0];
    if (uploaded) {
      updateData[field] = await uploadLogoFile({
        workspaceId,
        business,
        field,
        file: uploaded,
        pathPrefix,
        syncToIsoplus,
        authorization,
        req,
      });
      continue;
    }

    if (removals[field]) {
      const removed = await removeLogoField(business, field);
      if (removed) updateData[field] = null;
    }
  }

  return updateData;
}

/**
 * Shallow-merge numbering series so a PUT that omits a series (e.g. older
 * Configure Business / Financial Settings clients without statementOfAccount)
 * cannot reset that series to the schema default of 1.
 */
export function mergeDocumentNumbering(existing, incoming = {}) {
  if (!existing || typeof existing !== 'object') {
    return { ...incoming };
  }
  const plain =
    typeof existing.toObject === 'function' ? existing.toObject() : existing;
  return { ...plain, ...incoming };
}

/** Drop undefined entries so findByIdAndUpdate does not persist empty nests as {}. */
function omitUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  );
}

function nestedUpdate(fields) {
  const defined = omitUndefined(fields);
  return Object.keys(defined).length > 0 ? defined : undefined;
}

export function buildBusinessUpdateData(body) {
  const {
    name,
    phone,
    email,
    abn,
    acn,
    companyRegistrationId,
    state,
    suburb,
    country,
    postcode,
    street,
    bankAccountName,
    bankName,
    bsb,
    accountNumber,
    paymentReference,
    accountsReceivableTerms,
    accountsPayableTerms,
    headOfficeTimezone,
    workspaceId,
    documentNumbering,
  } = body;

  return omitUndefined({
    name,
    address: nestedUpdate({ street, country, suburb, state, postcode }),
    phone,
    email,
    abn,
    acn,
    companyRegistrationId,
    workspaceId,
    bankDetails: nestedUpdate({
      accountName: bankAccountName,
      bankName,
      bsb,
      accountNumber,
      paymentReference,
      accountsReceivableTerms,
      accountsPayableTerms,
    }),
    documentNumbering,
    headOfficeTimezone: headOfficeTimezone || 'Australia/Sydney',
  });
}

export function parseLogoRemovals(body) {
  const parseBoolean = (value) => value === true || value === 'true';
  return {
    defaultLogo: parseBoolean(body.defaultLogoRemoved),
    squareLogo: parseBoolean(body.squareLogoRemoved),
    wideLogo: parseBoolean(body.wideLogoRemoved),
  };
}
