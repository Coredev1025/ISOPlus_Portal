export function mapBusinessProfileToFormData(data: Record<string, any>, workspaceId: string) {
  return {
    name: data.name || '',
    phone: data.phone || '',
    email: data.email || '',
    companyRegistrationId: data.companyRegistrationId || '',
    street: data.address?.street || '',
    country: data.address?.country || '',
    suburb: data.address?.suburb || '',
    state: data.address?.state || '',
    postcode: data.address?.postcode || '',
    abn: data.abn || '',
    acn: data.acn || '',
    workspaceId,
    bankAccountName: data.bankDetails?.accountName || '',
    bankName: data.bankDetails?.bankName || '',
    bsb: data.bankDetails?.bsb || '',
    accountNumber: data.bankDetails?.accountNumber || '',
    paymentReference: data.bankDetails?.paymentReference || '',
    accountsReceivableTerms: data.bankDetails?.accountsReceivableTerms || '',
    accountsPayableTerms: data.bankDetails?.accountsPayableTerms || '',
    headOfficeTimezone: (data.headOfficeTimezone as string) || 'Australia/Sydney',
  };
}

export function extractDocumentNumberingSequences(data: Record<string, any>) {
  const numbering = data.documentNumbering;
  if (!numbering) {
    return { invoice: null, purchaseOrder: null, quote: null };
  }
  return {
    invoice: numbering.invoice || null,
    purchaseOrder: numbering.purchaseOrder || null,
    quote: numbering.quote || null,
  };
}
