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
    setIntegrationMessage,
    getJobReportingReferencedItems,
    getJobPlanningReferencedItems,
    getQuoteReferencedItems,
    getPurchaseOrderReferencedItems,
    setGeneratedField,
    getQuoteNDISReferencedItems
} from '../services/isoplus.js';
import { logAuditTrail } from '../utils/auditLogger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

async function getValidatedBusiness(workspaceId) {
    const business = await Business.findOne({ workspaceId: workspaceId.toString() });
    if (!business) {
        throw new Error('Business not found');
    }
    return business;
}

async function handlePDFError(err, workspaceId, boardId, itemId, action, req, res) {
    const errorMessage = (err && err.message) ? err.message : 'An unknown error occurred. Please contact support via ISO+™ Portal.';
    await setIntegrationMessage(workspaceId, boardId, itemId, 'Server error: ' + errorMessage);
    error('Webhook-Service', 'Server error', { message: errorMessage }, req);
    logAuditTrail({
        workspaceId,
        action,
        detail: `Resource ID: ${itemId}, Error: ${errorMessage}`,
        req
    });
    return res.status(200).json({ message: 'Server error: ' + errorMessage });
}

async function getLogoData(business) {
    const logoKey = business.defaultLogo;
    if (!logoKey) return '';
    
    const logoUrl = await getS3FileUrl(logoKey, 3600, false);
    if (!logoUrl) throw new Error('Failed to retrieve logo from S3');
    
    const response = await fetch(logoUrl);
    if (!response.ok) throw new Error('Failed to fetch logo from URL');
    
    const buffer = await response.arrayBuffer();
    const type = business.defaultLogo.split('.').pop();
    return `data:image/${type};base64,${Buffer.from(buffer).toString('base64')}`;
}

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

function validateRequestParams(req) {
    const { workspaceId, boardId } = req.params;
    if (!req.body.items?.length) {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, req);
        throw new Error('No items found in the payload');
    }
    return { workspaceId, boardId };
}

async function handlePDFSuccess(workspaceId, boardId, itemId, fileUrl, docType, req, res) {
    await setIntegrationMessage(workspaceId, boardId, itemId, `Your ${docType.toLowerCase()} has been successfully created.\n Click <a href="${fileUrl}">here</a> to download.`);
    logAuditTrail({
        workspaceId,
        action: `Generate PDF ${docType}`,
        detail: `Resource ID: ${itemId}, Link: ${fileUrl}`,
        req
    });
    await PDFLink.insertOne({ 
        workspaceId, 
        itemId, 
        type: docType, 
        pdfLink: fileUrl, 
        createdBy: "", 
        isDeleted: false, 
        SignatureStatus: "Unsigned" 
    });
    info('Webhook-Service', `Successfully generating PDF ${docType.toLowerCase()}`, { link: fileUrl }, req);
    return res.json({ pdfUrl: fileUrl });
}

router.post('/:workspaceId/:boardId/invoice', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [jobPlanningValues, serviceFeeTypeValues] = await getJobReportingReferencedItems(workspaceId, boardId, item.id);
                if (!jobPlanningValues) {
                    throw new Error("Job planning information is required. Job reporting is missing a job planning reference.");
                }
                if (!serviceFeeTypeValues) {
                    throw new Error("Service fee type information is required. Job reporting is missing a service fee type reference.");
                }

                const [contactValues] = await getJobPlanningReferencedItems(workspaceId, boardId, jobPlanningValues.id);
                if (!contactValues) {
                    throw new Error("Client information is required. Job planning is missing a client reference.");
                }

                const templatePath = path.join(__dirname, '..', 'assets', 'invoice.json');
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);

                const logoBase64 = await getLogoData(business);

                const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;
                business.documentNumbering.invoice.nextNumber += 1;
                await business.save();

                const invoiceValues = item.values;
                const invoiceDate = invoiceValues["Issue Date"] ? invoiceValues["Issue Date"].replace('Z', '') : "";
                const dueDate = invoiceValues["Due Date"] ? invoiceValues["Due Date"].replace('Z', '') : "";
                let subTotal = 0;
                let gst = invoiceValues["GST"] == "10%" ? "10%" : "0%";
                let invoiceDescription = `[["${jobPlanningValues.jobTitle}-${serviceFeeTypeValues.feeType}-${formatValue(invoiceValues["Job Duration (Hrs.)"])}Hrs.", "1", "${formatValue(invoiceValues["Payable Service Fee($) - GST Excl."])}", "${gst == "10%" ? "10%" : "GST Free"}", "${formatValue(invoiceValues["Payable Service Fee($) - GST Excl."])}"]`;
                subTotal += parseFloat(invoiceValues["Payable Service Fee($) - GST Excl."]);

                if (invoiceValues["Payable Material Fee($) - GST Excl."] > 0) {
                    invoiceDescription += `,["Used Material/Part", "1", "${formatValue(invoiceValues["Payable Material Fee($) - GST Excl."])}", "${gst == "10%" ? "10%" : "GST Free"}", "${formatValue(invoiceValues["Payable Material Fee($) - GST Excl."])}"]`;
                    subTotal += parseFloat(invoiceValues["Payable Material Fee($) - GST Excl."]);
                }

                if (invoiceValues["Other Payable Fee($) - GST Excl."] > 0) {
                    invoiceDescription += `,["Other Payable Fee", "1", "${formatValue(invoiceValues["Other Payable Fee($) - GST Excl."])}", "${gst == "10%" ? "10%" : "GST Free"}", "${formatValue(invoiceValues["Other Payable Fee($) - GST Excl."])}"]`;
                    subTotal += parseFloat(invoiceValues["Other Payable Fee($) - GST Excl."]);
                }

                invoiceDescription += "]";

                subTotal = formatValue(subTotal);
                const gstTotal = formatValue((subTotal * parseFloat(gst) / 100));
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
                                Date: invoiceDate && invoiceDate != "" ? new Date(invoiceDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
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
                            "dueDate": dueDate && dueDate != "" ? new Date(dueDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                            "Bank Details": JSON.stringify({
                                "Account Name": business.bankDetails.accountName,
                                "Bank Name": business.bankDetails.bankName,
                                BSB: business.bankDetails.bsb,
                                "Account Number": business.bankDetails.accountNumber,
                                "invoice Number": invoiceNumber
                            })
                        }
                    ],
                    plugins: { text, image, line, table, multiVariableText }
                });

                const filename = `output/${workspaceId}/${boardId}/invoices/${invoiceNumber + '-ISO+™-' + item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
                
                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename);
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'Invoice', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`);
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF Invoice', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, req);
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/purchaseorder', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [contractorValues, jobTypeValues] = await getPurchaseOrderReferencedItems(workspaceId, boardId, item.id);
                if (!contractorValues) {
                    throw new Error("Contractor information is required. Purchase order is missing Contractor.");
                }
                if (!jobTypeValues) {
                    throw new Error("Job type information is required. Purchase order is missing Job Type.");
                }

                const templatePath = path.join(__dirname, '..', 'assets', 'purchaseorder.json');
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);

                const logoBase64 = await getLogoData(business);

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
                const gst = purchaseOrderValues["GST"] == "10%" ? "10%" : "0%";
                const issueDate = purchaseOrderValues["Issue Date"] ? purchaseOrderValues["Issue Date"].replace('Z', '') : "";
                const deliveryDate = purchaseOrderValues["Delivery Date"] ? purchaseOrderValues["Delivery Date"].replace('Z', '') : "";
                let subTotal = formatValue((purchaseOrderValues.Quantity || 1) * (purchaseOrderValues['Unit Price($) - GST Excl.'] || 1));
                let gstTotal = formatValue((subTotal * parseFloat(gst) / 100));
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
                        "Issue Date": issueDate && issueDate != "" ? new Date(issueDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                        "expiry Date": deliveryDate && deliveryDate != "" ? new Date(deliveryDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                        "PO Number": purchaseOrderNumber
                    }),
                    companyName: JSON.stringify({ "Company Name": business.name }),
                    termsInput: JSON.stringify({
                        "Delivery Address": `${contractorValues.address} ${contractorValues.suburb} ${contractorValues.state} ${contractorValues.postcode}`,
                        "Additional Notes": `${purchaseOrderValues['Additional Notes'] && purchaseOrderValues['Additional Notes'].replace(/<[^>]*>/g, '') ? purchaseOrderValues['Additional Notes'].replace(/<[^>]*>/g, '') : ' '}`,
                        "Accounts Payable Payment Terms": `${business.bankDetails.accountsPayableTerms ? business.bankDetails.accountsPayableTerms : ' '}`
                    }),
                    orders: `[[
                        "${purchaseOrderValues['Job Title']}${purchaseOrderValues['Job Description'] ? ` - ${purchaseOrderValues['Job Description'].replace(/<[^>]*>/g, '')}` : ''}",
                        "${formatValue(purchaseOrderValues.Quantity || 1)}",
                        "${formatValue(purchaseOrderValues['Unit Price($) - GST Excl.'] || 1)}",
                        "${gst == "10%" ? "10%" : "GST Free"}", 
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
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'Purchase Order', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${purchaseOrderNumber} (ISO+™)`);
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF Purchase Order', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, req);
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/quote', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [contactValues, jobTypeValues] = await getQuoteReferencedItems(workspaceId, boardId, item.id);
                if (!contactValues) {
                    throw new Error("Client information is required.");
                }
                if (!jobTypeValues) {
                    throw new Error("Job Type is required.");
                }

                const templatePath = path.join(__dirname, '..', 'assets', 'quote.json');
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);

                const logoBase64 = await getLogoData(business);

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
                let gst = quoteValues["GST"] == "10%" ? "10%" : "0%";
                const issueDate = quoteValues['Issue Date'] ? quoteValues['Issue Date'].replace('Z', '') : "";
                const expiryDate = quoteValues['Expiry Date'] ? quoteValues['Expiry Date'].replace('Z', '') : "";
                let subTotal = formatValue((quoteValues.Quantity || 1) * (quoteValues['Unit Price($) - GST Excl.'] || 1));
                let gstTotal = formatValue((subTotal * parseFloat(gst) / 100));
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
                                "Issue Date": issueDate && issueDate != "" ? new Date(issueDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                                "expiry Date": expiryDate && expiryDate != "" ? new Date(expiryDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
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
                            orders: `[["${quoteValues['Job Title']} - ${quoteValues['Job Description'] ? quoteValues['Job Description'].replace(/<[^>]*>/g, '') : ''}","${formatValue(quoteValues.Quantity || 1)}","${formatValue(quoteValues['Unit Price($) - GST Excl.'] || 1)}", "${gst == "10%" ? "10%" : "GST Free"}", "${formatValue((quoteValues.Quantity || 1) * (quoteValues['Unit Price($) - GST Excl.'] || 1))}"]]`,
                            termsInputs: JSON.stringify({
                                "Accounts Receivable Payment Terms": `${business.bankDetails.accountsReceivableTerms ? business.bankDetails.accountsReceivableTerms : ' '}`
                            })
                        }
                    ],
                    plugins: { text, image, line, table, multiVariableText }
                });

                const filename = `output/${workspaceId}/${boardId}/quote/${quoteNumber + '-ISO+™-' + item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
                
                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename);
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'Quote', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${quoteNumber} (ISO+™)`);
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF Quote', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, req);
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/quotendis', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (!req.body.items.length) {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, req);
        return res.status(200).json({ message: 'Server error' });
    }

    const business = await Business.findOne({ workspaceId });
    await Promise.all(req.body.items.map(async (item) => {
        try {
            await validateItemBelongsToTenant(workspaceId, boardId, item.id);
            await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

            const [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues] = await getQuoteNDISReferencedItems(workspaceId, boardId, item.id);
            if (!serviceAreaValues) throw new Error("Service Area value is required.");

            const templatePath = path.join(__dirname, '..', 'assets', `NDISquote.json`);
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


            const NDISQuoteValues = item.values;
            
            let gst = "0%";
            const gstLabel = "GST Free";
            const issueDate = NDISQuoteValues['Issue Date'] ? NDISQuoteValues['Issue Date'].replace('Z', '') : "";
            const expiryDate = NDISQuoteValues['Expiry Date'] ? NDISQuoteValues['Expiry Date'].replace('Z', '') : "";
            const fromDate = NDISQuoteValues['From Date'] ? NDISQuoteValues['From Date'].replace('Z', '') : "";
            const toDate = NDISQuoteValues['To Date'] ? NDISQuoteValues['To Date'].replace('Z', '') : "";
            const daysOfWeek = Array.isArray(NDISQuoteValues["Days of the Week"]) && NDISQuoteValues["Days of the Week"].length > 0 ? NDISQuoteValues["Days of the Week"].join(', ') : " ";
            let ordersArr = [];
            let subTotal = 0;
            
            const clientDetails = {
                Address: NDISQuoteValues['Recipient Address'] || ' ',
                Suburb: NDISQuoteValues['Suburb'] || ' ',
                State: NDISQuoteValues['State'] || ' ',
                Postcode: NDISQuoteValues['Postcode'] || ' ',
                Client: NDISQuoteValues['Recipient of the Quote'] || ' '
            };

            // 1. Direct Support
            if (directSupportValues && NDISQuoteValues['Quantity (Direct Support)'] && NDISQuoteValues['Unit Price for Direct Support($)']) {
                const desc = `${NDISQuoteValues['Direct Support Item Number'] || ''}${directSupportValues.itemName ? '-[' + directSupportValues.itemName + ']' : ''}`;
                const qty = Number(NDISQuoteValues['Quantity (Direct Support)']) || 0;
                const unitPrice = Number(NDISQuoteValues['Unit Price for Direct Support($)']) || 0;
                const amount = qty * unitPrice;
                ordersArr.push([
                    desc,
                    NDISQuoteValues['Unit (Direct Support)'] || '',
                    formatValue(qty),
                    formatValue(unitPrice),
                    gstLabel,
                    formatValue(amount)
                ]);
                subTotal += amount;
            }
            // 2. Provider Travel - Non-Labour Cost
            if (providerTravelValues && NDISQuoteValues['Quantity (Provider Travel)'] && NDISQuoteValues['Unit Price for Provider Travel($)']) {
                const desc = `${NDISQuoteValues['Provider Travel - Non-Labour Cost Item Number'] || ''}${providerTravelValues.itemName ? '-\[' + providerTravelValues.itemName + ']' : ''}`;
                const qty = Number(NDISQuoteValues['Quantity (Provider Travel)']) || 0;
                const unitPrice = Number(NDISQuoteValues['Unit Price for Provider Travel($)']) || 0;
                const amount = qty * unitPrice;
                ordersArr.push([
                    desc,
                    NDISQuoteValues['Unit (Provider Travel - Non-Labour Cost)'] || '',
                    formatValue(qty),
                    formatValue(unitPrice),
                    gstLabel,
                    formatValue(amount)
                ]);
                subTotal += amount;
            }
            // 3. Activity Based Transport
            if (activityBasedTransportValues && NDISQuoteValues['Quantity (Activity Based Transport)'] && NDISQuoteValues['Unit Price for Activity Based Transport($)']) {
                const desc = `${NDISQuoteValues['Activity Based Transport Item Number'] || ''}${activityBasedTransportValues.itemName ? '-\[' + activityBasedTransportValues.itemName + ']' : ''}`;
                const qty = Number(NDISQuoteValues['Quantity (Activity Based Transport)']) || 0;
                const unitPrice = Number(NDISQuoteValues['Unit Price for Activity Based Transport($)']) || 0;
                const amount = qty * unitPrice;
                ordersArr.push([
                    desc,
                    NDISQuoteValues['Unit (Activity Based Transport)'] || '',
                    formatValue(qty),
                    formatValue(unitPrice),
                    gstLabel,
                    formatValue(amount)
                ]);
                subTotal += amount;
            }
            // 4. Centre Capital Costs
            if (centreCapitalCostsValues && NDISQuoteValues['Quantity (Centre Capital Costs)'] && NDISQuoteValues['Unit Price for Centre Capital Costs($)']) {
                const desc = `${NDISQuoteValues['Centre Capital Costs Item'] || ''}${centreCapitalCostsValues.itemName ? '-[' + centreCapitalCostsValues.itemName + ']' : ''}`;
                const qty = Number(NDISQuoteValues['Quantity (Centre Capital Costs)']) || 0;
                const unitPrice = Number(NDISQuoteValues['Unit Price for Centre Capital Costs($)']) || 0;
                const amount = qty * unitPrice;
                ordersArr.push([
                    desc,
                    NDISQuoteValues['Unit (Centre Capital Costs)'] || '',
                    formatValue(qty),
                    formatValue(unitPrice),
                    gstLabel,
                    formatValue(amount)
                ]);
                subTotal += amount;
            }
            // 5. Provider Travel - Labour Travel Time Costs
            if (NDISQuoteValues['Provider Travel - Labour Travel Time Costs'] && NDISQuoteValues['Quantity (Labour Travel Time)']) {
                const desc = 'Provider Travel - Labour Travel Time Costs';
                const qty = Number(NDISQuoteValues['Quantity (Labour Travel Time)']) || 0;
                const unitPrice = Number(NDISQuoteValues['Unit Price for Labour Travel Time($)']) || 1;
                const amount = qty * unitPrice;
                ordersArr.push([
                    desc,
                    NDISQuoteValues['Unit (Labour Travel Time)'] || '',
                    formatValue(qty),
                    formatValue(unitPrice),
                    gstLabel,
                    formatValue(amount)
                ]);
                subTotal += amount;
            }
            // 6. Non-Face-to-Face Support
            if (NDISQuoteValues['Non-Face-to-Face Supports'] && NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) {
                const desc = `Non-Face-t-Face Support - ${NDISQuoteValues['Non-Face-to-Face Supports'] || ''}`;
                const qty = Number(NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) || 0;
                const unitPrice = Number(NDISQuoteValues['Unit Price for Non-Face-to-Face Support($)']) || 1;
                const amount = qty * unitPrice;
                ordersArr.push([
                    desc,
                    NDISQuoteValues['Unit (Non-Face-to-Face Support)'] || ' ',
                    formatValue(qty),
                    formatValue(unitPrice),
                    gstLabel,
                    formatValue(amount)
                ]);
                subTotal += amount;
            }
            // 7. Allowances
            if (NDISQuoteValues['Allowances'] && NDISQuoteValues['Allowances Amount($)']) {
                const desc = `Allowances - ${NDISQuoteValues['Allowances'] || ' '}`;
                const qty = 1;
                const unitPrice = Number(NDISQuoteValues['Allowances Amount($)']) || 0;
                const amount = unitPrice;
                ordersArr.push([
                    desc,
                    NDISQuoteValues['Unit (Allowances)'] || ' ',
                    formatValue(qty),
                    formatValue(unitPrice),
                    gstLabel,
                    formatValue(amount)
                ]);
                subTotal += amount;
            }

            const orders = JSON.stringify(ordersArr);
            subTotal = formatValue(subTotal);
            const gstTotal = formatValue((parseFloat(subTotal) * parseFloat(gst) / 100));
            const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

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
                            "Issue Date": issueDate && issueDate != "" ? new Date(issueDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                            "expiry Date": expiryDate && expiryDate != "" ? new Date(expiryDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
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
                        orders: orders,
                        termsInputs: JSON.stringify({
                            "Accounts Receivable Payment Terms": `${business.bankDetails.accountsReceivableTerms ? business.bankDetails.accountsReceivableTerms : ' '}`
                        }),
                        field17: JSON.stringify({
                            "From Date": fromDate && fromDate != "" ? new Date(fromDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                            "To Date": toDate && toDate != "" ? new Date(toDate).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }),
                            "Days of the week": daysOfWeek
                        })
                    }
                ],
                plugins: { text, image, line, table, multiVariableText }
            });

            const filename = `output/${workspaceId}/${boardId}/NDIS-quote/${quoteNumber + '-ISO+™-' + item.id}.pdf`;
            const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
            if (uploadResult['$metadata'].httpStatusCode === 200) {
                const fileUrl = await getS3FileUrl(filename);
                await setIntegrationMessage(workspaceId, boardId, item.id, `Your quote has been successfully created.\n Click <a href="${fileUrl}">here</a> to download.`);
                logAuditTrail({
                    workspaceId,
                    action: 'Generate PDF Quote',
                    detail: `Resource ID: ${item.id}, Link: ${fileUrl}`,
                    req
                });
                PDFLink.insertOne({ workspaceId: workspaceId, itemId: item.id, type: 'Quote', pdfLink: fileUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" });
                info('Webhook-Service', 'Successfully generating PDF for Quote', { link: fileUrl }, req);
                await setGeneratedField(workspaceId, boardId, item.id, `${quoteNumber} (ISO+™)`);
                res.status(200).json({ pdfUrl: fileUrl });
            } else {
                throw new Error('Upload of PDF failed, please provide correct information.');
            }
        } catch (err) {
            const errorMessage = (err && err.message) ? err.message : 'An unknown error occurred. Please contact support via ISO+™ Portal.';
            await setIntegrationMessage(workspaceId, boardId, item.id, 'Server error: ' + errorMessage);
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
        res.status(404).json({ message: 'File not found in ISO+™ Portal.' });
    }
});

export default router;
