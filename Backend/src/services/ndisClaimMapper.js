import { info } from '../utils/logger.js';

function toDdMmYyyy(dateString) {
    if (!dateString) return '';
    const d = new Date(dateString);
    if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = String(d.getFullYear());
        return `${day}/${month}/${year}`;
    }

    try {
        const parts = String(dateString).split(/[-T ]/);
        if (parts.length >= 3) {
            return `${parts[2].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[0]}`;
        }
    } catch {
        // ignore parse errors and fall through
    }
    return '';
}

function formatHoursToHhhMm(hours) {
    const numeric = Number(hours);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';

    const totalMinutes = Math.round(numeric * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const hoursPart = String(h);
    const minutesPart = String(m).padStart(2, '0');
    return `${hoursPart}:${minutesPart}`;
}

function mapCancellationReason(rawReason) {
    if (!rawReason) return '';
    const value = String(rawReason).toLowerCase();

    if (value.includes('health')) return 'NSDH';
    if (value.includes('family')) return 'NSDF';
    if (value.includes('transport')) return 'NSDT';
    return 'NSDO';
}

export function mapNdisClaimFields({
    unit,
    quantity,
    unitPrice,
    totalAmount,
    govSubsidy,
    participantContribution,
    serviceIdentifier,
    invoiceNumber,
    jobStatus,
    scheduledServiceDate,
    serviceDeliveryDate,
    actualShiftDurationHours,
    labourTravelMinutes,
    nonFaceToFaceHours,
    cancellationReasonRaw,
    gstLabelRaw
}) {
    const normalizedUnit = typeof unit === 'string' ? unit.toLowerCase() : '';
    const isHourUnit = normalizedUnit.includes('hour(') || normalizedUnit === 'h' || normalizedUnit === 'hour';

    let claimQuantity = null;
    let claimHours = '';

    if (isHourUnit) {
        const hoursFromDuration = formatHoursToHhhMm(actualShiftDurationHours);
        if (hoursFromDuration) {
            claimHours = hoursFromDuration;
        } else if (labourTravelMinutes && Number(labourTravelMinutes) > 0) {
            const hoursFromMinutes = formatHoursToHhhMm(Number(labourTravelMinutes) / 60);
            claimHours = hoursFromMinutes;
        } else if (nonFaceToFaceHours && Number(nonFaceToFaceHours) > 0) {
            claimHours = formatHoursToHhhMm(nonFaceToFaceHours);
        }
    }

    if (!claimHours) {
        const numericQty = Number(quantity);
        claimQuantity = Number.isFinite(numericQty) && numericQty !== 0 ? numericQty : null;
    }

    const gstLabel = (gstLabelRaw || '').toString().toLowerCase();
    let gstCode = 'P2';
    if (gstLabel.includes('10%') || gstLabel.includes('tax') || gstLabel.includes('gst')) {
        gstCode = 'P1';
    } else if (gstLabel.includes('out of scope')) {
        gstCode = 'P5';
    }

    const jobStatusValue = (jobStatus || '').toString().toLowerCase();
    let claimType = '';
    if (jobStatusValue.includes('cancel')) {
        claimType = 'CANC';
    }

    const hasNonZeroTotal =
        Math.abs(Number(totalAmount) || 0) > 0 ||
        Math.abs(Number(govSubsidy) || 0) > 0 ||
        Math.abs(Number(participantContribution) || 0) > 0;

    if (!hasNonZeroTotal) {
        info('NDIS-Claim-Mapper', 'Skipping NDIS claim mapping for zero-value item', {
            invoiceNumber,
            serviceIdentifier
        });
    }

    const supportDeliveredDate = serviceDeliveryDate || scheduledServiceDate || null;
    const supportDeliveredFrom = toDdMmYyyy(supportDeliveredDate);
    const supportDeliveredTo = toDdMmYyyy(supportDeliveredDate);

    const cancellationReason =
        claimType === 'CANC' ? mapCancellationReason(cancellationReasonRaw) : '';

    return {
        supportDeliveredFrom,
        supportDeliveredTo,
        supportNumber: serviceIdentifier || '',
        claimReference: invoiceNumber || '',
        ndisQuantity: claimQuantity,
        ndisHours: claimHours,
        ndisUnitPrice: unitPrice,
        ndisGstCode: gstCode,
        ndisClaimType: claimType,
        ndisCancellationReason: cancellationReason
    };
}

