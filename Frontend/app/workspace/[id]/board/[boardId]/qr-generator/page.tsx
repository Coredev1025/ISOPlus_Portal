"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, QrCode, Download, FileText, Image } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { useState, useEffect, useRef } from "react";
import { useAppContext } from "@/app/context/index";
import axios from "@/app/utils/axiosConfig";
import Spinner from "@/components/ui/spin";
import { showFetchSuccessToast, showFetchErrorToast } from "@/lib/toast-utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import QRCode from 'qrcode';

interface Board {
  id: string;
  name: string;
  label?: string;
}

interface Form {
  id: string;
  name: string;
  url: string;
  type: string;
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
  const [forms, setForms] = useState<Form[]>([]);
  const [business, setBusiness] = useState<Business>();
  const [selectedForm, setSelectedForm] = useState<string>('');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string>('');
  const { workspaces, user } = useAppContext();
  const workspace = workspaces.find(w => w.id.toString() === id);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        
        // Fetch board data
        const boardsResponse = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/workspaces/boards?workspaceId=${id}`
        );
        const boardData: Board = boardsResponse.data.board.find((b: any) => b.id == boardId);
        setBoard(boardData);

        // Fetch business data for logos
        const businessResponse = await axios.get(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/profile?workspaceId=${id}`
        );
        setBusiness(businessResponse.data.business);

        setForms([{
          id: '1',
          name: 'Form 1',
          url: 'https://www.google.com',
          type: 'form'
        }]);

      } catch (error: any) {
        console.error("Error fetching data:", error);
        showFetchErrorToast("data", error.response?.data?.message || "Failed to load data");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id, boardId]);

  const getLogoUrl = async (logoKey: string): Promise<string> => {
    try {
      const response = await axios.get(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/api/business/logo?workspaceId=${id}&logoKey=${logoKey}`
      );
      return response.data.logoUrl;
    } catch (error) {
      console.error("Error fetching logo:", error);
      return '';
    }
  };

  const generateQRCode = async () => {
    if (!selectedForm) return;

    try {
      setGenerating(true);
      const form = forms.find(f => f.id === selectedForm);
      if (!form) return;

      // Get logo URL (priority: squareLogo > defaultLogo > no logo)
      let logoUrl = '';
      if (business?.squareLogo) {
        logoUrl = await getLogoUrl('squareLogo');
      } else if (business?.defaultLogo) {
        logoUrl = await getLogoUrl('defaultLogo');
      }

      // Generate QR code with high error correction for logo overlay
      const qrDataUrl = await QRCode.toDataURL(form.url, {
        errorCorrectionLevel: 'H', // 30% error correction for logo overlay
        type: 'image/png',
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        width: 400
      });

      setQrCodeDataUrl(qrDataUrl);
      setLogoUrl(logoUrl);

      // If we have a logo, overlay it on the QR code
      if (logoUrl) {
        await overlayLogoOnQR(qrDataUrl, logoUrl);
      }

    } catch (error: any) {
      console.error("Error generating QR code:", error);
      showFetchErrorToast("QR code", error.message || "Failed to generate QR code");
    } finally {
      setGenerating(false);
    }
  };

  const overlayLogoOnQR = async (qrDataUrl: string, logoUrl: string) => {
    return new Promise<void>((resolve, reject) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        reject(new Error("Canvas not available"));
        return;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error("Canvas context not available"));
        return;
      }

      const qrImage = new window.Image();
      const logoImage = new window.Image();

      qrImage.onload = () => {
        // Set canvas size
        canvas.width = qrImage.width;
        canvas.height = qrImage.height;

        // Draw QR code
        ctx.drawImage(qrImage, 0, 0);

        logoImage.onload = () => {
          // Calculate logo size (20% of QR code size)
          const logoSize = Math.min(qrImage.width, qrImage.height) * 0.2;
          const logoX = (qrImage.width - logoSize) / 2;
          const logoY = (qrImage.height - logoSize) / 2;

          // Create circular mask for logo
          ctx.save();
          ctx.beginPath();
          ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, 2 * Math.PI);
          ctx.clip();

          // Draw logo
          ctx.drawImage(logoImage, logoX, logoY, logoSize, logoSize);
          ctx.restore();

          // Update QR code data URL with logo
          const newDataUrl = canvas.toDataURL('image/png');
          setQrCodeDataUrl(newDataUrl);
          resolve();
        };

        logoImage.onerror = () => {
          console.warn("Failed to load logo, using QR code without logo");
          resolve();
        };

        logoImage.src = logoUrl;
      };

      qrImage.onerror = () => {
        reject(new Error("Failed to load QR code"));
      };

      qrImage.src = qrDataUrl;
    });
  };

  const downloadQRCode = () => {
    if (!qrCodeDataUrl) return;

    const link = document.createElement('a');
    link.download = `qr-code-${selectedForm}.png`;
    link.href = qrCodeDataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const selectedFormData = forms.find(f => f.id === selectedForm);

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
                <h1 className="text-3xl font-bold mb-2 bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/80">
                  QR Generator
                </h1>
                <p className="text-muted-foreground">
                  Create QR codes for your forms with custom branding
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
              {/* Form Selection */}
              <Card className="p-6 space-y-6">
                <div>
                  <h2 className="text-xl font-semibold mb-4">Select Form</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium mb-2">Choose a form to generate QR code</label>
                      <Select value={selectedForm} onValueChange={setSelectedForm}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a form..." />
                        </SelectTrigger>
                        <SelectContent>
                          {forms.map((form) => (
                            <SelectItem key={form.id} value={form.id}>
                              <div className="flex items-center gap-2">
                                <FileText className="h-4 w-4" />
                                {form.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {selectedFormData && (
                      <div className="p-4 bg-muted rounded-lg">
                        <h3 className="font-medium mb-2">Form Details</h3>
                        <p className="text-sm text-muted-foreground mb-2">
                          <strong>Name:</strong> {selectedFormData.name}
                        </p>
                        <p className="text-sm text-muted-foreground mb-2">
                          <strong>Type:</strong> {selectedFormData.type}
                        </p>
                        <p className="text-sm text-muted-foreground break-all">
                          <strong>URL:</strong> {selectedFormData.url}
                        </p>
                      </div>
                    )}

                    <Button
                      onClick={generateQRCode}
                      disabled={!selectedForm || generating}
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
                  
                  {qrCodeDataUrl ? (
                    <div className="space-y-4">
                      <div className="flex justify-center">
                        <div className="relative">
                          <img
                            src={qrCodeDataUrl}
                            alt="Generated QR Code"
                            className="max-w-full h-auto border rounded-lg shadow-lg"
                          />
                          {logoUrl && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="absolute top-2 right-2 bg-green-100 text-green-800 px-2 py-1 rounded-full text-xs font-medium">
                                    <Image className="h-3 w-3 inline mr-1" />
                                    Logo Applied
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>Logo has been embedded in the QR code</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex justify-center">
                        <Button
                          onClick={downloadQRCode}
                          variant="outline"
                          className="gap-2"
                        >
                          <Download className="h-4 w-4" />
                          Download PNG
                        </Button>
                      </div>

                      <div className="text-center text-sm text-muted-foreground">
                        <p>QR code is ready for use. You can scan it to access the form.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <QrCode className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
                      <p className="text-muted-foreground">
                        Select a form and generate a QR code to see it here
                      </p>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          )}
        </div>
      </div>

      {/* Hidden canvas for logo overlay */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />
    </div>
  );
} 