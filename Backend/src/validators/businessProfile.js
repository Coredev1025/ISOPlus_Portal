import { BUSINESS_PROFILE_SECTION } from '../constants/businessProfile.js';
import { EMAIL_PATTERN } from '../constants/validation.js';
import {
  hasAllInitialNumbers,
  wantsInitialNumbers,
} from '../utils/documentNumberingInitial.js';

const DOC_NUMBERING_TYPES = [
  'invoice',
  'purchaseOrder',
  'quote',
  'statement',
  'statementOfAccount',
];

function validateSequenceFields(type, sequence, errors) {
  const prefix = sequence.prefix;
  if (typeof prefix !== 'string' || prefix.length > 10) {
    errors.push(`${type} prefix must be a string less than 10 characters`);
  }
  const nextNumber = sequence.nextNumber;
  if (!Number.isInteger(nextNumber) || nextNumber < 0) {
    errors.push(`${type} number must be a non-negative integer`);
  }
}

function validateDocumentNumbering(numbering, errors) {
  DOC_NUMBERING_TYPES.forEach((type) => {
    if (!numbering[type]) return;
    validateSequenceFields(type, numbering[type], errors);
  });
}

// KAN-292: the first save of Finance Settings must give every document type a
// first number, so none is left to a default the user never saw.
function validateInitialNumbers(body, numbering, errors) {
  if (wantsInitialNumbers(body) && !hasAllInitialNumbers(numbering)) {
    errors.push('Enter a starting number of 1 or more for every document type');
  }
}

function validateIdentityFields(body, errors, requireName) {
  if (requireName ? (!body.name || body.name.length > 100) : (body.name && body.name.length > 100)) {
    errors.push('Business name is required and must be less than 100 characters');
  }
  if (body.phone && !/^\+?[\d\s-]{8,20}$/.test(body.phone)) {
    errors.push('Invalid phone number format');
  }
  if (body.email && !EMAIL_PATTERN.test(body.email)) {
    errors.push('Invalid email format');
  }
}

function validateAddressFields(body, errors) {
  if (body.street && body.street.length > 200) {
    errors.push('Street address must be less than 200 characters');
  }
  if (body.postcode && !/^\d{4,10}$/.test(body.postcode)) {
    errors.push('Invalid postcode format');
  }
}

function validateRegistrationFields(body, errors) {
  if (body.abn && !/^\d{11}$/.test(body.abn)) {
    errors.push('ABN must be exactly 11 digits');
  }
  if (body.acn && !/^\d{9}$/.test(body.acn)) {
    errors.push('ACN must be exactly 9 digits');
  }
}

function validateBankFields(body, errors) {
  if (body.bsb && !/^\d{6}$/.test(body.bsb)) {
    errors.push('BSB must be exactly 6 digits');
  }
  if (body.accountNumber && !/^\d{6,10}$/.test(body.accountNumber)) {
    errors.push('Account number must be between 6 and 10 digits');
  }
  if (body.bankAccountName && body.bankAccountName.length > 100) {
    errors.push('Bank account name must be less than 100 characters');
  }
}

// Business Configuration owns identity, address and registration (the logos are
// files, not validated here). The business name is required on this page only.
export function collectBusinessConfigurationErrors(body, { requireName = true } = {}) {
  const errors = [];
  validateIdentityFields(body, errors, requireName);
  validateAddressFields(body, errors);
  validateRegistrationFields(body, errors);
  return errors;
}

// Finance Settings owns bank details, payment terms and document numbering.
export function collectFinanceSettingsErrors(body) {
  const errors = [];
  validateBankFields(body, errors);
  if (!body.documentNumbering) {
    if (wantsInitialNumbers(body)) validateInitialNumbers(body, {}, errors);
    return errors;
  }

  try {
    const numbering = JSON.parse(body.documentNumbering);
    validateDocumentNumbering(numbering, errors);
    validateInitialNumbers(body, numbering, errors);
  } catch {
    errors.push('Invalid document numbering format');
  }

  return errors;
}

// Every format rule runs on every field that is present, whichever page the
// request names: the route writes whatever the body carries, so a field must never
// be stored without being checked. Each page sends only the fields it owns, so
// this cannot block a page on the other page's stored values. The `section` only
// decides whether the business name is required: a Finance Settings save does not
// need one (a new workspace can start from either page), every other request does.
export function collectBusinessProfileErrors(body) {
  const requireName = body.section !== BUSINESS_PROFILE_SECTION.FINANCE;
  return [
    ...collectBusinessConfigurationErrors(body, { requireName }),
    ...collectFinanceSettingsErrors(body),
  ];
}
