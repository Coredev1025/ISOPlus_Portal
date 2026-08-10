import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaginationControls } from '@/lib/pagination-controls';

// The component renders anchors with no href, so they carry no `link` role.
// Reading them off the pagination nav in document order is what a user sees.
function renderControls(props: {
  currentPage: number;
  totalPages: number;
  onPageChange?: (page: number) => void;
  className?: string;
}) {
  const onPageChange = props.onPageChange ?? vi.fn();
  const view = render(
    <PaginationControls
      currentPage={props.currentPage}
      totalPages={props.totalPages}
      onPageChange={onPageChange}
      className={props.className}
    />
  );
  return { ...view, onPageChange };
}

function anchorTexts(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('nav[aria-label="pagination"] a')
  ).map((a) => (a.textContent ?? '').trim());
}

function ellipsisCount(container: HTMLElement): number {
  return container.querySelectorAll('span[aria-hidden]').length;
}

describe('PaginationControls', () => {
  it('renders nothing at all when there are no pages', () => {
    const { container, onPageChange } = renderControls({ currentPage: 1, totalPages: 0 });

    expect(container).toBeEmptyDOMElement();
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('renders nothing when totalPages is negative', () => {
    const { container } = renderControls({ currentPage: 1, totalPages: -3 });

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the single page with both arrows disabled when there is exactly one page', () => {
    const { container } = renderControls({ currentPage: 1, totalPages: 1 });

    expect(anchorTexts(container)).toEqual(['Previous', '1', 'Next']);
    expect(ellipsisCount(container)).toBe(0);
    expect(screen.getByLabelText('Go to previous page')).toHaveClass(
      'pointer-events-none',
      'opacity-50'
    );
    expect(screen.getByLabelText('Go to next page')).toHaveClass(
      'pointer-events-none',
      'opacity-50'
    );
  });

  it('lists every page without an ellipsis while all pages stay in the window', () => {
    const { container } = renderControls({ currentPage: 1, totalPages: 3 });

    expect(anchorTexts(container)).toEqual(['Previous', '1', '2', '3', 'Next']);
    expect(ellipsisCount(container)).toBe(0);
  });

  it('marks only the current page as the active page', () => {
    const { container } = renderControls({ currentPage: 2, totalPages: 3 });

    const nav = container.querySelector('nav[aria-label="pagination"]') as HTMLElement;
    expect(within(nav).getByText('2').closest('a')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByText('1').closest('a')).not.toHaveAttribute('aria-current');
    expect(within(nav).getByText('3').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('collapses both ends into ellipses around a middle page', () => {
    const { container } = renderControls({ currentPage: 5, totalPages: 10 });

    expect(anchorTexts(container)).toEqual([
      'Previous',
      '1',
      '4',
      '5',
      '6',
      '10',
      'Next',
    ]);
    expect(ellipsisCount(container)).toBe(2);
    expect(screen.getAllByText('More pages')).toHaveLength(2);
  });

  it('omits the leading ellipsis when the window already touches page one', () => {
    const { container } = renderControls({ currentPage: 2, totalPages: 10 });

    expect(anchorTexts(container)).toEqual(['Previous', '1', '2', '3', '10', 'Next']);
    expect(ellipsisCount(container)).toBe(1);
  });

  it('omits the trailing ellipsis when the window already touches the last page', () => {
    const { container } = renderControls({ currentPage: 9, totalPages: 10 });

    expect(anchorTexts(container)).toEqual(['Previous', '1', '8', '9', '10', 'Next']);
    expect(ellipsisCount(container)).toBe(1);
  });

  it('enables previous and disables next on the last page', () => {
    const { container } = renderControls({ currentPage: 10, totalPages: 10 });

    expect(anchorTexts(container)).toEqual(['Previous', '1', '9', '10', 'Next']);
    const previous = screen.getByLabelText('Go to previous page');
    const next = screen.getByLabelText('Go to next page');
    expect(previous).toHaveClass('cursor-pointer');
    expect(previous).not.toHaveClass('pointer-events-none');
    expect(next).toHaveClass('pointer-events-none', 'opacity-50');
  });

  it('reports the clicked page number', async () => {
    const user = userEvent.setup();
    const { container, onPageChange } = renderControls({ currentPage: 5, totalPages: 10 });

    const nav = container.querySelector('nav[aria-label="pagination"]') as HTMLElement;
    await user.click(within(nav).getByText('10'));

    expect(onPageChange).toHaveBeenCalledTimes(1);
    expect(onPageChange).toHaveBeenCalledWith(10);
  });

  it('steps one page forward from next and one page back from previous', async () => {
    const user = userEvent.setup();
    const { onPageChange } = renderControls({ currentPage: 5, totalPages: 10 });

    await user.click(screen.getByLabelText('Go to next page'));
    await user.click(screen.getByLabelText('Go to previous page'));

    expect(onPageChange.mock.calls).toEqual([[6], [4]]);
  });

  // The disabled styling is CSS-only, so in jsdom the handler still runs; the
  // clamp inside it is what keeps the page number in range.
  it('clamps previous to page one on the first page', async () => {
    const user = userEvent.setup();
    const { onPageChange } = renderControls({ currentPage: 1, totalPages: 10 });

    await user.click(screen.getByLabelText('Go to previous page'));

    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('clamps next to the last page on the last page', async () => {
    const user = userEvent.setup();
    const { onPageChange } = renderControls({ currentPage: 10, totalPages: 10 });

    await user.click(screen.getByLabelText('Go to next page'));

    expect(onPageChange).toHaveBeenCalledWith(10);
  });

  it('puts the caller className on the wrapper around the pagination nav', () => {
    const { container } = renderControls({
      currentPage: 1,
      totalPages: 2,
      className: 'mt-4 flex justify-center',
    });

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper).toHaveClass('mt-4', 'flex', 'justify-center');
    expect(wrapper.querySelector('nav[aria-label="pagination"]')).not.toBeNull();
  });
});
