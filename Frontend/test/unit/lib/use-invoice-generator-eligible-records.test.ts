import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInvoiceGeneratorEligibleRecords } from '@/lib/use-invoice-generator-eligible-records';

/**
 * This hook is pure wiring: it forwards a large prop bag to
 * runEligibleRecordsLoad on mount and on every change to the filter/sort inputs,
 * and aborts the in-flight request on unmount. The load helper itself already
 * has its own tests, so what matters here is the wiring and the dependency
 * list — a filter dropped from the deps array means a filter change silently
 * stops refetching, which is exactly the bug these tests catch.
 */

const { runEligibleRecordsLoad } = vi.hoisted(() => ({
  runEligibleRecordsLoad: vi.fn(),
}));

vi.mock('@/lib/invoice-generator-eligible-records-helpers', () => ({
  runEligibleRecordsLoad,
}));

vi.mock('@/lib/toast-utils', () => ({
  showErrorToast: vi.fn(),
  showInfoToast: vi.fn(),
}));

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    showInvoiceModal: false,
    id: 'ws-1',
    boardId: 'b-1',
    isNdisBoard: true,
    participantFilter: 'all',
    scheduledServiceDateRange: undefined,
    serviceDeliveryDateRange: undefined,
    transactionStatusFilter: 'all',
    paymentStatusFilter: 'all',
    jobStatusFilter: 'all',
    sortBy: 'scheduledServiceDate',
    sortOrder: 'desc',
    refreshKey: 0,
    businessTimezone: 'Australia/Sydney',
    eligibleRecordsAbortControllerRef: { current: null } as { current: AbortController | null },
    isGeneratingInvoiceRef: { current: false },
    setLoadingEligible: vi.fn(),
    setEligibleRecords: vi.fn(),
    setSelectedItems: vi.fn(),
    setNdisStatusFieldLabel: vi.fn(),
    ...overrides,
  };
}

function lastCall() {
  return runEligibleRecordsLoad.mock.calls.at(-1)?.[0] as Record<string, never>;
}

beforeEach(() => {
  runEligibleRecordsLoad.mockClear();
});

describe('useInvoiceGeneratorEligibleRecords wiring', () => {
  it('loads once on mount', () => {
    renderHook((props) => useInvoiceGeneratorEligibleRecords(props as never), {
      initialProps: baseProps(),
    });

    expect(runEligibleRecordsLoad).toHaveBeenCalledTimes(1);
  });

  it('forwards the board identity into the fetch options', () => {
    renderHook((props) => useInvoiceGeneratorEligibleRecords(props as never), {
      initialProps: baseProps(),
    });

    expect(lastCall().fetchOptions).toMatchObject({
      id: 'ws-1',
      boardId: 'b-1',
      isNdisBoard: true,
      businessTimezone: 'Australia/Sydney',
    });
  });

  it('forwards every filter and the sort into the fetch options', () => {
    renderHook((props) => useInvoiceGeneratorEligibleRecords(props as never), {
      initialProps: baseProps({
        participantFilter: 'p-9',
        transactionStatusFilter: 'Delivered',
        paymentStatusFilter: 'Unpaid',
        jobStatusFilter: 'Complete',
        sortBy: 'participant',
        sortOrder: 'asc',
      }),
    });

    expect(lastCall().fetchOptions).toMatchObject({
      participantFilter: 'p-9',
      transactionStatusFilter: 'Delivered',
      paymentStatusFilter: 'Unpaid',
      jobStatusFilter: 'Complete',
      sortBy: 'participant',
      sortOrder: 'asc',
    });
  });

  it('passes the modal flag and both refs straight through', () => {
    const eligibleRecordsAbortControllerRef = { current: null };
    const isGeneratingInvoiceRef = { current: true };
    renderHook((props) => useInvoiceGeneratorEligibleRecords(props as never), {
      initialProps: baseProps({
        showInvoiceModal: true,
        eligibleRecordsAbortControllerRef,
        isGeneratingInvoiceRef,
      }),
    });

    const call = lastCall();
    expect(call.showInvoiceModal).toBe(true);
    expect(call.eligibleRecordsAbortControllerRef).toBe(eligibleRecordsAbortControllerRef);
    expect(call.isGeneratingInvoiceRef).toBe(isGeneratingInvoiceRef);
  });

  it('passes the state setters through so the helper can drive the page', () => {
    const props = baseProps();
    renderHook((p) => useInvoiceGeneratorEligibleRecords(p as never), {
      initialProps: props,
    });

    const call = lastCall();
    expect(call.setLoadingEligible).toBe(props.setLoadingEligible);
    expect(call.setEligibleRecords).toBe(props.setEligibleRecords);
    expect(call.setSelectedItems).toBe(props.setSelectedItems);
    expect(call.setNdisStatusFieldLabel).toBe(props.setNdisStatusFieldLabel);
  });

  it('supplies the toast helpers', () => {
    renderHook((props) => useInvoiceGeneratorEligibleRecords(props as never), {
      initialProps: baseProps(),
    });

    const call = lastCall();
    expect(typeof call.showInfoToast).toBe('function');
    expect(typeof call.showErrorToast).toBe('function');
  });
});

describe('useInvoiceGeneratorEligibleRecords refetching', () => {
  it('does not reload when nothing changed', () => {
    const props = baseProps();
    const { rerender } = renderHook(
      (p) => useInvoiceGeneratorEligibleRecords(p as never),
      { initialProps: props },
    );

    rerender(props);

    expect(runEligibleRecordsLoad).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['participantFilter', 'p-9'],
    ['transactionStatusFilter', 'Delivered'],
    ['paymentStatusFilter', 'Unpaid'],
    ['jobStatusFilter', 'Complete'],
    ['sortBy', 'participant'],
    ['sortOrder', 'asc'],
    ['boardId', 'b-2'],
    ['id', 'ws-2'],
    ['businessTimezone', 'Australia/Perth'],
  ])('reloads when %s changes', (key, value) => {
    const props = baseProps();
    const { rerender } = renderHook(
      (p) => useInvoiceGeneratorEligibleRecords(p as never),
      { initialProps: props },
    );

    rerender({ ...props, [key]: value });

    expect(runEligibleRecordsLoad).toHaveBeenCalledTimes(2);
    expect(lastCall().fetchOptions).toMatchObject({ [key]: value });
  });

  it('reloads when the NDIS board flag flips', () => {
    const props = baseProps();
    const { rerender } = renderHook(
      (p) => useInvoiceGeneratorEligibleRecords(p as never),
      { initialProps: props },
    );

    rerender({ ...props, isNdisBoard: false });

    expect(runEligibleRecordsLoad).toHaveBeenCalledTimes(2);
    expect(lastCall().fetchOptions.isNdisBoard).toBe(false);
  });

  it('reloads when the refresh key is bumped, even with identical filters', () => {
    const props = baseProps();
    const { rerender } = renderHook(
      (p) => useInvoiceGeneratorEligibleRecords(p as never),
      { initialProps: props },
    );

    rerender({ ...props, refreshKey: 1 });

    expect(runEligibleRecordsLoad).toHaveBeenCalledTimes(2);
  });

  it('reloads when the invoice modal opens or closes', () => {
    const props = baseProps();
    const { rerender } = renderHook(
      (p) => useInvoiceGeneratorEligibleRecords(p as never),
      { initialProps: props },
    );

    rerender({ ...props, showInvoiceModal: true });

    expect(runEligibleRecordsLoad).toHaveBeenCalledTimes(2);
    expect(lastCall().showInvoiceModal).toBe(true);
  });

  it('reloads when a date range is applied', () => {
    const props = baseProps();
    const { rerender } = renderHook(
      (p) => useInvoiceGeneratorEligibleRecords(p as never),
      { initialProps: props },
    );

    const scheduledServiceDateRange = { from: new Date(2026, 7, 1), to: new Date(2026, 7, 31) };
    rerender({ ...props, scheduledServiceDateRange });

    expect(runEligibleRecordsLoad).toHaveBeenCalledTimes(2);
    expect(lastCall().fetchOptions.scheduledServiceDateRange).toBe(scheduledServiceDateRange);
  });
});

describe('useInvoiceGeneratorEligibleRecords cleanup', () => {
  it('aborts the in-flight request on unmount', () => {
    const controller = new AbortController();
    const abort = vi.spyOn(controller, 'abort');
    const { unmount } = renderHook(
      (p) => useInvoiceGeneratorEligibleRecords(p as never),
      { initialProps: baseProps({ eligibleRecordsAbortControllerRef: { current: controller } }) },
    );

    unmount();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('aborts the previous request before reloading', () => {
    const controller = new AbortController();
    const abort = vi.spyOn(controller, 'abort');
    const props = baseProps({ eligibleRecordsAbortControllerRef: { current: controller } });
    const { rerender } = renderHook(
      (p) => useInvoiceGeneratorEligibleRecords(p as never),
      { initialProps: props },
    );

    rerender({ ...props, participantFilter: 'p-9' });

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('does not throw on unmount when no request is in flight', () => {
    const { unmount } = renderHook(
      (p) => useInvoiceGeneratorEligibleRecords(p as never),
      { initialProps: baseProps({ eligibleRecordsAbortControllerRef: { current: null } }) },
    );

    expect(() => unmount()).not.toThrow();
  });
});
