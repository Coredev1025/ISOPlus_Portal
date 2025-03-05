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
import { Template } from '@pdfme/common';
import { generate } from '@pdfme/generator';
import { text, image, barcodes, line, table, multiVariableText } from '@pdfme/schemas';
import pdfTemplate from "./template.json";

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

const template: Template = { ...pdfTemplate, basePdf: { ...pdfTemplate.basePdf, padding: pdfTemplate.basePdf.padding as [number, number, number, number] } };

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
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        (async () => {
                                                            try {
                                                                let data;
                                                                console.log(output);

                                                                if (output.type === "Invoice") {
                                                                    data = [
                                                                        {
                                                                            orders: "[[\"Eggshell Camisole Top\",\"1\",\"123\",\"123\"],[\"Cuban Collar Shirt\",\"2\",\"127\",\"254\"],[\"Cuban Collar Shirt\",\"2\",\"127\",\"254\"],[\"Cuban Collar Shirt\",\"2\",\"127\",\"254\"],[\"Cuban Collar Shirt\",\"2\",\"127\",\"254\"]]",
                                                                            taxInput: "{\"rate\":\"10\"}",
                                                                            logo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUgAAAGQBAMAAAA+V+RCAAAAAXNSR0IArs4c6QAAABtQTFRFAAAAR3BMAAAAAAAAAAAAAAAAAAAAAAAAAAAAqmQqwQAAAAh0Uk5TDQAvVYGtxusE1uR9AAAKg0lEQVR42tTbwU7bQBDG8TWoPeOBPoBbdbhiVMGV0Kr0GChSe0RtRfccEOROnP0eu8ckTMHrjD27/h4Afvo7u4kUxZXbjuboZ+Hx9vrz+6J8eW5rJKPHhYfr46J/JHn0u/DnuHcko/eF71Ub0j6k3P1Rr0jGIHs4bkPah5RbnveHZMBQ6VKHlMqjnpCMAdfUApk8pNx91QeSMex+C2R2IYFwrkcyht6yEsjkIeXutEjG8AtnApldSGBRqJAMk10JZHYhgaZSIBlG+yWQipAGKZ0ipNmr0uUaEmiKLZEMw52tkLqQD7f6PT7iv1uskLqQV06/nQ9ffswhF+oVUhMS07KX7Xz6+8ot5BQhBVLF/Pry0XGKkAKpGp3IRz7pjmQMiSz3TvB8s85I8h2ReuWy6IpkDIws6UI8745I8oMjy10vnnc3JGN4ZPlRnO9OSPIWyL0LcZ93QTIskOXuXPz9eCR5G2R5io09dUEyjJD7c3kJudiQJkiZMtTxSIYZ8mAu/oGLDGmHLL9hfXfRSIYh8g3W18QiyVsh5VdtoYpEMsyQ8uhM4pDk7ZDyeU/jkAw7pHzesygkeUOkPN+LKCTDGsnP3nNcREhz5MHm8Y5AMkyRskvdjiRvi5Qvyst2JCMB8hBru2lFkjdGypty1opkpEDuY21PbUjy1kh5nS/akIwkyL2fWK0pXEtIc6Q83ssWJCMR8nTjNncxIe2Rh/FIRirkW6ytdjEh7ZHvopGMFEj5EWPiYkLaI/djkYyEyDlWu3SakOmRjIRIWkdOnSJkeiQjfyT5ESAZ+SPJjwDJyB9JfgRIRv5I8iNAMvJHkh8BkpE/kvwIkIz8keRHgGTkjyQ/AiQjfyT5ESAZ+SPJjwDJyB9JfgRIRv5I8iNAMjJF6kLi0gSpC4mJMZJ8tkhdSNQmSF3IUNkiGfkiVSHRFCZIVUgsShOkKiRmNkhVSNzYIFUhMbFBqkKGygapCtkUhkhW/JrUAqkJiakRUhMy1EZITcimsEOy4keaNkhFyFBbIRUhF4UZkv61dzfdaRtRGIBHtqFbXQn2RhizDdg1XprYsVk2TlxryYlTo2WP4yLtwaCf3dNGyu3wWkqaczQzizurAGb05M6HPtBcJT+/jtQU8ucDuekZQwaJc8MGkV33AonIloFAWkO+9NxHbi/IfeQDuY987rmP/AuN9pEYR/eQmP7MbeQ25Xx3lpBX3yuXJxETzSN//AxVkIIUpCAFKUhBClKQghSkIAUpSEEKUpCCFKQgBSlIQQpSkIIUpCAFKUhBClKQghSkIAUpSEEKUpCCFKQgmyy+AeRedKi/jKr+LvII3z25uru7uhx7jSL379PlW/3lB+/1v0vhg+B08XXD6edxM0h+ntJm9K2eGJ7FW3xw/88Ht7vw/65L8BpDtvQF/MdVC5wGxQdg5O08eE0hz4v1a3pe9AsI+AwX0QeasYhzE0g/0XKIhBks8dY/eNI6CqzeagYZZtqa7k7VysBjzD4xeG3ZUQNIVs11y3YKvYLXVfMQg3LbHJKbccjrF7FX8BP+MJD8fzCIXEGv4Mp4JGG5MIbEkLSgsk5FUgVjSFyKPoTKhlVrcU0hMYXDjCvTJlQsU5PIJ712rgzzp6dpxi/mJpFr7a+gMt7A5sM4Ornm/5whJH6rDW9PvhnHROQHZzwtmEFi5zqHymY707d/YwU5h8excGW8ubVHsNc3iFxh5VxZiJPAxGifxOm8C5V1sO4Do1MQTudDqKyNc0AQm5zMMSvhDCob5ti4Az4wMYZkQJBAZRMcXeSfpennnlkkN2WIlc1e2wn60dgjM0j8XqsaOSIohpFlmCZYWcyvrCK5w8VQme8OclVWjcjEMhKm805eidx4VpAIomN8L8gsI2E6P3cUuS3f5Kbdas2dcYewhnzOeDoPM36LI+kA8ikuTv34EOgyq4tkdFqm1Dg0hzwvdyjlW9uoLpL7i7wsy5ExZJun89lXzn4d8gYuD5hAdsoNlhWvwhpkmMHlARPIICsRnSKmdcgupOEzgqRZ+dWi4adBDbIN1zDMIIflBidFHXWRHFpCtop/+HExYwYOIovArYOM36icJ1t2kOXOcHNU1FgbyY4dZHlYsb0vRmxtJP3YChIfCR5kNUdBg8wKUm/CNUEkNaR/+vvjY2IayRXy69ojc6VUOcZH5pAU6y0Y7iCx6l8sICd6DUFWf7bIB8wmkS39jCwEJESS3zOGDLWjL45k5RWMoQVkkGhXCUJAwjVrHkxmkAWkpEAkJ+WW8LeeF6PIIVcAkYTrk9xP12QS2eWpnDcAV3pBsDKJ5CqfCCJ5gHV3IbgmkH5cVgeRrPn1IZ8bRPJw3Y4gkry5Z2/3F/GpWWS7nFMwkhTv3Bvi3/DWjCJDHgkcSfht8c2/xl9572QWGSRlt8NI8gni8jKK+tcZ753MImnIX+dI4i8SaZrmvG3TyE7GoeFI4hkDbMwkks6yfDkiiCR3SihrMo70+yeHBJHkL2L5ZB5Jvk8EkYT2hm2ZQnLBSOL1fh7bTSL//N/IIEHjdtT4XX+MnFduYOPV3fX3QI0gA/3+yVblA/j8BI7NbjBDfzNImmmXZ8PqVptBpwsTuMezIWRL23YQV+5/j3GHcpBoxrfUAJJZHLpB5a2aQYIN2r/nzWzeNnmf+SJNWRVcp+lnj14rR4t0uduge+/SvJH7zPGe+4i4+P3KexSik0McT9Hpu7s/7q7GnttrH3ylPFlFIkhBClKQghSkIAUpSEEKUpCCFKQgBSlIQQpSkIIUpCAFKUhBClKQghSkIAUpSEEKUpCCFKQgbSO7cPO35YKpKN5ryNxN5FR13ETm1cipK0hdpTTze1eQeifUkXNXkG0dubsY337B1HI68osryImO9BNct2W/zLSsFcqPIT+a/bKDUhp623Nwr7gmRecwmzs2l69I6dlxfrPuw2Q4T6SonTs2B2FKRkXd3L3hPdN3g4rC3LmREyT6OFE7SSOn9omYIlKRr7E/2SdiBiJFNHOsU6JIQbpLZ6ZynnAUHxY5M1N2NdCcSHE3deZAaLKbMkxxdF1pb/QoIordau+WxnkhIgXhXXt2jf4Mup8Cuu35vJNBwyo+MGK7Q8MmHxVIP4GV9tavXfD+pkDSOYTSmUCuqES2cgilxUDiXKPgE6sD3L+BeBVITKdxaws5gOcRlUh8hM3GSoNjAoX8iRgJ6VOeezaMmIpiykiehHiEe+aN/tmuYuMxktuby4NnxYitzchOjkrDLR6cZWCYMrIiXc7zoUnj3nX1s8ZUTbqc5eWhMeLpoibvkdJmemBejSPVeIn6V4ssr0nXo7QzNCxp+th4KVKEQXkmRvLQcaxcANKPXTO+eICkgWvIW0JkEDsWyB4hkgbuBRKRQexcIBFJA/cCichg5o5x7VUg6SCzTMN0YYikiSvIL1SNDGLnRg0i6ch2g2PeNUTSmQvIBwIknAtZLXgWiEgKY+sdckTfQ9J+Yte4eUOIhHJkQ4mJABGJSvvGeiT1F7aMyzH9KJL2biyN6zdUjUTlr6l54vZDj+qQWPrXmWEi5KUEJBa//26RGRMuP449+jEkprV8TLPGgenjx8uomkj0N73+g6V/XjknAAAAAElFTkSuQmCC",
                                                                            invoiceInfo: "{\"InvoiceNo\":\"123456\",\"Date\":\"05 March 2025\"}",
                                                                            billedToInput: "Imani Olowe \n+123-456-7890 \n63 Ivy Road, Hawkville, GA, USA 31036"
                                                                        },
                                                                    ]
                                                                } else {
                                                                    data = [
                                                                        {
                                                                            orders: "[[\"Eggshell Camisole Top\",\"1\",\"123\",\"123\"],[\"Cuban Collar Shirt\",\"2\",\"127\",\"254\"]]",
                                                                            taxInput: "{\"rate\":\"15\"}",
                                                                            logo: "data:image/png;base64,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",
                                                                            invoiceInfo: "{\"InvoiceNo\":\"123456\",\"Date\":\"05 March 2025\"}",
                                                                            billedToInput: "Imani Olowe \n+123-456-7890 \n63 Ivy Road, Hawkville, GA, USA 31036"
                                                                        },
                                                                    ]
                                                                }

                                                                const pdfBytes = await generate({
                                                                    template: template, inputs: data, plugins: {
                                                                        text,
                                                                        image,
                                                                        line,
                                                                        table,
                                                                        multiVariableText,
                                                                        qrcode: barcodes.qrcode,
                                                                    }
                                                                });
                                                                const blob = new Blob([pdfBytes], { type: "application/pdf" });
                                                                const url = URL.createObjectURL(blob);
                                                                const anchor = document.createElement("a");
                                                                anchor.href = url;
                                                                anchor.download = `${output.documentName}.pdf`;
                                                                anchor.click();
                                                                URL.revokeObjectURL(url);
                                                            } catch (error) {
                                                                console.error("Error generating PDF:", error);
                                                            }
                                                        })();
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