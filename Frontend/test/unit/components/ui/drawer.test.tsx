import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
  DrawerClose,
} from '@/components/ui/drawer';

// vaul measures and animates against APIs jsdom does not implement.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  // vaul's getTranslate reads `style.transform || style.webkitTransform ||
  // style.mozTransform`. jsdom computes transform as '' and does not implement
  // the prefixed variants, so the chain lands on undefined and .match() throws
  // on pointer release — outside any test, as an unhandled error that fails the
  // whole run even though every assertion passes. Supplying 'none' lets vaul
  // take its no-transform path.
  const realGetComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    const style = realGetComputedStyle(element, pseudo ?? undefined);
    if (style.transform) return style;
    return new Proxy(style, {
      get(target, prop, receiver) {
        if (prop === 'transform') return 'none';
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as never;

  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as never;
});

function renderDrawer(props: Record<string, unknown> = {}) {
  return render(
    <Drawer {...props}>
      <DrawerTrigger>Open filters</DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Filter records</DrawerTitle>
          <DrawerDescription>Narrow the service list</DrawerDescription>
        </DrawerHeader>
        <p>Filter body</p>
        <DrawerFooter>
          <DrawerClose>Done</DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>,
  );
}

describe('Drawer', () => {
  it('renders the trigger but no content while closed', () => {
    renderDrawer();

    expect(screen.getByRole('button', { name: 'Open filters' })).toBeInTheDocument();
    expect(screen.queryByText('Filter body')).not.toBeInTheDocument();
  });

  it('shows the content when opened', async () => {
    const user = userEvent.setup();
    renderDrawer();

    await user.click(screen.getByRole('button', { name: 'Open filters' }));

    expect(await screen.findByText('Filter body')).toBeInTheDocument();
  });

  it('gives the open drawer an accessible name from its title', async () => {
    const user = userEvent.setup();
    renderDrawer();

    await user.click(screen.getByRole('button', { name: 'Open filters' }));

    expect(await screen.findByRole('dialog', { name: /Filter records/ })).toBeInTheDocument();
  });

  it('renders the description alongside the title', async () => {
    const user = userEvent.setup();
    renderDrawer();

    await user.click(screen.getByRole('button', { name: 'Open filters' }));

    expect(await screen.findByText('Narrow the service list')).toBeInTheDocument();
  });

  it('starts open when defaultOpen is set', async () => {
    renderDrawer({ defaultOpen: true });

    expect(await screen.findByText('Filter body')).toBeInTheDocument();
  });

  it('reports each open change', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDrawer({ onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Open filters' }));

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('closes when the close control is pressed', async () => {
    // vaul keeps the content mounted through its exit animation, and jsdom
    // never fires the transitionend that would unmount it — so the observable
    // close signal is the state flip and the onOpenChange callback, not
    // removal from the DOM.
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDrawer({ defaultOpen: true, onOpenChange });
    const dialog = await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(dialog).toHaveAttribute('data-state', 'closed');
    });
  });

  it('honours a controlled open prop', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDrawer({ open: false, onOpenChange });

    await user.click(screen.getByRole('button', { name: 'Open filters' }));

    expect(screen.queryByText('Filter body')).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('keeps a caller class on the content', async () => {
    render(
      <Drawer defaultOpen>
        <DrawerContent className="max-h-[80vh]">
          <DrawerTitle>Filter records</DrawerTitle>
          <p>Filter body</p>
        </DrawerContent>
      </Drawer>,
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog.className.split(/\s+/)).toContain('max-h-[80vh]');
  });
});
