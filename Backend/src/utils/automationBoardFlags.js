import {
  CARE_MANAGEMENT_PREFIX,
  LOW_CAT_BOARD_LABEL,
} from '../constants/automation.js';

export function isNdisBoardLabel(label) {
  return typeof label === 'string' && label.toLowerCase().includes('ndis');
}

export function isCareManagementLabel(label) {
  return typeof label === 'string' && label.startsWith(CARE_MANAGEMENT_PREFIX);
}

export function isLowCatCareManagementLabel(label) {
  return label === LOW_CAT_BOARD_LABEL;
}

export function canGenerateMonthlyStatement(label) {
  return isCareManagementLabel(label) && !isLowCatCareManagementLabel(label);
}
