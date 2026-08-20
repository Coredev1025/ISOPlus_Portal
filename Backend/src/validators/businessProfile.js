import { EMAIL_PATTERN } from '../constants/validation.js';

const DOC_NUMBERING_TYPES = ['invoice', 'purchaseOrder', 'quote', 'statement'];

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

function validateIdentityFields(body, errors) {
  if (!body.name || body.name.length > 100) {
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

export function collectBusinessProfileErrors(body) {
  const errors = [];
  validateIdentityFields(body, errors);
  validateAddressFields(body, errors);
  validateRegistrationFields(body, errors);
  validateBankFields(body, errors);
  if (!body.documentNumbering) return errors;

  try {
    validateDocumentNumbering(JSON.parse(body.documentNumbering), errors);
  } catch {
    errors.push('Invalid document numbering format');
  }

  return errors;
}
