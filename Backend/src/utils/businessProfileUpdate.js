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
  if (!business?.[field]) return null;
  await deleteFileFromS3(business[field], false);
  return null;
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
      updateData[field] = await removeLogoField(business, field);
    }
  }

  return updateData;
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

  return {
    name,
    address: { street, country, suburb, state, postcode },
    phone,
    email,
    abn,
    acn,
    companyRegistrationId,
    workspaceId,
    bankDetails: {
      accountName: bankAccountName,
      bankName,
      bsb,
      accountNumber,
      paymentReference,
      accountsReceivableTerms,
      accountsPayableTerms,
    },
    documentNumbering,
    headOfficeTimezone: headOfficeTimezone || 'Australia/Sydney',
  };
}

export function parseLogoRemovals(body) {
  const parseBoolean = (value) => value === true || value === 'true';
  return {
    defaultLogo: parseBoolean(body.defaultLogoRemoved),
    squareLogo: parseBoolean(body.squareLogoRemoved),
    wideLogo: parseBoolean(body.wideLogoRemoved),
  };
}
