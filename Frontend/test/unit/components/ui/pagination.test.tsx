import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';

function renderPagination(handlers: Record<string, () => void> = {}) {
  return render(
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href="#page-1" onClick={handlers.onPrevious} />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#page-1">1</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#page-2" isActive>
            2
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationEllipsis />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#page-9">9</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#page-3" onClick={handlers.onNext} />
        </PaginationItem>
      </PaginationContent>
    </Pagination>,
  );
}

describe('Pagination', () => {
  it('renders a navigation landmark named pagination', () => {
    renderPagination();

    expect(screen.getByRole('navigation', { name: 'pagination' })).toBeInTheDocument();
  });

  it('renders the controls as a list, one item each', () => {
    renderPagination();

    const nav = screen.getByRole('navigation', { name: 'pagination' });
    const list = within(nav).getByRole('list');

    expect(list.tagName).toBe('UL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  });

  it('gives previous and next an accessible name', () => {
    renderPagination();

    expect(screen.getByRole('link', { name: 'Go to previous page' })).toHaveAttribute(
      'href',
      '#page-1',
    );
    expect(screen.getByRole('link', { name: 'Go to next page' })).toHaveAttribute(
      'href',
      '#page-3',
    );
  });

  it('shows visible Previous and Next labels beside the chevrons', () => {
    renderPagination();

    expect(screen.getByRole('link', { name: 'Go to previous page' })).toHaveTextContent(
      'Previous',
    );
    expect(screen.getByRole('link', { name: 'Go to next page' })).toHaveTextContent('Next');
  });

  it('marks only the active page with aria-current', () => {
    renderPagination();

    expect(screen.getByRole('link', { current: 'page' })).toHaveTextContent('2');
    expect(screen.getByRole('link', { name: '1' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: '9' })).not.toHaveAttribute('aria-current');
  });

  it('styles the active page as outlined and the rest as ghost', () => {
    renderPagination();

    const active = screen.getByRole('link', { current: 'page' });
    const inactive = screen.getByRole('link', { name: '1' });

    expect(active.className.split(/\s+/)).toContain('border-input');
    expect(inactive.className.split(/\s+/)).not.toContain('border-input');
  });

  it('hides the ellipsis and its label from assistive technology', () => {
    renderPagination();

    expect(screen.getByText('More pages').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('link', { name: /more pages/i })).not.toBeInTheDocument();
  });

  it('calls the handler when the user activates next', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    renderPagination({ onNext });

    await user.click(screen.getByRole('link', { name: 'Go to next page' }));

    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('calls the handler when the user activates previous', async () => {
    const user = userEvent.setup();
    const onPrevious = vi.fn();
    renderPagination({ onPrevious });

    await user.click(screen.getByRole('link', { name: 'Go to previous page' }));

    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('does not expose a link when the caller omits an href', () => {
    // Characterizes a real trap: PaginationLink renders a bare <a>, which has no
    // implicit link role without an href, so an hrefless page number is invisible
    // to assistive technology even though it is styled as a button.
    render(
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationLink>4</PaginationLink>
          </PaginationItem>
        </PaginationContent>
      </Pagination>,
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('4').tagName).toBe('A');
  });

  it('keeps a caller class on the navigation', () => {
    render(<Pagination className="mt-6" />);

    expect(
      screen.getByRole('navigation', { name: 'pagination' }).className.split(/\s+/),
    ).toContain('mt-6');
  });
});
