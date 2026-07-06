'use client';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { QrCode, Download, Copy, Info } from 'lucide-react';
import type { RefObject } from 'react';
import { QrGeneratorSourcePanel } from '@/lib/qr-generator-source-panel';

type FormOrDocument = {
  id: string;
  name: string;
  url: string;
  type: 'form' | 'document';
};

type Business = {
  defaultLogo?: string;
  squareLogo?: string;
  wideLogo?: string;
};

export function QrGeneratorPageView({
  loading,
  items,
  business,
  selectedId,
  customUrl,
  customUrlSelectionId,
  comboOpen,
  setComboOpen,
  setSelectedId,
  setCustomUrl,
  drawLogo,
  setDrawLogo,
  generating,
  qrCodeGenerated,
  lastGeneratedUrl,
  selectedItem,
  canvasRef,
  generateQRCode,
  copyQRCodeToClipboard,
  downloadQRCode,
}: {
  loading: boolean;
  items: FormOrDocument[];
  business?: Business;
  selectedId: string;
  customUrl: string;
  customUrlSelectionId: string;
  comboOpen: boolean;
  setComboOpen: (open: boolean) => void;
  setSelectedId: (id: string) => void;
  setCustomUrl: (url: string) => void;
  drawLogo: boolean;
  setDrawLogo: (value: boolean) => void;
  generating: boolean;
  qrCodeGenerated: boolean;
  lastGeneratedUrl: string;
  selectedItem?: FormOrDocument;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  generateQRCode: () => void;
  copyQRCodeToClipboard: () => void;
  downloadQRCode: () => void;
}) {
  return (
    <div className="space-y-6">
      <Card className="p-6 shadow-lg card-hover">
        <div className="flex items-center gap-4">
          <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
            <QrCode className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-3xl font-bold mb-2 text-foreground">QR Generator</h1>
            <p className="text-muted-foreground">
              Create QR codes for your forms, documents, or any other links.
            </p>
          </div>
        </div>
      </Card>

      {loading ? (
        <Card className="p-6">
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <QrGeneratorSourcePanel
            items={items}
            business={business}
            selectedId={selectedId}
            customUrl={customUrl}
            customUrlSelectionId={customUrlSelectionId}
            comboOpen={comboOpen}
            setComboOpen={setComboOpen}
            setSelectedId={setSelectedId}
            setCustomUrl={setCustomUrl}
            drawLogo={drawLogo}
            setDrawLogo={setDrawLogo}
            generating={generating}
            generateQRCode={generateQRCode}
          />

          <Card className="p-6 space-y-6">
            <div>
              <h2 className="text-xl font-semibold mb-4">Generated QR Code</h2>
              <div className="space-y-6 w-full" style={{ display: qrCodeGenerated ? 'block' : 'none' }}>
                <div className="flex justify-center">
                  <canvas ref={canvasRef} className="w-64 h-64 object-contain border border-border rounded-lg" />
                </div>
                <div className="flex justify-center">
                  <input
                    type="text"
                    value={lastGeneratedUrl || selectedItem?.url || ''}
                    readOnly
                    className="w-64 px-4 py-3 border-2 border-primary/30 rounded-lg bg-card text-foreground text-sm font-mono"
                  />
                </div>
                <div className="flex justify-center gap-3">
                  <div className="flex items-center gap-2">
                    <Info className="h-4 w-4 text-muted-foreground" />
                    <Button
                      onClick={copyQRCodeToClipboard}
                      variant="outline"
                      className="bg-card border-2 border-primary/30 text-foreground hover:bg-primary/10 hover:border-primary/50 hover:text-foreground px-6 py-2 rounded-lg transition-colors"
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      Copy
                    </Button>
                  </div>
                  <Button
                    onClick={downloadQRCode}
                    variant="outline"
                    className="bg-card border-2 border-primary/30 text-foreground hover:bg-primary/10 hover:border-primary/50 hover:text-foreground px-6 py-2 rounded-lg transition-colors"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </Button>
                </div>
                <div className="text-center text-sm text-muted-foreground">
                  <p>QR code is ready for use. You can scan it to access the form or document.</p>
                </div>
              </div>
              <div className="text-center py-12" style={{ display: qrCodeGenerated ? 'none' : 'block' }}>
                <QrCode className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground">
                  Select a form, document, or Custom URL, then generate a QR code to view it here
                </p>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
