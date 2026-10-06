import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from '@/components/ui/breadcrumb';

function renderBreadcrumb() {
  return render(
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="/workspaces">Workspaces</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink href="/workspaces/12/boards">Boards</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Invoice generator</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>,
  );
}

describe('Breadcrumb', () => {
  it('renders a navigation landmark named breadcrumb', () => {
    renderBreadcrumb();

    expect(screen.getByRole('navigation', { name: 'breadcrumb' })).toBeInTheDocument();
  });

  it('renders the ancestor crumbs as real links carrying their href', () => {
    renderBreadcrumb();

    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute(
      'href',
      '/workspaces',
    );
    expect(screen.getByRole('link', { name: 'Boards' })).toHaveAttribute(
      'href',
      '/workspaces/12/boards',
    );
  });

  it('marks the current page with aria-current and gives it no href', () => {
    renderBreadcrumb();

    const current = screen.getByRole('link', { current: 'page' });

    expect(current).toHaveTextContent('Invoice generator');
    expect(current).not.toHaveAttribute('href');
    expect(current.tagName).toBe('SPAN');
    expect(current).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not mark the ancestor crumbs as the current page', () => {
    renderBreadcrumb();

    expect(screen.getByRole('link', { name: 'Workspaces' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('keeps the separators out of the accessible list', () => {
    const { container } = renderBreadcrumb();

    // Five <li> are in the DOM — three crumbs and two separators — but only the
    // three crumbs are exposed, because a separator is role=presentation.
    expect(container.querySelectorAll('li')).toHaveLength(5);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('hides the separator from assistive technology', () => {
    const { container } = renderBreadcrumb();

    const separators = Array.from(container.querySelectorAll('li')).filter(
      (li) => li.getAttribute('role') === 'presentation',
    );

    expect(separators).toHaveLength(2);
    separators.forEach((sep) => expect(sep).toHaveAttribute('aria-hidden', 'true'));
  });

  it('renders a chevron in the separator by default', () => {
    const { container } = renderBreadcrumb();

    const separator = container.querySelector('li[role="presentation"]') as HTMLElement;

    expect(separator.querySelector('svg')).not.toBeNull();
  });

  it('renders custom separator content instead of the chevron', () => {
    const { container } = render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/workspaces">Workspaces</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator>/</BreadcrumbSeparator>
        </BreadcrumbList>
      </Breadcrumb>,
    );

    const separator = container.querySelector('li[role="presentation"]') as HTMLElement;

    expect(separator).toHaveTextContent('/');
    expect(separator.querySelector('svg')).toBeNull();
  });

  it('hides the ellipsis and its label from assistive technology', () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbEllipsis />
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );

    expect(screen.getByText('More').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'More' })).not.toBeInTheDocument();
  });

  it('renders the crumbs inside an ordered list', () => {
    renderBreadcrumb();

    const nav = screen.getByRole('navigation', { name: 'breadcrumb' });
    const list = within(nav).getByRole('list');

    expect(list.tagName).toBe('OL');
  });

  it('renders the element a caller supplies through asChild, keeping the link styling', () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <button type="button">Back to boards</button>
            </BreadcrumbLink>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );

    const rendered = screen.getByRole('button', { name: 'Back to boards' });

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(rendered.className.split(/\s+/)).toContain('transition-colors');
  });

  it.each([
    ['BreadcrumbList', BreadcrumbList],
    ['BreadcrumbItem', BreadcrumbItem],
  ] as const)('%s keeps a caller class', (_name, Component) => {
    render(
      <Breadcrumb>
        <Component className="custom-crumb" data-testid="target" />
      </Breadcrumb>,
    );

    expect(screen.getByTestId('target').className.split(/\s+/)).toContain('custom-crumb');
  });
});
