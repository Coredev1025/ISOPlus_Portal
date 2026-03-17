"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, QrCode, Download, FileText, File, Copy, Info, ChevronDown } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect, useRef } from "react";
import { useAppContext } from "@/app/context/index";
import axios from "@/app/utils/axiosConfig";
import Spinner from "@/components/ui/spin";
import { showFetchSuccessToast, showFetchErrorToast, showSuccessToast } from "@/lib/toast-utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import QRCode from 'qrcode';

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
  const [comboOpen, setComboOpen] = useState(false);
  const [qrCodeGenerated, setQrCodeGenerated] = useState<boolean>(false);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [drawLogo, setDrawLogo] = useState<boolean>(false);
  const { workspaces, user, setCurrentWorkspaceId } = useAppContext();
  const workspace = workspaces.find(w => w.id.toString() === id);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (id) {
      setCurrentWorkspaceId(id);
    }
    return () => {
      setCurrentWorkspaceId(null);
    };
  }, [id, setCurrentWorkspaceId]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const boardsResponse = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/boards?workspaceId=${id}`);
        const boardData: Board = boardsResponse.data.board.find((b: any) => b.id == boardId);
        setBoard(boardData);
        const businessResponse = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`,
          {
            params: { workspaceId: id }
          }
        );
        setBusiness(businessResponse.data);
        const viewsResponse = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/boards/views-for-qr?workspaceId=${id}&boardId=${boardId}`
        );
        const viewsData = viewsResponse.data.views || [];
        const mapped = viewsData.map((v: { id: string; name: string; url: string; type: "form" | "document" }) => ({
          id: v.id,
          name: v.name,
          url: v.url,
          type: v.type,
        }));
        setItems(mapped.sort((a: { name: string }, b: { name: string }) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })));
      } catch (error: any) {
        console.error("Error fetching data:", error);
        showFetchErrorToast("data", error.response?.data?.message || "Failed to load data");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id, boardId]);

  const generateQRCode = async () => {
    if (!selectedId) return;

    try {
      setGenerating(true);
      const item = items.find((f) => f.id === selectedId);
      if (!item) return;

      const canvas = canvasRef.current;
      if (!canvas) {
        throw new Error("Canvas not available");
      }

      canvas.width = 400;
      canvas.height = 400;

      await QRCode.toCanvas(canvas, item.url, {
        errorCorrectionLevel: 'H',
        margin: 3,
        color: {
          dark: '#000000',
          light: '#ffffff'
        },
        width: 400
      });

      if(drawLogo && (business?.squareLogo || business?.defaultLogo)) {
        await overlayLogoOnQR(canvas, `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/qr-logo?workspaceId=${id}`);
      }

      setQrCodeGenerated(true);
    } catch (error: any) {
      console.error("Error generating QR code:", error);
      showFetchErrorToast("QR code", error.message || "Failed to generate QR code");
    } finally {
      setGenerating(false);
    }
  };

  const overlayLogoOnQR = async (canvas: HTMLCanvasElement, logoUrl: string) => {
    return new Promise<void>((resolve, reject) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error("Canvas context not available"));
        return;
      }

      let logoImage = new window.Image();
      logoImage.crossOrigin = "anonymous";
      logoImage.onload = () => {
        try {
          const logoSize = Math.min(canvas.width, canvas.height) * 0.15;
          const logoX = (canvas.width - logoSize) / 2;
          const logoY = (canvas.height - logoSize) / 2;
          const padding = logoSize * 0.2;
          const bgSize = logoSize + (padding * 2);
          const bgX = logoX - padding;
          const bgY = logoY - padding;
          const borderRadius = padding * 0.5;

          // Draw white background with rounded corners
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.moveTo(bgX + borderRadius, bgY);
          ctx.lineTo(bgX + bgSize - borderRadius, bgY);
          ctx.quadraticCurveTo(bgX + bgSize, bgY, bgX + bgSize, bgY + borderRadius);
          ctx.lineTo(bgX + bgSize, bgY + bgSize - borderRadius);
          ctx.quadraticCurveTo(bgX + bgSize, bgY + bgSize, bgX + bgSize - borderRadius, bgY + bgSize);
          ctx.lineTo(bgX + borderRadius, bgY + bgSize);
          ctx.quadraticCurveTo(bgX, bgY + bgSize, bgX, bgY + bgSize - borderRadius);
          ctx.lineTo(bgX, bgY + borderRadius);
          ctx.quadraticCurveTo(bgX, bgY, bgX + borderRadius, bgY);
          ctx.closePath();
          ctx.fill();

          // Draw the logo as a circle
          ctx.save();
          ctx.beginPath();
          ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, 2 * Math.PI);
          ctx.clip();
          ctx.drawImage(logoImage, logoX, logoY, logoSize, logoSize);
          ctx.restore();

          resolve();
        } catch (error) {
          console.error("Error drawing logo:", error);
          resolve(); // Don't reject, just resolve without the logo
        }
      };

      logoImage.onerror = () => {
        console.warn("Failed to load logo, using QR code without logo");
        resolve();
      };

      logoImage.onabort = () => {
        console.warn("Logo loading aborted, using QR code without logo");
        resolve();
      };

      logoImage.src = logoUrl;
    });
  };

  const downloadQRCode = () => {
    const canvas = canvasRef.current;
    if (!canvas || !qrCodeGenerated) return;

    try {
      const link = document.createElement('a');
      link.download = `qr-code-${selectedId}.png`;
      link.href = canvas.toDataURL('image/png');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error("Error downloading QR code:", error);

      // Check if it's a tainted canvas error
      if (error instanceof Error && error.message.includes('tainted')) {
        showFetchErrorToast("QR code", "Cannot download QR code with logo due to security restrictions. Try taking a screenshot instead.");
        return;
      }

      showFetchErrorToast("QR code", "Failed to download QR code due to security restrictions");
    }
  };

  const copyQRCodeToClipboard = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !qrCodeGenerated) return;

    // Check if Clipboard API is available
    if (!navigator.clipboard || !window.ClipboardItem) {
      showFetchErrorToast("Clipboard", "Your browser doesn't support copying images to clipboard. Try downloading instead.");
      return;
    }

    try {
      // Create a new canvas to avoid potential issues with the original
      const tempCanvas = document.createElement('canvas');
      const tempCtx = tempCanvas.getContext('2d');
      if (!tempCtx) {
        throw new Error("Failed to get canvas context");
      }

      // Set the same dimensions as the original canvas
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;

      // Copy the content from the original canvas
      tempCtx.drawImage(canvas, 0, 0);

      // Convert to blob
      const blob = await new Promise<Blob>((resolve, reject) => {
        tempCanvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Failed to create blob from canvas"));
          }
        }, 'image/png');
      });

      // Write to clipboard
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': blob
        })
      ]);

      showSuccessToast("QR code copied to clipboard successfully!");
    } catch (error) {
      console.error("Error copying QR code to clipboard:", error);

      // Check if it's a tainted canvas error
      if (error instanceof Error && (
        error.message.includes('tainted') ||
        error.message.includes('security') ||
        error.message.includes('CORS')
      )) {
        showFetchErrorToast("QR code", "Cannot copy QR code with logo due to security restrictions. Try regenerating without logo or downloading instead.");
        return;
      }

      // Fallback: Try to download the image
      try {
        const link = document.createElement('a');
        link.download = `qr-code-${selectedId}.png`;
        link.href = canvas.toDataURL('image/png');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        showSuccessToast("QR code downloaded (clipboard not available)");
      } catch (fallbackError) {
        console.error("Fallback also failed:", fallbackError);

        // Second fallback: Open in a new tab
        try {
          const dataUrl = canvas.toDataURL('image/png');
          const newWindow = window.open();
          if (newWindow) {
            newWindow.document.write(`<img src="${dataUrl}" alt="QR Code">`);
            showSuccessToast("QR code opened in a new tab");
          }
        } catch (secondFallbackError) {
          console.error("Second fallback also failed:", secondFallbackError);
          showFetchErrorToast("QR code", "Unable to export QR code. Please try taking a screenshot or regenerating without logo.");
        }
      }
    }
  };

  const selectedItem = items.find((f) => f.id === selectedId);

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

        <div className="space-y-6">
          {/* Page Header */}
          <Card className="p-6 shadow-lg card-hover">
            <div className="flex items-center gap-4">
              <div className="bg-primary/10 w-12 h-12 rounded-full flex items-center justify-center">
                <QrCode className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold mb-2 text-foreground">
                  QR Generator
                </h1>
                <p className="text-muted-foreground">
                  Create QR codes for your forms and documents with custom branding
                </p>
              </div>
            </div>
          </Card>

          {loading ? (
            <Card className="p-6">
              <div className="text-center py-8">
                <Spinner />
                <p className="mt-4 text-muted-foreground">Loading...</p>
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Form or Document Selection */}
              <Card className="p-6 space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-4">Select Form or Document</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium mb-2">Choose a form or document to generate QR code</label>
                      <Popover open={comboOpen} onOpenChange={setComboOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            role="combobox"
                            aria-expanded={comboOpen}
                            className="w-full justify-between font-normal h-10"
                          >
                            {selectedId
                              ? (() => {
                                  const sel = items.find((i) => i.id === selectedId);
                                  return sel ? (
                                    <span className="flex items-center gap-2 truncate">
                                      {sel.name}
                                      {sel.type === "form" ? (
                                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                      ) : (
                                        <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                                      )}
                                    </span>
                                  ) : (
                                    "Select a form or document..."
                                  );
                                })()
                              : "Select a form or document..."}
                            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Search form or document..." />
                            <CommandList>
                              <CommandEmpty>No form or document found.</CommandEmpty>
                              <CommandGroup>
                                {items.map((item) => (
                                  <CommandItem
                                    key={item.id}
                                    value={item.name}
                                    onSelect={() => {
                                      setSelectedId(item.id);
                                      setComboOpen(false);
                                    }}
                                  >
                                    <span className="flex items-center gap-2">
                                      {item.name}
                                      {item.type === "form" ? (
                                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                      ) : (
                                        <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                                      )}
                                    </span>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>

                    {selectedItem && (
                      <div className="p-4 bg-muted rounded-lg">
                        <h3 className="font-medium mb-2">
                          {selectedItem.type === "form" ? "Form" : "Document"} Details
                        </h3>
                        <p className="text-sm text-muted-foreground mb-2">
                          <strong>Name:</strong> {selectedItem.name}
                        </p>
                        <p className="text-sm text-muted-foreground mb-2">
                          <strong>Type:</strong> {selectedItem.type}
                        </p>
                        <p className="text-sm text-muted-foreground break-all">
                          <strong>URL:</strong> {selectedItem.url}
                        </p>
                        <p className="text-sm text-muted-foreground mt-2">
                          <strong>Logo Status:</strong> {(business?.squareLogo || business?.defaultLogo) ? 
                            <span className="text-green-600">Available</span> : 
                            <span className="text-orange-600">Not Configured</span>
                          }
                        </p>
                      </div>
                    )}

                    {/* Logo Options */}
                    <div className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="drawLogo"
                          checked={drawLogo}
                          onCheckedChange={(checked: boolean | "indeterminate") => 
                            setDrawLogo(checked === true)
                          }
                          disabled={!business?.squareLogo && !business?.defaultLogo}
                        />
                        <Label htmlFor="drawLogo" className="text-sm font-medium">
                          Include business logo on QR code
                        </Label>
                      </div>
                      {!business?.squareLogo && !business?.defaultLogo && (
                        <p className="text-xs text-muted-foreground ml-6">
                          No business logo available. Upload a logo in business settings to enable this option.
                        </p>
                      )}
                    </div>

                    <Button
                      onClick={generateQRCode}
                      disabled={!selectedId || generating}
                      className="w-full"
                    >
                      {generating ? (
                        <>
                          <Spinner className="mr-2" />
                          Generating QR Code...
                        </>
                      ) : (
                        <>
                          <QrCode className="mr-2 h-4 w-4" />
                          Generate QR Code
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Logo Information */}
                <div>
                  <h3 className="text-lg font-semibold mb-3">Logo Information</h3>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <p>• Square logo will be used if available</p>
                    <p>• Default logo will be used as fallback</p>
                    <p>• Logo will be placed in the center of the QR code</p>
                    <p>• QR code uses high error correction for logo overlay</p>
                  </div>
                </div>
              </Card>

              {/* QR Code Display */}
              <Card className="p-6 space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-4">Generated QR Code</h2>
                  <div className="space-y-6 w-full" style={{ display: qrCodeGenerated ? 'block' : 'none' }}>
                    <div className="flex justify-center">
                      <canvas
                        ref={canvasRef}
                        className="w-64 h-64 object-contain border border-border rounded-lg"
                      />
                    </div>
                    {/* Form URL display with light purple border */}
                    <div className="flex justify-center">
                      <input
                        type="text"
                        value={selectedItem?.url ?? ''}
                        readOnly
                        className="w-64 px-4 py-3 border-2 border-primary/30 rounded-lg bg-card text-foreground text-sm font-mono"
                      />
                    </div>
                    {/* Action buttons with info icon */}
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
                      Select a form or document and generate a QR code to see it here
                    </p>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}