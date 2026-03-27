"use client";

import { useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  address?: string | null;
  label?: string;
}

interface LeafletMapProps {
  markers: MapMarker[];
  height?: string;
  className?: string;
  onMarkerClick?: (marker: MapMarker) => void;
}

export function LeafletMap({ markers, height = "400px", className, onMarkerClick }: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

  // Stable callback ref for onMarkerClick so we don't re-create markers on every render
  const onMarkerClickRef = useRef(onMarkerClick);
  onMarkerClickRef.current = onMarkerClick;

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const defaultCenter: L.LatLngExpression =
      markers.length > 0 ? [markers[0].lat, markers[0].lng] : [-33.865143, 151.2099];

    const map = L.map(containerRef.current, {
      center: defaultCenter,
      zoom: 13,
      scrollWheelZoom: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    mapRef.current = map;
    markersLayerRef.current = L.layerGroup().addTo(map);

    return () => {
      map.off();
      map.remove();
      mapRef.current = null;
      markersLayerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update markers whenever they change
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    markers.forEach(m => {
      const leafletMarker = L.marker([m.lat, m.lng]).addTo(layer);

      const popupHtml = `
        <div style="min-width:160px">
          ${m.label ? `<p style="font-weight:600;margin:0 0 4px">${m.label}</p>` : ""}
          ${m.address ? `<p style="font-size:0.8rem;color:#555;margin:0">${m.address}</p>` : ""}
          <p style="font-size:0.75rem;color:#888;margin:4px 0 0">${m.lat.toFixed(6)}, ${m.lng.toFixed(6)}</p>
        </div>`;
      leafletMarker.bindPopup(popupHtml);

      if (onMarkerClickRef.current) {
        leafletMarker.on("click", () => onMarkerClickRef.current?.(m));
      }
    });

    if (markers.length === 1) {
      map.setView([markers[0].lat, markers[0].lng], 14);
    } else if (markers.length > 1) {
      const bounds = L.latLngBounds(markers.map(m => [m.lat, m.lng]));
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [markers]);

  return (
    <div
      ref={containerRef}
      style={{ height, width: "100%", borderRadius: "0.5rem" }}
      className={className}
    />
  );
}
