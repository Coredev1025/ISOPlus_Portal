import express from 'express';
import { info, error } from '../utils/logger.js';
import fs from 'fs/promises';
import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';
import path from 'path';
import { fileURLToPath } from 'url';
import Business from '../models/Business.js';
import PDFLink from '../models/PDFLink.js';
import { getS3FileUrl, uploadFileToS3 } from '../utils/uploadS3.js';
import {
    validateItemBelongsToTenant,
    putInternalMessage,
    getJobReportingReferencedItems,
    getJobPlanningReferencedItems,
    getQuoteReferencedItems,
    getPurchaseOrderReferencedItems,
    setGeneratedField
} from '../services/isoplus.js';
import { logAuditTrail } from '../utils/auditLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

function formatValue(val) {
    const num = Number(val);
    if (Number.isInteger(num)) {
        return num.toString();
    } else if (!isNaN(num)) {
        return num.toFixed(2);
    } else {
        return val;
    }
}

router.post('/:workspaceId/:boardId/invoice', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (!req.body.items.length) {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, req);
        return res.status(200).json({ message: 'Server error' });
    }

    const business = await Business.findOne({ workspaceId });

    await Promise.all(req.body.items.map(async (item) => {
        try {
            await validateItemBelongsToTenant(workspaceId, boardId, item.id);
            await putInternalMessage(workspaceId, boardId, item.id, "Running...");

            const [jobPlanningValues, serviceFeeTypeValues] = await getJobReportingReferencedItems(workspaceId, boardId, item.id);
            if (!jobPlanningValues) {
                putInternalMessage(workspaceId, boardId, item.id, "Job planning information is required. Job reporting is missing a job planning reference.");
                throw new Error("Job planning information is required. Job reporting is missing a job planning reference.");
            }
            if (!serviceFeeTypeValues) {
                putInternalMessage(workspaceId, boardId, item.id, "Service fee type information is required. Job reporting is missing a service fee type reference.");
                throw new Error("Service fee type information is required. Job reporting is missing a service fee type reference.");
            }

            const [contactValues] = await getJobPlanningReferencedItems(workspaceId, boardId, jobPlanningValues.id);
            if (!contactValues) {
                putInternalMessage(workspaceId, boardId, item.id, "Client information is required. Job planning is missing a client reference.");
                throw new Error("Client information is required. Job planning is missing a client reference.");
            }

            const templatePath = path.join(__dirname, '..', 'assets', `invoice.json`);
            const templateData = await fs.readFile(templatePath, 'utf8');
            const template = JSON.parse(templateData);
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 7);

            const logoKey = business.defaultLogo;
            let logoUrl = '';
            if (logoKey) {
                logoUrl = await getS3FileUrl(logoKey, 3600, false);
                if (!logoUrl) throw new Error('Failed to retrieve logo from S3');
            }

            let logoBase64 = '';
            if (logoUrl) {
                const response = await fetch(logoUrl);
                if (!response.ok) throw new Error('Failed to fetch logo from URL');
                const buffer = await response.arrayBuffer();
                const type = business.defaultLogo.split('.').pop();
                logoBase64 = `data:image/${type};base64,${Buffer.from(buffer).toString('base64')}`;
            }

            const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;
            business.documentNumbering.invoice.nextNumber += 1;
            await business.save();

            const invoiceValues = item.values;
            let subTotal = 0;
            let invoiceDescription = `[["${jobPlanningValues.jobTitle}-${serviceFeeTypeValues.feeType}-${formatValue(invoiceValues["Job Duration (Hrs.)"])}Hrs.", "1", "${formatValue(invoiceValues["Payable Service Fee($) - GST Excl."])}", "${invoiceValues["GST"]}", "${formatValue(invoiceValues["Payable Service Fee($) - GST Excl."])}"]`;
            subTotal += parseFloat(invoiceValues["Payable Service Fee($) - GST Excl."]);

            invoiceDescription += `,["Used Material/Part", "1", "${formatValue(invoiceValues["Payable Material Fee($) - GST Excl."])}", "${invoiceValues["GST"]}", "${formatValue(invoiceValues["Payable Material Fee($) - GST Excl."])}"]`;
            subTotal += parseFloat(invoiceValues["Payable Material Fee($) - GST Excl."]);

            invoiceDescription += `,["Other Payable Fee", "1", "${formatValue(invoiceValues["Other Payable Fee($) - GST Excl."])}", "${invoiceValues["GST"]}", "${formatValue(invoiceValues["Other Payable Fee($) - GST Excl."])}"]`;
            subTotal += parseFloat(invoiceValues["Other Payable Fee($) - GST Excl."]);

            invoiceDescription += "]";

            subTotal = formatValue(subTotal);
            const gstTotal = formatValue((subTotal * parseFloat(invoiceValues["GST"]) / 100));
            const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

            const clientDetails = {
                Address: contactValues.address,
                Suburb: contactValues.suburb,
                State: contactValues.state,
                Postcode: contactValues.postcode,
                Client: contactValues.client
            };

            const pdfBytes = await generate({
                template: template,
                inputs: [
                    {
                        logo: logoBase64,
                        subtotal: subTotal,
                        totalGST: gstTotal,
                        total: total,
                        clientDetails: JSON.stringify(clientDetails),
                        invoiceDetails: JSON.stringify({
                            Date: new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                            "Invoice Number": invoiceNumber
                        }),
                        companyName: JSON.stringify({ "Company Name": business.name }),
                        companyDetails: JSON.stringify({
                            ABN: business.abn,
                            "Street Address": business.address.street,
                            Suburb: business.address.suburb,
                            State: business.address.state,
                            Postcode: business.address.postcode,
                            Country: business.address.country
                        }),
                        orders: invoiceDescription,
                        "Due date": dueDate.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                        "Bank Details": JSON.stringify({
                            "Account Name": business.bankDetails.accountName,
                            "Bank Name": business.bankDetails.bankName,
                            BSB: business.bankDetails.bsb,
                            "Account Number": business.bankDetails.accountNumber,
                            "invoice Number": business.bankDetails.paymentReference
                        })
                    }
                ],
                plugins: { text, image, line, table, multiVariableText }
            });

            const filename = `output/${workspaceId}/${boardId}/invoices/${invoiceNumber + '-' + item.id}.pdf`;
            const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
            if (uploadResult['$metadata'].httpStatusCode === 200) {
                const fileUrl = await getS3FileUrl(filename);
                const expiryDate = new Date(Date.now() + 604800000); // 7 days in milliseconds
                await putInternalMessage(workspaceId, boardId, item.id, `Your invoice successfully created. \n Click <a href="${fileUrl}">here</a> \n This is a temporary link and will expire on ${expiryDate.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}. Make sure to download the file before expiry.`);
                logAuditTrail({
                    workspaceId,
                    action: 'Generate PDF Invoice',
                    detail: `Resource ID: ${item.id}, Link: ${fileUrl}`,
                    req
                });
                PDFLink.insertOne({ workspaceId: workspaceId, itemId: item.id, type: 'Invoice', pdfLink: fileUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" });
                info('Webhook-Service', 'Successfully generating PDF invoice', { link: fileUrl }, req);
                await setGeneratedField(workspaceId, boardId, item.id, `${invoiceNumber}(ISO+™)`);
                res.json({ pdfUrl: fileUrl });
            } else {
                throw new Error('Upload PDF failed, please provide correct information');
            }
        } catch (err) {
            const errorMessage = (err && err.message) ? err.message : 'An unknown error occurred. Please contact admin';
            await putInternalMessage(workspaceId, boardId, item.id, 'Server error: ' + errorMessage);
            error('Webhook-Service', 'Server error', { message: errorMessage }, req);
            logAuditTrail({
                workspaceId,
                action: 'Generate PDF Invoice',
                detail: `Resource ID: ${item.id}, Error: ${errorMessage}`,
                req
            });
            res.status(200).json({ message: 'Server error: ' + errorMessage });
        }
    }));
});

router.post('/:workspaceId/:boardId/purchaseorder', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (!req.body.items.length) {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, req);
        return res.status(200).json({ message: 'Server error' });
    }

    const business = await Business.findOne({ workspaceId });

    await Promise.all(req.body.items.map(async (item) => {
        try {
            await validateItemBelongsToTenant(workspaceId, boardId, item.id);
            await putInternalMessage(workspaceId, boardId, item.id, "Running...");

            const [contractorValues, jobTypeValues] = await getPurchaseOrderReferencedItems(workspaceId, boardId, item.id);
            if (!contractorValues) {
                await putInternalMessage(workspaceId, boardId, item.id, "Contractor information is required. Purchase order is missing Contractor.");
                throw new Error("Contractor information is required. Purchase order is missing Contractor.");
            }
            if (!jobTypeValues) {
                await putInternalMessage(workspaceId, boardId, item.id, "Job type information is required. Purchase order is missing Job Type.");
                throw new Error("Job type information is required. Purchase order is missing Job Type.");
            }

            const templatePath = path.join(__dirname, '..', 'assets', `purchaseorder.json`);
            const templateData = await fs.readFile(templatePath, 'utf8');
            const template = JSON.parse(templateData);
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 7);

            const logoKey = business.defaultLogo;
            let logoUrl = '';
            if (logoKey) {
                logoUrl = await getS3FileUrl(logoKey, 3600, false);
                if (!logoUrl) {
                    await putInternalMessage(workspaceId, boardId, item.id, "Failed to retrieve logo from S3");
                    throw new Error('Failed to retrieve logo from S3');
                }
            }

            let logoBase64 = '';
            if (logoUrl) {
                const response = await fetch(logoUrl);
                if (!response.ok) throw new Error('Failed to fetch logo from URL');
                const buffer = await response.arrayBuffer();
                logoBase64 = `data:image/${business.defaultLogo.split('.').pop()};base64,${Buffer.from(buffer).toString('base64')}`;
            }

            const purchaseOrderNumber = business.documentNumbering.purchaseOrder.prefix + business.documentNumbering.purchaseOrder.nextNumber;
            business.documentNumbering.purchaseOrder.nextNumber += 1;
            await business.save();

            const clientDetails = {
                Address: contractorValues.address,
                Suburb: contractorValues.suburb,
                State: contractorValues.state,
                Postcode: contractorValues.postcode,
                Supplier: contractorValues.contractor
            };

            const purchaseOrderValues = item.values;
            let subTotal = formatValue((purchaseOrderValues.Quantity || 1) * (purchaseOrderValues['Unit Price($) - GST Excl.'] || 1));
            let gstTotal = formatValue((subTotal * parseFloat(item.values["GST"]) / 100));
            let total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

            const inputs = {
                logo: logoBase64,
                subtotal: subTotal,
                totalGST: gstTotal,
                total: total,
                clientDetails: JSON.stringify(clientDetails),
                companyDetails: JSON.stringify({
                    ABN: business.abn,
                    "Street Address": business.address.street,
                    Suburb: business.address.suburb,
                    State: business.address.state,
                    Postcode: business.address.postcode,
                    Country: business.address.country
                }),
                quoteDetails: JSON.stringify({
                    "Issue Date": purchaseOrderValues['Issue Date'] && new Date(purchaseOrderValues['Issue Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                    "expiry Date": purchaseOrderValues['Expiry Date'] && new Date(purchaseOrderValues['Expiry Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                    "PO Number": purchaseOrderNumber
                }),
                companyName: JSON.stringify({ "Company Name": business.name }),
                termsInput: JSON.stringify({
                    "Delivery Date": purchaseOrderValues['Delivery Date'] && new Date(purchaseOrderValues['Delivery Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                    "Delivery Address": `${contractorValues.address} ${contractorValues.suburb} ${contractorValues.state} ${contractorValues.postcode}`,
                    "Additional Notes": `${purchaseOrderValues['Additional Notes'] ? purchaseOrderValues['Additional Notes'].replace(/<[^>]*>/g, '') : ' '}`
                }),
                orders: `[[
                    "${purchaseOrderValues['Job Title']}${purchaseOrderValues['Job Description'] ? ` - ${purchaseOrderValues['Job Description'].replace(/<[^>]*>/g, '')}` : ''}",
                    "${formatValue(purchaseOrderValues.Quantity || 1)}",
                    "${formatValue(purchaseOrderValues['Unit Price($) - GST Excl.'] || 1)}",
                    "${purchaseOrderValues['GST']}", 
                    "${formatValue((purchaseOrderValues.Quantity || 1) * (purchaseOrderValues['Unit Price($) - GST Excl.'] || 1))}"
                ]]`
            };

            const pdfBytes = await generate({
                template: template,
                inputs: [inputs],
                plugins: { text, image, line, table, multiVariableText }
            });

            const filename = `output/${workspaceId}/${boardId}/purchaseorder/${purchaseOrderNumber + '-ISO+™-' + item.id}.pdf`;
            const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
            if (uploadResult['$metadata'].httpStatusCode === 200) {
                const fileUrl = await getS3FileUrl(filename);
                const expiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                await putInternalMessage(workspaceId, boardId, item.id, `Your purchase order successfully created. \n Click <a href="${fileUrl}">here</a> \n This is a temporary link and will expire on ${expiryDate.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}. Make sure to download the file before expiry.`);
                logAuditTrail({
                    workspaceId,
                    action: 'Generate PDF Purchase Order',
                    detail: `Resource ID: ${item.id}, Link: ${fileUrl}`,
                    req
                });
                PDFLink.insertOne({ workspaceId: workspaceId, itemId: item.id, type: 'Purchase Order', pdfLink: fileUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" });
                info('Webhook-Service', 'Successfully generating PDF for Purchase Order', { link: fileUrl }, req);
                await setGeneratedField(workspaceId, boardId, item.id, `${purchaseOrderNumber} (ISO+™)`);
                res.json({ pdfUrl: fileUrl });
            } else {
                throw new Error('Upload PDF failed, please provide correct information');
            }
        } catch (err) {
            const errorMessage = (err && err.message) ? err.message : 'An unknown error occurred. Please contact admin';
            await putInternalMessage(workspaceId, boardId, item.id, 'Server error: ' + errorMessage);
            error('Webhook-Service', 'Server error', { message: errorMessage }, req);
            logAuditTrail({
                workspaceId,
                action: 'Generate PDF Purchase Order',
                detail: `Resource ID: ${item.id}, Error: ${errorMessage}`,
                req
            });
            res.status(200).json({ message: 'Server error: ' + errorMessage });
        }
    }));
});

router.post('/:workspaceId/:boardId/quote', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (!req.body.items.length) {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, req);
        return res.status(200).json({ message: 'Server error' });
    }

    const business = await Business.findOne({ workspaceId });
    console.log(req.body.items);
    await Promise.all(req.body.items.map(async (item) => {
        try {
            await validateItemBelongsToTenant(workspaceId, boardId, item.id);
            await putInternalMessage(workspaceId, boardId, item.id, "Running...");

            const [contactValues, jobTypeValues] = await getQuoteReferencedItems(workspaceId, boardId, item.id);
            if (!contactValues) throw new Error("Client information is required.");
            if (!jobTypeValues) throw new Error("Job Type is required.");

            const templatePath = path.join(__dirname, '..', 'assets', `quote.json`);
            const templateData = await fs.readFile(templatePath, 'utf8');
            const template = JSON.parse(templateData);

            const logoKey = business.defaultLogo;
            let logoUrl = '';
            if (logoKey) {
                logoUrl = await getS3FileUrl(logoKey, 3600, false);
                if (!logoUrl) throw new Error('Failed to retrieve logo from S3');
            }

            let logoBase64 = '';
            if (logoUrl) {
                const response = await fetch(logoUrl);
                if (!response.ok) throw new Error('Failed to fetch logo from URL');
                const buffer = await response.arrayBuffer();
                logoBase64 = `data:image/${business.defaultLogo.split('.').pop()};base64,${Buffer.from(buffer).toString('base64')}`;
            }

            const quoteNumber = business.documentNumbering.quote.prefix + business.documentNumbering.quote.nextNumber;
            business.documentNumbering.quote.nextNumber += 1;
            await business.save();

            const clientDetails = {
                Address: contactValues.address,
                Suburb: contactValues.suburb,
                State: contactValues.state,
                Postcode: contactValues.postcode,
                Client: contactValues.client
            };

            const quoteValues = item.values;

            let subTotal = formatValue((quoteValues.Quantity || 1) * (quoteValues['Unit Price($) - GST Excl.'] || 1));
            let gstTotal = formatValue((subTotal * parseFloat(quoteValues["GST"]) / 100));
            let total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

            const pdfBytes = await generate({
                template: template,
                inputs: [
                    {
                        logo: logoBase64,
                        subtotal: subTotal,
                        totalGST: gstTotal,
                        total: total,
                        clientDetails: JSON.stringify(clientDetails),
                        quoteDetails: JSON.stringify({
                            "Issue Date": quoteValues['Issue Date'] ? new Date(quoteValues['Issue Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                            "expiry Date": quoteValues['Expiry Date'] ? new Date(quoteValues['Expiry Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                            "Quote Number": quoteNumber
                        }),
                        companyName: JSON.stringify({ "Company Name": business.name }),
                        companyDetails: JSON.stringify({
                            ABN: business.abn,
                            "Street Address": business.address.street,
                            Suburb: business.address.suburb,
                            State: business.address.state,
                            Postcode: business.address.postcode,
                            Country: business.address.country
                        }),
                        orders: `[["${quoteValues['Job Title']} - ${quoteValues['Job Description'] ? quoteValues['Job Description'].replace(/<[^>]*>/g, '') : ''}","${formatValue(quoteValues.Quantity || 1)}","${formatValue(quoteValues['Unit Price($) - GST Excl.'] || 1)}", "${quoteValues["GST"]}", "${formatValue((quoteValues.Quantity || 1) * (quoteValues['Unit Price($) - GST Excl.'] || 1))}"]]`
                    }
                ],
                plugins: { text, image, line, table, multiVariableText }
            });

            const filename = `output/${workspaceId}/${boardId}/quote/${quoteNumber + '-ISO+™-' + item.id}.pdf`;
            const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
            if (uploadResult['$metadata'].httpStatusCode === 200) {
                const fileUrl = await getS3FileUrl(filename);
                const expiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                await putInternalMessage(workspaceId, boardId, item.id, `Your quote successfully created. \n Click <a href="${fileUrl}">here</a> \n This is a temporary link and will expire on ${expiryDate.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}. Make sure to download the file before expiry.`);
                logAuditTrail({
                    workspaceId,
                    action: 'Generate PDF Quote',
                    detail: `Resource ID: ${item.id}, Link: ${fileUrl}`,
                    req
                });
                PDFLink.insertOne({ workspaceId: workspaceId, itemId: item.id, type: 'Quote', pdfLink: fileUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" });
                info('Webhook-Service', 'Successfully generating PDF for Quote', { link: fileUrl }, req);
                await setGeneratedField(workspaceId, boardId, item.id, `${quoteNumber}(ISO+™)`);
                res.json({ pdfUrl: fileUrl });
            } else {
                throw new Error('Upload PDF failed, please provide correct information');
            }
        } catch (err) {
            const errorMessage = (err && err.message) ? err.message : 'An unknown error occurred. Please contact admin';
            await putInternalMessage(workspaceId, boardId, item.id, 'Server error: ' + errorMessage);
            error('Webhook-Service', 'Server error', { message: errorMessage }, req);
            logAuditTrail({
                workspaceId,
                action: 'Generate PDF Quote',
                detail: `Resource ID: ${item.id}, Error: ${errorMessage}`,
                req
            });
            res.status(200).json({ message: 'Server error: ' + errorMessage });
        }
    }));
});

router.get('/uploads/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const key = `pdfs/${filename}`;

        const fileUrl = await getS3FileUrl(key, 604800, true);

        if (!fileUrl) {
            res.redirect(fileUrl);
        } else {
            throw new Error('Invalid file URL');
        }
    } catch (err) {
        error('Webook-Service', 'Error downloading file', { message: err.message }, req);
        res.status(404).json({ message: 'File not found' });
    }
});

export default router;
