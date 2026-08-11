import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { LeafletMap, type MapMarker } from '@/components/ui/leaflet-map';

/**
 * Leaflet needs a real layout engine, so the library is replaced with a
 * recording double. The assertions are all about *this component's* contract
 * with Leaflet — the centre and zoom it computes, the tile URL it requests, the
 * markers and popups it builds, and how it reframes for one marker vs many —
 * never about the double itself.
 */

const { L, map, layer, createdMarkers } = vi.hoisted(() => {
  const map = {
    setView: vi.fn(),
    fitBounds: vi.fn(),
    off: vi.fn(),
    remove: vi.fn(),
  };

  const layer = { clearLayers: vi.fn(), addTo: vi.fn(() => layer) };

  const createdMarkers: Array<{ latlng: [number, number]; marker: any }> = [];

  const L = {
    Icon: { Default: { prototype: {}, mergeOptions: vi.fn() } },
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
    layerGroup: vi.fn(() => layer),
    latLngBounds: vi.fn((coords: Array<[number, number]>) => ({ coords })),
    marker: vi.fn((latlng: [number, number]) => {
      const handlers: Record<string, () => void> = {};
      const marker: any = {
        addTo: vi.fn(() => marker),
        bindPopup: vi.fn(() => marker),
        on: vi.fn((event: string, handler: () => void) => {
          handlers[event] = handler;
          return marker;
        }),
        handlers,
      };
      createdMarkers.push({ latlng, marker });
      return marker;
    }),
  };

  return { L, map, layer, createdMarkers };
});

vi.mock('leaflet', () => ({ default: L }));
vi.mock('leaflet/dist/leaflet.css', () => ({}));

const SYDNEY: [number, number] = [-33.865143, 151.2099];

function marker(overrides: Partial<MapMarker> = {}): MapMarker {
  return {
    id: 'm-1',
    lat: -33.8688,
    lng: 151.2093,
    address: '1 Test St, Testville',
    label: 'Dana Reid',
    ...overrides,
  };
}

beforeEach(() => {
  createdMarkers.length = 0;
  for (const fn of [
    map.setView,
    map.fitBounds,
    map.off,
    map.remove,
    layer.clearLayers,
    L.map,
    L.tileLayer,
    L.layerGroup,
    L.latLngBounds,
    L.marker,
  ]) {
    (fn as ReturnType<typeof vi.fn>).mockClear();
  }
});

describe('LeafletMap initialisation', () => {
  it('centres on Sydney when there are no markers', () => {
    render(<LeafletMap markers={[]} />);

    expect(L.map.mock.calls[0][1]).toMatchObject({ center: SYDNEY, zoom: 13 });
  });

  it('centres on the first marker when there is one', () => {
    render(<LeafletMap markers={[marker()]} />);

    expect(L.map.mock.calls[0][1]).toMatchObject({ center: [-33.8688, 151.2093] });
  });

  it('enables scroll-wheel zoom', () => {
    render(<LeafletMap markers={[]} />);

    expect(L.map.mock.calls[0][1]).toMatchObject({ scrollWheelZoom: true });
  });

  it('adds the OpenStreetMap tile layer with attribution', () => {
    render(<LeafletMap markers={[]} />);

    expect(L.tileLayer.mock.calls[0][0])
      .toBe('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(String(L.tileLayer.mock.calls[0][1].attribution)).toContain('OpenStreetMap');
  });

  it('creates the map only once across re-renders', () => {
    const { rerender } = render(<LeafletMap markers={[]} />);
    rerender(<LeafletMap markers={[marker()]} />);

    expect(L.map).toHaveBeenCalledTimes(1);
  });

  it('tears the map down on unmount', () => {
    const { unmount } = render(<LeafletMap markers={[]} />);

    unmount();

    expect(map.off).toHaveBeenCalled();
    expect(map.remove).toHaveBeenCalled();
  });
});

describe('LeafletMap markers', () => {
  it('creates one marker per input, at its coordinates', () => {
    render(
      <LeafletMap
        markers={[marker(), marker({ id: 'm-2', lat: -37.8136, lng: 144.9631 })]}
      />,
    );

    expect(createdMarkers.map((m) => m.latlng)).toEqual([
      [-33.8688, 151.2093],
      [-37.8136, 144.9631],
    ]);
  });

  it('creates no markers for an empty list', () => {
    render(<LeafletMap markers={[]} />);

    expect(createdMarkers).toHaveLength(0);
  });

  it('puts the label and address in the popup', () => {
    render(<LeafletMap markers={[marker()]} />);

    const html = String(createdMarkers[0].marker.bindPopup.mock.calls[0][0]);
    expect(html).toContain('Dana Reid');
    expect(html).toContain('1 Test St, Testville');
  });

  it('shows the coordinates to six decimal places', () => {
    render(<LeafletMap markers={[marker({ lat: -33.8688, lng: 151.2093 })]} />);

    const html = String(createdMarkers[0].marker.bindPopup.mock.calls[0][0]);
    expect(html).toContain('-33.868800, 151.209300');
  });

  it('omits the label paragraph when there is no label', () => {
    render(<LeafletMap markers={[marker({ label: undefined })]} />);

    const html = String(createdMarkers[0].marker.bindPopup.mock.calls[0][0]);
    expect(html).not.toContain('font-weight:600');
  });

  it('omits the address paragraph when the address is null', () => {
    render(<LeafletMap markers={[marker({ address: null })]} />);

    const html = String(createdMarkers[0].marker.bindPopup.mock.calls[0][0]);
    expect(html).not.toContain('1 Test St');
  });

  it('clears the previous markers before redrawing', () => {
    const { rerender } = render(<LeafletMap markers={[marker()]} />);
    layer.clearLayers.mockClear();

    rerender(<LeafletMap markers={[marker({ id: 'm-2' })]} />);

    expect(layer.clearLayers).toHaveBeenCalled();
  });

  it('reports the marker that was clicked', () => {
    const onMarkerClick = vi.fn();
    const only = marker();
    render(<LeafletMap markers={[only]} onMarkerClick={onMarkerClick} />);

    createdMarkers[0].marker.handlers.click();

    expect(onMarkerClick).toHaveBeenCalledWith(only);
  });

  it('registers no click handler when no callback is supplied', () => {
    render(<LeafletMap markers={[marker()]} />);

    expect(createdMarkers[0].marker.on).not.toHaveBeenCalled();
  });
});

describe('LeafletMap framing', () => {
  it('zooms in to a single marker', () => {
    render(<LeafletMap markers={[marker()]} />);

    expect(map.setView).toHaveBeenCalledWith([-33.8688, 151.2093], 14);
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it('fits the bounds of several markers, with padding', () => {
    render(
      <LeafletMap
        markers={[marker(), marker({ id: 'm-2', lat: -37.8136, lng: 144.9631 })]}
      />,
    );

    expect(L.latLngBounds).toHaveBeenCalledWith([
      [-33.8688, 151.2093],
      [-37.8136, 144.9631],
    ]);
    expect(map.fitBounds).toHaveBeenCalledWith(expect.anything(), { padding: [40, 40] });
    expect(map.setView).not.toHaveBeenCalled();
  });

  it('neither reframes nor zooms when there are no markers', () => {
    render(<LeafletMap markers={[]} />);

    expect(map.setView).not.toHaveBeenCalled();
    expect(map.fitBounds).not.toHaveBeenCalled();
  });
});

describe('LeafletMap container', () => {
  it('defaults to a 400px tall, full-width container', () => {
    const { container } = render(<LeafletMap markers={[]} />);

    const el = container.firstElementChild as HTMLElement;
    expect(el.style.height).toBe('400px');
    expect(el.style.width).toBe('100%');
  });

  it('honours a caller height', () => {
    const { container } = render(<LeafletMap markers={[]} height="600px" />);

    expect((container.firstElementChild as HTMLElement).style.height).toBe('600px');
  });

  it('applies a caller class', () => {
    const { container } = render(<LeafletMap markers={[]} className="border" />);

    expect((container.firstElementChild as HTMLElement).className).toBe('border');
  });
});
