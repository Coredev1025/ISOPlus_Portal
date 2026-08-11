import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QrGeneratorPageView } from '@/lib/qr-generator-page-view';

/**
 * The QR page view is a two-column shell: it either shows a loading card or the
 * source panel beside the result panel. The result panel is never unmounted —
 * it is toggled with `display: none` — so the interesting behaviour is which of
 * the two halves is *visible*, which URL the read-only field echoes back, and
 * that Copy/Download reach their handlers. Each is pinned below.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

const CUSTOM = '__qr_custom_url__';

const ITEMS = [
  { id: 'f-1', name: 'Intake Form', url: 'https://iso.example.com/f/1', type: 'form' as const },
  { id: 'd-1', name: 'Care Plan', url: 'https://iso.example.com/d/1', type: 'document' as const },
];

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    loading: false,
    items: ITEMS,
    business: { squareLogo: 'square.png' },
    selectedId: '',
    customUrl: '',
    customUrlSelectionId: CUSTOM,
    comboOpen: false,
    setComboOpen: vi.fn(),
    setSelectedId: vi.fn(),
    setCustomUrl: vi.fn(),
    drawLogo: false,
    setDrawLogo: vi.fn(),
    generating: false,
    qrCodeGenerated: false,
    lastGeneratedUrl: '',
    selectedItem: undefined,
    canvasRef: createRef<HTMLCanvasElement>(),
    generateQRCode: vi.fn(),
    copyQRCodeToClipboard: vi.fn(),
    downloadQRCode: vi.fn(),
    ...overrides,
  };
}

function renderView(overrides: Record<string, unknown> = {}) {
  const props = baseProps(overrides);
  render(<QrGeneratorPageView {...(props as never)} />);
  return props;
}

describe('QrGeneratorPageView masthead', () => {
  it('names the tool and says what it makes', () => {
    renderView();

    expect(screen.getByRole('heading', { name: 'QR Generator', level: 1 })).toBeInTheDocument();
    expect(
      screen.getByText('Create QR codes for your forms, documents, or any other links.'),
    ).toBeInTheDocument();
  });

  it('keeps the masthead while the page is still loading', () => {
    renderView({ loading: true });

    expect(screen.getByRole('heading', { name: 'QR Generator', level: 1 })).toBeInTheDocument();
  });
});

describe('QrGeneratorPageView loading state', () => {
  it('shows only a loading card, with neither panel mounted', () => {
    renderView({ loading: true });

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate QR Code/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Generated QR Code' })).not.toBeInTheDocument();
  });

  it('swaps the loading card for both panels once loading finishes', () => {
    renderView({ loading: false });

    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate QR Code/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Generated QR Code' })).toBeInTheDocument();
  });

  it('renders the real source panel, wired to the items it was given', async () => {
    renderView({ comboOpen: true });

    expect(await screen.findByRole('option', { name: /Intake Form/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Care Plan/ })).toBeInTheDocument();
  });
});

describe('QrGeneratorPageView result panel before a QR code exists', () => {
  it('shows the placeholder prompt', () => {
    renderView({ qrCodeGenerated: false });

    expect(
      screen.getByText(
        'Select a form, document, or Custom URL, then generate a QR code to view it here',
      ),
    ).toBeVisible();
  });

  it('hides the copy and download actions', () => {
    renderView({ qrCodeGenerated: false });

    // They are still in the DOM (the panel is toggled with `display: none`), so
    // they have to be dug out with `hidden: true` before being asserted unseen.
    expect(screen.getByRole('button', { name: 'Copy', hidden: true })).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Download', hidden: true })).not.toBeVisible();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('hides the ready-for-use note', () => {
    renderView({ qrCodeGenerated: false });

    expect(
      screen.getByText('QR code is ready for use. You can scan it to access the form or document.'),
    ).not.toBeVisible();
  });
});

describe('QrGeneratorPageView result panel once a QR code exists', () => {
  it('reveals the copy and download actions', () => {
    renderView({ qrCodeGenerated: true, lastGeneratedUrl: 'https://iso.example.com/f/1' });

    expect(screen.getByRole('button', { name: 'Copy' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible();
  });

  it('retires the placeholder prompt', () => {
    renderView({ qrCodeGenerated: true, lastGeneratedUrl: 'https://iso.example.com/f/1' });

    expect(
      screen.getByText(
        'Select a form, document, or Custom URL, then generate a QR code to view it here',
      ),
    ).not.toBeVisible();
  });

  it('echoes the URL that was actually encoded', () => {
    renderView({ qrCodeGenerated: true, lastGeneratedUrl: 'https://custom.example.com/a?b=1' });

    expect(screen.getByDisplayValue('https://custom.example.com/a?b=1')).toBeInTheDocument();
  });

  it('never lets the user edit that URL', () => {
    renderView({ qrCodeGenerated: true, lastGeneratedUrl: 'https://iso.example.com/f/1' });

    expect(screen.getByDisplayValue('https://iso.example.com/f/1')).toHaveAttribute('readonly');
  });

  it('prefers the generated URL over the selected item when they differ', () => {
    // lastGeneratedUrl wins: the selection can move on after generating, and the
    // field must keep describing the code actually on the canvas.
    renderView({
      qrCodeGenerated: true,
      lastGeneratedUrl: 'https://custom.example.com/a',
      selectedItem: ITEMS[0],
    });

    expect(screen.getByDisplayValue('https://custom.example.com/a')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('https://iso.example.com/f/1')).not.toBeInTheDocument();
  });

  it("falls back to the selected item's URL when nothing was recorded", () => {
    renderView({ qrCodeGenerated: true, lastGeneratedUrl: '', selectedItem: ITEMS[1] });

    expect(screen.getByDisplayValue('https://iso.example.com/d/1')).toBeInTheDocument();
  });

  it('falls back to an empty field when there is neither', () => {
    renderView({ qrCodeGenerated: true, lastGeneratedUrl: '', selectedItem: undefined });

    expect(screen.getByDisplayValue('')).toBeInTheDocument();
  });
});

describe('QrGeneratorPageView result actions', () => {
  it('copies when Copy is pressed', async () => {
    const user = userEvent.setup();
    const props = renderView({ qrCodeGenerated: true, lastGeneratedUrl: 'https://a.example.com' });

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(props.copyQRCodeToClipboard).toHaveBeenCalledTimes(1);
    expect(props.downloadQRCode).not.toHaveBeenCalled();
  });

  it('downloads when Download is pressed', async () => {
    const user = userEvent.setup();
    const props = renderView({ qrCodeGenerated: true, lastGeneratedUrl: 'https://a.example.com' });

    await user.click(screen.getByRole('button', { name: 'Download' }));

    expect(props.downloadQRCode).toHaveBeenCalledTimes(1);
    expect(props.copyQRCodeToClipboard).not.toHaveBeenCalled();
  });

  it('passes the generate request straight through from the source panel', async () => {
    const user = userEvent.setup();
    const props = renderView({ selectedId: 'f-1' });

    await user.click(screen.getByRole('button', { name: /Generate QR Code/ }));

    expect(props.generateQRCode).toHaveBeenCalledTimes(1);
  });

  it('locks the generate button out while a code is being drawn', () => {
    renderView({ selectedId: 'f-1', generating: true });

    expect(screen.getByRole('button', { name: /Generating QR Code/ })).toBeDisabled();
  });
});

describe('QrGeneratorPageView canvas', () => {
  it('hands the canvas element back through the ref it was given', () => {
    const canvasRef = createRef<HTMLCanvasElement>();

    renderView({ canvasRef, qrCodeGenerated: true });

    expect(canvasRef.current).toBeInstanceOf(HTMLCanvasElement);
  });

  it('still attaches the canvas before any code is generated', () => {
    // The drawing code writes to the canvas *before* qrCodeGenerated flips, so
    // the element has to exist while the panel is still hidden.
    const canvasRef = createRef<HTMLCanvasElement>();

    renderView({ canvasRef, qrCodeGenerated: false });

    expect(canvasRef.current).toBeInstanceOf(HTMLCanvasElement);
  });

  it('does not mount the canvas at all while loading', () => {
    const canvasRef = createRef<HTMLCanvasElement>();

    renderView({ canvasRef, loading: true });

    expect(canvasRef.current).toBeNull();
  });
});
