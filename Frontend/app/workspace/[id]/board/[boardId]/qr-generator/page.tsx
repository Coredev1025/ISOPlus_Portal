"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, QrCode, Download, FileText, File, Copy, Info, ChevronDown, Link2 } from "lucide-react";
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

const qrFetchCache = new Map<string, Promise<any>>();

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
  const { workspaces, user, setCurrentWorkspaceId } = useAppContext();
  const workspace = workspaces.find(w => w.id.toString() === id);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setQrCodeGenerated(false);
    setLastGeneratedUrl('');
  }, [selectedId]);

  function normalizeUrlForQr(input: string): string | null {
    const t = input.trim();
    if (!t) return null;
    try {
      if (/^https?:\/\//i.test(t)) {
        new URL(t);
        return t;
      }
      const withScheme = `https://${t}`;
      new URL(withScheme);
      return withScheme;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    if (id) {
      setCurrentWorkspaceId(id);
    }
    return () => {
      setCurrentWorkspaceId(null);
    };
  }, [id, setCurrentWorkspaceId]);

  useEffect(() => {
    if (!id || !boardId) return;

    const cacheKey = `${id}-${boardId}`;
    if (!qrFetchCache.has(cacheKey)) {
      qrFetchCache.set(cacheKey, (async () => {
        const [boardsResponse, businessResponse, viewsResponse] = await Promise.all([
          axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/boards?workspaceId=${id}`),
          axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile`, { params: { workspaceId: id } }),
          axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/boards/views-for-qr?workspaceId=${id}&boardId=${boardId}`),
        ]);
        const boardData: Board = boardsResponse.data.board.find((b: any) => b.id == boardId);
        const viewsData = viewsResponse.data.views || [];
        const mapped = viewsData.map((v: { id: string; name: string; url: string; type: "form" | "document" }) => ({
          id: v.id,
          name: v.name,
          url: v.url,
          type: v.type,
        }));
        return { boardData, businessData: businessResponse.data, items: mapped };
      })());
    }

    let cancelled = false;
    setLoading(true);
    qrFetchCache.get(cacheKey)!
      .then((data) => {
        if (!cancelled && data) {
          setBoard(data.boardData);
          setBusiness(data.businessData);
          setItems(data.items.sort((a: { name: string }, b: { name: string }) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })));
        }
      })
      .catch((error: any) => {
        if (!cancelled) {
          console.error("Error fetching data:", error);
          showFetchErrorToast("data", error.response?.data?.message || "Failed to load data");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
        qrFetchCache.delete(cacheKey);
      });

    return () => { cancelled = true; };
  }, [id, boardId]);

  const resolveUrlToEncode = (): string | null => {
    if (selectedId === CUSTOM_URL_SELECTION_ID) {
      return normalizeUrlForQr(customUrl);
    }
    if (selectedId) {
      const item = items.find((f) => String(f.id) === String(selectedId));
      return item?.url ?? null;
    }
    return null;
  };

  const generateQRCode = async () => {
    const targetUrl = resolveUrlToEncode();
    if (!targetUrl) {
      if (!selectedId) {
        showFetchErrorToast("QR code", "Select a form, document, or Custom URL from the list.");
      } else if (selectedId === CUSTOM_URL_SELECTION_ID) {
        showFetchErrorToast("QR code", "Enter a valid link (e.g. https://example.com).");
      } else {
        showFetchErrorToast("QR code", "Selected item has no URL.");
      }
      return;
    }

    try {
      setGenerating(true);

      const canvas = canvasRef.current;
      if (!canvas) {
        throw new Error("Canvas not available");
      }

      canvas.width = 400;
      canvas.height = 400;

      await QRCode.toCanvas(canvas, targetUrl, {
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

      setLastGeneratedUrl(targetUrl);
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
      link.download = `qr-code-${!selectedId || selectedId === CUSTOM_URL_SELECTION_ID ? "custom-link" : selectedId}.png`;
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
        link.download = `qr-code-${!selectedId || selectedId === CUSTOM_URL_SELECTION_ID ? "custom-link" : selectedId}.png`;
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

  const selectedItem = items.find((f) => String(f.id) === String(selectedId));

  /** Substring match (case-insensitive) on name, view id, share URL, or type. */
  const filterFormDocumentRows = (value: string, search: string) => {
    if (String(value) === CUSTOM_URL_SELECTION_ID) {
      return 1;
    }
    const q = search.trim().toLowerCase();
    if (!q) return 1;
    const row = items.find((i) => String(i.id) === value);
    if (!row) return 0;
    const haystack = [
      row.name,
      String(row.id),
      row.url,
      row.type,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q) ? 1 : 0;
  };

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
                  Create QR codes for your forms, documents, or any other links.
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
                  <h2
                    id="qr-generator-source-heading"
                    className="text-xl font-semibold text-foreground tracking-tight mb-3"
                  >
                    Choose a form, document, or custom link to generate a QR code
                  </h2>
                  {selectedId !== CUSTOM_URL_SELECTION_ID ? (
                    <p className="text-sm text-muted-foreground mb-4">
                      <span className="font-medium text-foreground">NOTE:</span> A QR code can be generated once the
                      sharing feature is enabled for the relevant form or document.
                    </p>
                  ) : null}
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Popover open={comboOpen} onOpenChange={setComboOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            role="combobox"
                            aria-expanded={comboOpen}
                            aria-labelledby="qr-generator-source-heading"
                            className="w-full justify-between font-normal h-11 rounded-lg border-border/80 bg-background shadow-sm hover:bg-accent/50"
                          >
                            {selectedId === CUSTOM_URL_SELECTION_ID ? (
                              <span className="flex items-center gap-2 truncate">
                                <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="truncate">
                                  Custom URL
                                  {customUrl.trim()
                                    ? ` — ${customUrl.trim().length > 36 ? `${customUrl.trim().slice(0, 36)}…` : customUrl.trim()}`
                                    : ""}
                                </span>
                              </span>
                            ) : selectedId ? (
                              (() => {
                                const sel = items.find((i) => String(i.id) === String(selectedId));
                                return sel ? (
                                  <span className="flex items-center gap-2 truncate">
                                    {sel.name}
                                    {sel.type === "document" ? (
                                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    ) : (
                                      <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    )}
                                  </span>
                                ) : (
                                  "Select a form or document..."
                                );
                              })()
                            ) : (
                              "Select a form or document..."
                            )}
                            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-[var(--radix-popover-trigger-width)] p-0 shadow-lg border-border/80 rounded-xl overflow-hidden"
                          align="start"
                        >
                          <Command filter={filterFormDocumentRows} shouldFilter>
                            <CommandInput placeholder="Search by name, id, URL, or type…" className="h-11" />
                            <CommandList className="max-h-[min(320px,50vh)]">
                              <CommandEmpty className="py-8 text-muted-foreground text-sm">
                                No form or document matches your search.
                              </CommandEmpty>
                              <CommandGroup className="p-1.5">
                                <CommandItem
                                  value={CUSTOM_URL_SELECTION_ID}
                                  keywords={["custom", "url", "link", "paste", "own"]}
                                  onSelect={() => {
                                    setSelectedId(CUSTOM_URL_SELECTION_ID);
                                    setComboOpen(false);
                                  }}
                                  className="rounded-md py-2.5 border-b border-border/60 mb-1"
                                >
                                  <span className="flex w-full min-w-0 items-center gap-2">
                                    <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                                    <span className="min-w-0 flex-1 font-medium text-foreground">
                                      Custom URL
                                    </span>
                                    <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/90">
                                      Paste link
                                    </span>
                                  </span>
                                </CommandItem>
                                {items.map((item) => (
                                  <CommandItem
                                    key={String(item.id)}
                                    value={String(item.id)}
                                    keywords={[item.name, String(item.id), item.url, item.type].filter(
                                      Boolean
                                    ) as string[]}
                                    onSelect={(value) => {
                                      setSelectedId(value);
                                      setCustomUrl("");
                                      setComboOpen(false);
                                    }}
                                    className="rounded-md py-2.5"
                                  >
                                    <span className="flex w-full min-w-0 items-center gap-2">
                                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                        {item.name}
                                      </span>
                                      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                                        {item.type === "document" ? (
                                          <FileText className="h-4 w-4" aria-hidden />
                                        ) : (
                                          <File className="h-4 w-4" aria-hidden />
                                        )}
                                        <span className="hidden sm:inline text-[10px] font-medium uppercase tracking-wide text-muted-foreground/90">
                                          {item.type === "document" ? "Doc" : "Form"}
                                        </span>
                                      </span>
                                    </span>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                      {selectedId ? (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-sm text-muted-foreground underline-offset-4 hover:text-foreground"
                          onClick={() => {
                            setSelectedId("");
                            setCustomUrl("");
                          }}
                        >
                          Clear selection
                        </Button>
                      ) : null}
                    </div>

                    {selectedId === CUSTOM_URL_SELECTION_ID ? (
                      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                        <h3 className="text-base font-semibold text-foreground">Copy the Link</h3>
                        <p className="text-sm text-muted-foreground">
                          Copy any link and paste it into the box below to generate a QR code.
                        </p>
                        <div className="space-y-2 pt-1">
                          <Label htmlFor="custom-qr-url" className="sr-only">
                            Link to encode in QR code
                          </Label>
                          <Input
                            id="custom-qr-url"
                            type="url"
                            inputMode="url"
                            placeholder="https://example.com/your-page"
                            value={customUrl}
                            onChange={(e) => setCustomUrl(e.target.value)}
                            className="font-mono text-sm bg-background"
                            autoComplete="off"
                          />
                        </div>
                      </div>
                    ) : null}

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
                          Include your business logo in the QR code
                        </Label>
                      </div>
                      {!business?.squareLogo && !business?.defaultLogo && (
                        <p className="text-xs text-muted-foreground ml-6">
                          No business logo available. Upload a logo in business settings to enable this option.
                        </p>
                      )}
                    </div>

                    <Button
                      type="button"
                      variant="destructive"
                      onClick={generateQRCode}
                      disabled={generating || !resolveUrlToEncode()}
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
                        value={lastGeneratedUrl || selectedItem?.url || ""}
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
                      Select a form, document, or Custom URL, then generate a QR code to view it here
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