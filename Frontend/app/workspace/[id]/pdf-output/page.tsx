"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { ArrowLeft, Download } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Header } from "@/components/ui/header";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
} from "@/components/ui/pagination";
import { useState } from "react";
import { PDFOutput } from "./types";

// Mock data for PDF outputs
export const allPdfOutputs: PDFOutput[] = [
    {
        id: "pdf-001",
        type: "Purchase Order",
        createdAt: "2024-03-28T14:30:00Z",
        createdBy: "John Smith",
        signatureProvider: "DocuSign",
        signed: true,
        documentName: "PO-2024-001",
        size: "1.2 MB",
        signedAt: "2024-03-28T15:30:00Z",
        signedBy: "Jane Doe",
        metadata: {
            orderNumber: "PO-2024-001",
            vendor: "Acme Corp",
            amount: "$5,000.00",
        },
    },
    {
        id: "pdf-002",
        type: "Invoice",
        createdAt: "2024-03-28T13:15:00Z",
        createdBy: "Sarah Johnson",
        signatureProvider: null,
        signed: false,
        documentName: "INV-2024-002",
        size: "856 KB",
        signedAt: null,
        signedBy: null,
        metadata: {
            invoiceNumber: "INV-2024-002",
            client: "Tech Solutions Inc",
            amount: "$3,500.00",
        },
    },
    {
        id: "pdf-003",
        type: "Quote",
        createdAt: "2024-03-28T12:00:00Z",
        createdBy: "Mike Brown",
        signatureProvider: null,
        signed: false,
        documentName: "QT-2024-003",
        size: "645 KB",
        signedAt: null,
        signedBy: null,
        metadata: {
            quoteNumber: "QT-2024-003",
            client: "Global Corp",
            amount: "$2,800.00",
        },
    },
    {
        id: "pdf-004",
        type: "Employee Agreement",
        createdAt: "2024-03-28T11:45:00Z",
        createdBy: "Emma Davis",
        signatureProvider: "PandaDoc",
        signed: true,
        documentName: "EA-2024-004",
        size: "925 KB",
        signedAt: "2024-03-28T12:30:00Z",
        signedBy: "Robert Wilson",
        metadata: {
            agreementNumber: "EA-2024-004",
            employee: "Robert Wilson",
            position: "Senior Developer",
        },
    },
    // Add more mock data for pagination
    ...Array.from({ length: 20 }, (_, i): PDFOutput => {
        const id = `pdf-${String(i + 5).padStart(3, '0')}`;
        const types = ["Purchase Order", "Invoice", "Quote", "Employee Agreement", "Contractor Agreement"];
        const type = types[Math.floor(Math.random() * types.length)];
        const date = new Date();
        date.setHours(date.getHours() - i);
        const isSigned = Math.random() > 0.3;
        const signatureProvider = isSigned ? ["DocuSign", "Adobe Sign", "PandaDoc"][Math.floor(Math.random() * 3)] : null;

        return {
            id,
            type,
            createdAt: date.toISOString(),
            createdBy: ["John Smith", "Sarah Johnson", "Mike Brown", "Emma Davis"][Math.floor(Math.random() * 4)],
            signatureProvider,
            signed: isSigned,
            documentName: `${type.split(' ')[0].toUpperCase()}-2024-${String(i + 5).padStart(3, '0')}`,
            size: `${Math.floor(Math.random() * 900 + 100)} KB`,
            signedAt: isSigned ? new Date(date.getTime() + 3600000).toISOString() : null,
            signedBy: isSigned ? ["Jane Doe", "Mike Wilson", "Alice Brown", "Bob Smith"][Math.floor(Math.random() * 4)] : null,
            metadata: {
                [`${type.toLowerCase().replace(' ', '')}Number`]: `${type.split(' ')[0].toUpperCase()}-2024-${String(i + 5).padStart(3, '0')}`,
                [Math.random() > 0.5 ? 'client' : 'vendor']: ["Acme Corp", "Tech Solutions Inc", "Global Services Ltd", "Innovation Corp"][Math.floor(Math.random() * 4)],
                amount: `$${Math.floor(Math.random() * 9000 + 1000)}.00`,
            },
        };
    }),
];

// Mock usage data
const usageData = [
    {
        type: "Purchase Order",
        totalUsage: 523,
        currentCycle: 45,
    },
    {
        type: "Invoice",
        totalUsage: 892,
        currentCycle: 76,
    },
    {
        type: "Quote",
        totalUsage: 234,
        currentCycle: 21,
    },
    {
        type: "Employee Agreement",
        totalUsage: 156,
        currentCycle: 12,
    },
    {
        type: "Contractor Agreement",
        totalUsage: 37,
        currentCycle: 4,
    },
];

const ITEMS_PER_PAGE = 10;

export default function PDFOutputPage() {
    const router = useRouter();
    const pathname = usePathname();
    const id = pathname.split("/")[2];
    const [basicPdfEnabled, setBasicPdfEnabled] = useState(true);
    const [selectedSignatureProvider, setSelectedSignatureProvider] = useState<string | null>("docusign");
    const [currentPage, setCurrentPage] = useState(1);

    const totalPages = Math.ceil(allPdfOutputs.length / ITEMS_PER_PAGE);
    const pdfOutputs = allPdfOutputs.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE
    );

    const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
    const displayPageNumbers = pageNumbers.slice(
        Math.max(0, currentPage - 2),
        Math.min(totalPages, currentPage + 1)
    );

    return (
        <div className="min-h-screen bg-background">
            <Header />
            <div className="container mx-auto py-8">
                <Button
                    variant="ghost"
                    className="mb-6"
                    onClick={() => router.back}
                >
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Back to Workspace
                </Button>

                <div className="space-y-6 max-w-6xl mx-auto">
                    {/* PDF Output Configuration */}
                    <Card className="p-6">
                        <div className="flex items-center justify-between mb-6">
                            <div>
                                <h1 className="text-2xl font-bold">PDF Output Configuration</h1>
                                <p className="text-muted-foreground">
                                    Configure PDF generation and digital signature settings
                                </p>
                            </div>
                            <Button onClick={() => router.push(`/workspace/${id}/pdf-output/configure`)}>
                                Setup
                            </Button>
                        </div>

                        {/* Configuration Options */}
                        <div className="space-y-6 mb-8">
                            <div className="flex items-center justify-between">
                                <div className="space-y-0.5">
                                    <Label>Basic PDF Output</Label>
                                    <p className="text-sm text-muted-foreground">
                                        Enable basic PDF generation without digital signatures
                                    </p>
                                </div>
                                <Switch
                                    checked={basicPdfEnabled}
                                    onCheckedChange={setBasicPdfEnabled}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label>Digital Signature Provider</Label>
                                <Select
                                    value={selectedSignatureProvider || ""}
                                    onValueChange={setSelectedSignatureProvider}
                                >
                                    <SelectTrigger className="w-[200px]">
                                        <SelectValue placeholder="Select provider" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="adobe">Adobe Sign</SelectItem>
                                        <SelectItem value="docusign">DocuSign</SelectItem>
                                        <SelectItem value="pandadoc">PandaDoc</SelectItem>
                                    </SelectContent>
                                </Select>
                                <p className="text-sm text-muted-foreground">
                                    Only one digital signature provider can be active at a time
                                </p>
                            </div>
                        </div>

                        {/* Usage Summary */}
                        <div className="mb-8">
                            <h2 className="text-xl font-semibold mb-4">Usage Summary</h2>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Document Type</TableHead>
                                        <TableHead className="text-right">Current Cycle</TableHead>
                                        <TableHead className="text-right">Total Usage</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {usageData.map((usage) => (
                                        <TableRow key={usage.type}>
                                            <TableCell>{usage.type}</TableCell>
                                            <TableCell className="text-right">{usage.currentCycle}</TableCell>
                                            <TableCell className="text-right">{usage.totalUsage}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>

                        {/* PDF Output History */}
                        <div>
                            <h2 className="text-xl font-semibold mb-4">Output History</h2>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Type</TableHead>
                                        <TableHead>Created At</TableHead>
                                        <TableHead>Created By</TableHead>
                                        <TableHead>Signature Status</TableHead>
                                        <TableHead>Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {pdfOutputs.map((output) => (
                                        <TableRow
                                            key={output.id}
                                            className="cursor-pointer hover:bg-muted/50"
                                            onClick={() => router.push(`/workspace/${id}/pdf-output/${output.id}`)}
                                        >
                                            <TableCell>{output.type}</TableCell>
                                            <TableCell>{new Date(output.createdAt).toLocaleString()}</TableCell>
                                            <TableCell>{output.createdBy}</TableCell>
                                            <TableCell>
                                                {output.signed ? (
                                                    <span className="text-green-600 font-medium">
                                                        Signed via {output.signatureProvider}
                                                    </span>
                                                ) : (
                                                    <span className="text-muted-foreground">Unsigned</span>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        // Handle download
                                                    }}
                                                >
                                                    <Download className="h-4 w-4" />
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>

                            <div className="mt-4 flex justify-center">
                                <Pagination>
                                    <PaginationContent>
                                        <PaginationItem>
                                            <PaginationPrevious
                                                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                                                className={currentPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                                            />
                                        </PaginationItem>

                                        {currentPage > 3 && (
                                            <>
                                                <PaginationItem>
                                                    <PaginationLink onClick={() => setCurrentPage(1)}>
                                                        1
                                                    </PaginationLink>
                                                </PaginationItem>
                                                <PaginationItem>
                                                    <PaginationEllipsis />
                                                </PaginationItem>
                                            </>
                                        )}

                                        {displayPageNumbers.map((pageNum) => (
                                            <PaginationItem key={pageNum}>
                                                <PaginationLink
                                                    onClick={() => setCurrentPage(pageNum)}
                                                    isActive={currentPage === pageNum}
                                                >
                                                    {pageNum}
                                                </PaginationLink>
                                            </PaginationItem>
                                        ))}

                                        {currentPage < totalPages - 2 && (
                                            <>
                                                <PaginationItem>
                                                    <PaginationEllipsis />
                                                </PaginationItem>
                                                <PaginationItem>
                                                    <PaginationLink onClick={() => setCurrentPage(totalPages)}>
                                                        {totalPages}
                                                    </PaginationLink>
                                                </PaginationItem>
                                            </>
                                        )}

                                        <PaginationItem>
                                            <PaginationNext
                                                onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                                                className={currentPage === totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                                            />
                                        </PaginationItem>
                                    </PaginationContent>
                                </Pagination>
                            </div>
                        </div>
                    </Card>
                </div>
            </div>
        </div>
    );
}