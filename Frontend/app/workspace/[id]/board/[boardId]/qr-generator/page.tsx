"use client";

import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect, useRef } from "react";
import { useAppContext } from "@/app/context/index";
import { useQrGeneratorBootstrap } from "@/lib/use-qr-generator-bootstrap";
import { useQrGeneratorActions } from "@/lib/use-qr-generator-actions";
import { QrGeneratorPageView } from "@/lib/qr-generator-page-view";

interface Board {
  id: string;
  name: string;
  label?: string;
}

interface FormOrDocument {
  id: string;
  name: string;
  url: string;
  type: "form" | "document";
}

/** Combobox value: encode the QR from the custom URL field (not a board view id). */
const CUSTOM_URL_SELECTION_ID = "__qr_custom_url__";

interface Business {
  defaultLogo?: string;
  squareLogo?: string;
  wideLogo?: string;
}

export default function QRGeneratorPage() {
  const router = useRouter();
  const pathname = usePathname();
  const id = pathname.split('/')[2];
  const boardId = pathname.split('/')[4];
  const [board, setBoard] = useState<Board>();
  const [items, setItems] = useState<FormOrDocument[]>([]);
  const [business, setBusiness] = useState<Business>();
  const [selectedId, setSelectedId] = useState<string>('');
  const [customUrl, setCustomUrl] = useState('');
  const [lastGeneratedUrl, setLastGeneratedUrl] = useState('');
  const [comboOpen, setComboOpen] = useState(false);
  const [qrCodeGenerated, setQrCodeGenerated] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [drawLogo, setDrawLogo] = useState<boolean>(false);
  const { setCurrentWorkspaceId } = useAppContext();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setQrCodeGenerated(false);
    setLastGeneratedUrl('');
  }, [selectedId]);

  useEffect(() => {
    if (id) {
      setCurrentWorkspaceId(id);
    }
    return () => {
      setCurrentWorkspaceId(null);
    };
  }, [id, setCurrentWorkspaceId]);

  useQrGeneratorBootstrap(id, boardId, setBoard, setBusiness, setItems, setLoading);

  const { generateQRCode, downloadQRCode, copyQRCodeToClipboard } = useQrGeneratorActions({
    selectedId,
    customUrl,
    customUrlSelectionId: CUSTOM_URL_SELECTION_ID,
    items,
    drawLogo,
    business,
    workspaceId: id,
    canvasRef,
    qrCodeGenerated,
    setGenerating,
    setLastGeneratedUrl,
    setQrCodeGenerated,
  });

  const selectedItem = items.find((f) => String(f.id) === String(selectedId));

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="container mx-auto py-8">
        <Button
          variant="ghost"
          className="mb-6"
          onClick={() => router.push(`/workspace/${id}/board/${boardId}`)}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Board
        </Button>

        <QrGeneratorPageView
          loading={loading}
          items={items}
          business={business}
          selectedId={selectedId}
          customUrl={customUrl}
          customUrlSelectionId={CUSTOM_URL_SELECTION_ID}
          comboOpen={comboOpen}
          setComboOpen={setComboOpen}
          setSelectedId={setSelectedId}
          setCustomUrl={setCustomUrl}
          drawLogo={drawLogo}
          setDrawLogo={setDrawLogo}
          generating={generating}
          qrCodeGenerated={qrCodeGenerated}
          lastGeneratedUrl={lastGeneratedUrl}
          selectedItem={selectedItem}
          canvasRef={canvasRef}
          generateQRCode={generateQRCode}
          copyQRCodeToClipboard={copyQRCodeToClipboard}
          downloadQRCode={downloadQRCode}
        />
      </div>
    </div>
  );
}
