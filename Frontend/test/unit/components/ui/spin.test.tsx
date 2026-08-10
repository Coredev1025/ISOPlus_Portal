import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Spinner from '@/components/ui/spin';

/**
 * Spinner renders no text and exposes no ARIA role — the `loader` class is the
 * whole contract (the CSS animation hangs off it), so that is what these tests
 * pin down.
 */
describe('Spinner', () => {
  it('renders a single element carrying the loader class', () => {
    const { container } = render(<Spinner />);

    const elements = container.querySelectorAll('*');
    expect(elements).toHaveLength(1);
    expect(Array.from(elements[0].classList)).toEqual(['loader']);
  });

  it('appends a caller className alongside loader', () => {
    const { container } = render(<Spinner className="h-4 w-4" />);

    expect(Array.from(container.firstElementChild!.classList)).toEqual([
      'loader',
      'h-4',
      'w-4',
    ]);
  });

  it('renders no visible text', () => {
    const { container } = render(<Spinner className="h-4 w-4" />);

    expect(container.textContent).toBe('');
  });
});
