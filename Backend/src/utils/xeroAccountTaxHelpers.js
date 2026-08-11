import { getAccounts, getTaxRates, isAccountTaxRateMatched } from '../services/xero.js';
import { setIntegrationMessage } from '../services/isoplus.js';

export const ACCOUNT_TAX_MISMATCH_MESSAGE =
  'Account code and Tax rate is not matched, please update them in ISO+ portal';

export const ACCOUNT_TAX_MISMATCH_RESPONSE = {
  message: 'Account code and Tax rate is not matched',
};

/** Serialised chart load — avoids concurrent refresh-token races on xeroClient. */
export async function loadXeroChartOptions(workspaceId) {
  const accounts = await getAccounts(workspaceId);
  const taxRates = await getTaxRates(workspaceId);
  return { accounts, taxRates };
}

export async function rejectIfAccountTaxMismatch({
  workspaceId,
  boardId,
  itemId,
  accountCode,
  taxType,
  res,
  chart,
}) {
  if (!accountCode) {
    if (itemId) {
      await setIntegrationMessage(
        workspaceId,
        boardId,
        itemId,
        'Account code is required. Configure account mapping in Finance Settings.',
      );
    }
    res.status(200).json({
      message: 'Account code is required. Configure account mapping in Finance Settings.',
    });
    return true;
  }

  const matched = await isAccountTaxRateMatched(
    workspaceId,
    accountCode,
    taxType,
    chart,
  );
  if (matched) return null;

  if (itemId) {
    await setIntegrationMessage(workspaceId, boardId, itemId, ACCOUNT_TAX_MISMATCH_MESSAGE);
  }
  res.status(200).json(ACCOUNT_TAX_MISMATCH_RESPONSE);
  return true;
}
