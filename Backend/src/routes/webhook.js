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
    setPDFLinkAttribute,
    getQuoteNDISReferencedItems,
    getMasterPlanReferencedItems
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
    await setIntegrationMessage(workspaceId, boardId, itemId, `Your ${docType} has been successfully created.\n Click <a href="${fileUrl}">here</a> to download.`);
    await setPDFLinkAttribute(workspaceId, boardId, itemId, fileUrl);
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
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);
        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues, providerTravelLabourTravelTime] = await getQuoteNDISReferencedItems(workspaceId, boardId, item.id);
                if (!serviceAreaValues) throw new Error("Service Area value is required.");

                const templatePath = path.join(__dirname, '..', 'assets', `NDISquote.json`);
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);

                const logoBase64 = await getLogoData(business);

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
                    const desc = `${NDISQuoteValues['Direct Support Item Number'] || ''}${directSupportValues.itemName ? '-' + directSupportValues.itemName : ''}`;
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
                    const desc = `${NDISQuoteValues['Provider Travel - Non-Labour Cost Item Number'] || ''}${providerTravelValues.itemName ? '-' + providerTravelValues.itemName : ''}`;
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
                    const desc = `${NDISQuoteValues['Activity Based Transport Item Number'] || ''}${activityBasedTransportValues.itemName ? '-' + activityBasedTransportValues.itemName : ''}`;
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
                    const desc = `${NDISQuoteValues['Centre Capital Costs Item'] || ''}${centreCapitalCostsValues.itemName ? '-' + centreCapitalCostsValues.itemName : ''}`;
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
                if (providerTravelLabourTravelTime && NDISQuoteValues['Quantity (Labour Travel Time)']) {
                    const desc = 'Provider Travel - Labour Travel Time Costs' + (providerTravelLabourTravelTime.itemName ? '-' + providerTravelLabourTravelTime.itemName : '');
                    const qty = Number(NDISQuoteValues['Quantity (Labour Travel Time)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Labour Travel Time ($)']) || 1;
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
                    const desc = `Non-Face-to-Face Support - ${NDISQuoteValues['Non-Face-to-Face Supports'] || ''}`;
                    const qty = Number(NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Non-Face-to-Face Support ($)']) || 1;
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
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'NDIS Quote', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${quoteNumber} (ISO+™)`);
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF NDIS Quote', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, req);
        return res.status(200).json({ message: err.message });
    }
});

router.post('/:workspaceId/:boardId/invoicendis', async (req, res) => {
    try {
        const { workspaceId, boardId } = validateRequestParams(req);
        const business = await getValidatedBusiness(workspaceId);

        await Promise.all(req.body.items.map(async (item) => {
            try {
                await validateItemBelongsToTenant(workspaceId, boardId, item.id);
                await setIntegrationMessage(workspaceId, boardId, item.id, "Running...");

                const [servicePlanValues, cancellationTypeValues, fundValues, participantProfileValues] = await getMasterPlanReferencedItems(workspaceId, boardId, item.id);
                if (!participantProfileValues || !servicePlanValues) {
                    throw new Error("Participant Profile and Service Plan information is required.");
                }

                const templatePath = path.join(__dirname, '..', 'assets', 'NDISinvoice.json');
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);

                const logoBase64 = await getLogoData(business);

                const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;
                business.documentNumbering.invoice.nextNumber += 1;
                await business.save();

                const invoiceValues = item.values;
                const invoiceDate = invoiceValues["Invoice Date"] ? invoiceValues["Invoice Date"].replace('Z', '') : "";
                const dueDate = invoiceValues["Due Date"] ? invoiceValues["Due Date"].replace('Z', '') : "";

                let ordersArr = [];
                let subTotal = 0;
                const gst = "0%";
                const gstLabel = "GST Free";

                // Line 1: Direct Support - Hour based
                if (servicePlanValues?.directSupportUnit === "Hour(H)") {
                    const unitPrice1 = Number(servicePlanValues?.directSupportUnitPrice) || 0;
                    const itemNumber1 = servicePlanValues?.directSupportItemNumber || '';
                    const itemName1 = servicePlanValues?.directSupportItemName || '';
                    const startTime1 = invoiceValues["Actual Shift Start Date and Time"] ? new Date(invoiceValues["Actual Shift Start Date and Time"]).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                    const endTime1 = invoiceValues["Actual Shift End Date and Time"] ? new Date(invoiceValues["Actual Shift End Date and Time"]).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                    const qty1 = Number(invoiceValues["Actual Shift Duration(Hr.)"]) || 0;
                    const amount1 = qty1 * unitPrice1;

                    if (unitPrice1 > 0 && amount1 > 0) {
                        let desc1 = itemNumber1;
                        if (itemName1) {
                            desc1 += ` - [${itemName1}]`;
                        }
                        if (startTime1 && endTime1) {
                            desc1 += ` - from ${startTime1} to ${endTime1}`;
                        }
                        if (desc1 == '') {
                            desc1 = 'Direct Support - Hour based';
                        }

                        ordersArr.push([
                            desc1,
                            servicePlanValues?.directSupportUnit || ' ',
                            formatValue(qty1),
                            formatValue(unitPrice1),
                            gstLabel,
                            formatValue(amount1)
                        ]);
                        subTotal += amount1;
                    }
                }

                // Line 2: Direct Support - Non Hour based
                if (servicePlanValues?.directSupportUnit !== "Hour(H)") {
                    const unitPrice2 = Number(servicePlanValues?.directSupportUnitPrice) || 0;
                    const itemNumber2 = servicePlanValues?.directSupportItemNumber || '';
                    const itemName2 = servicePlanValues?.directSupportItemName || '';
                    const quantity2 = invoiceValues["Quantity (Direct Support - Non Time Based Support)"] || 0;
                    const unit2 = servicePlanValues?.directSupportUnit || '';
                    const qty2 = Number(quantity2) || 0;
                    const amount2 = qty2 * unitPrice2;

                    if (unitPrice2 > 0 && amount2 > 0) {
                        let desc2 = itemNumber2;
                        if (itemName2) {
                            desc2 += ` - [${itemName2}]`;
                        }
                        if (quantity2 && unit2) {
                            desc2 += ` - ${quantity2} ${unit2}`;
                        }
                        if (desc2 == '') {
                            desc2 = 'Direct Support - NOT Hour based';
                        }

                        ordersArr.push([
                            desc2,
                            unit2 || ' ',
                            formatValue(qty2),
                            formatValue(unitPrice2),
                            gstLabel,
                            formatValue(amount2)
                        ]);
                        subTotal += amount2;
                    }
                }

                // Line 3: Provider Travel - Non-Labour Cost
                const unitPrice3 = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
                const mileage3 = invoiceValues["Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a Vehicle is Used."] || '';
                const others3 = invoiceValues["Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied."] || '';
                const itemName3 = servicePlanValues?.providerTravelItemName || '';
                const itemNumber3 = servicePlanValues?.providerTravelItemNumber || '';
                const qty3 = Number(invoiceValues["Provider Travel - Non-Labour Cost Amount($)"]) || 0;
                const amount3 = qty3 * unitPrice3;

                if (amount3 > 0) {
                    let desc3 = itemNumber3;
                    if (itemName3) {
                        desc3 += ` - [${itemName3}]`;
                    }
                    if (mileage3) {
                        desc3 += ` - ${mileage3}km`;
                    }
                    if (others3) {
                        desc3 += ` - Others: ${others3}`;
                    }
                    if (desc3 == '') {
                        desc3 = 'Provider Travel - Non-Labour Cost Item';
                    }

                    ordersArr.push([
                        desc3,
                        servicePlanValues?.nonLabourTravelUnit || ' ',
                        formatValue(qty3),
                        formatValue(unitPrice3),
                        gstLabel,
                        formatValue(amount3)
                    ]);
                    subTotal += amount3;
                }

                // Line 4: Activity Based Transport
                const unitPrice4 = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
                const mileage4 = invoiceValues["Activity Base Transport Mileage(Kms) as per the Service Plan, if a Vehicle is Used."] || '';
                const others4 = invoiceValues["Activity Base Transport Costs as per the Service Plan, if other costs are applied."] || '';
                const itemName4 = servicePlanValues?.activityBasedTransportItemName || '';
                const itemNumber4 = servicePlanValues?.activityBasedTransportItemNumber || '';
                const qty4 = Number(invoiceValues["Activity Base Transport Amount($)"]) || 0;
                const amount4 = qty4 * unitPrice4;

                if (amount4 > 0) {
                    let desc4 = itemNumber4;
                    if (itemName4) {
                        desc4 += ` - [${itemName4}]`;
                    }
                    if (mileage4) {
                        desc4 += ` - ${mileage4}km`;
                    }
                    if (others4) {
                        desc4 += ` - Others: ${others4}`;
                    }
                    if (desc4 == '') {
                        desc4 = 'Activity Based Transport Item';
                    }

                    ordersArr.push([
                        desc4,
                        servicePlanValues?.activityBasedTransportUnit || ' ',
                        formatValue(qty4),
                        formatValue(unitPrice4),
                        gstLabel,
                        formatValue(amount4)
                    ]);
                    subTotal += amount4;
                }

                // Line 5: Centre Capital Costs
                const unitPrice5 = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
                const itemName5 = servicePlanValues?.centreCapitalCostsItemName || '';
                const itemNumber5 = servicePlanValues?.centreCapitalCostsItemNumber || '';
                const qty5 = Number(invoiceValues["Actual Shift Duration(Hr.)"]) || 0;
                const amount5 = qty5 * unitPrice5;

                if (unitPrice5 > 0 && amount5 > 0) {
                    let desc5 = itemNumber5;
                    if (itemName5) {
                        desc5 += ` - [${itemName5}]`;
                    }
                    if (desc5 == '') {
                        desc5 = 'Centre Capital Costs Item';
                    }

                    ordersArr.push([
                        desc5,
                        servicePlanValues?.centreCapitalCostsUnit || ' ',
                        formatValue(qty5),
                        formatValue(unitPrice5),
                        gstLabel,
                        formatValue(amount5)
                    ]);
                    subTotal += amount5;
                }

                // Line 6: Labour Travel Time
                const unitPrice6 = Number(servicePlanValues?.labourTravelTimeUnitPrice) || 0;
                const qty6 = Number(invoiceValues["Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable."]) || 0;
                const amount6 = qty6 * unitPrice6;

                if (unitPrice6 > 0 && amount6 > 0) {
                    const desc6 = 'Provider Travel - Labour Travel Time Costs';
                    ordersArr.push([
                        desc6,
                        servicePlanValues?.labourTravelTimeUnit || ' ',
                        formatValue(qty6),
                        formatValue(unitPrice6),
                        gstLabel,
                        formatValue(amount6)
                    ]);
                    subTotal += amount6;
                }

                // Line 7: Allowances
                const unitPrice7 = Number(servicePlanValues?.usedAllowanceAmount) || 0;
                const qty7 = 1;
                const amount7 = unitPrice7;

                if (unitPrice7 > 0) {
                    const desc7 = `Allowances - ${invoiceValues["Allowances"]}`;
                    ordersArr.push([
                        desc7,
                        servicePlanValues?.usedAllowanceUnit || ' ',
                        formatValue(qty7),
                        formatValue(unitPrice7),
                        gstLabel,
                        formatValue(amount7)
                    ]);
                    subTotal += amount7;
                }

                // Line 8: Non-Face-to-Face Support
                const unitPrice8 = Number(servicePlanValues?.nonFaceToFaceSupportUnitPrice) || 0;
                const qty8 = Number(invoiceValues["Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)"]) || 0;
                const amount8 = qty8 * unitPrice8;

                if (unitPrice8 > 0 && amount8 > 0) {
                    const desc8 = `Non-Face-to-Face Support - ${invoiceValues["Non-Face-to-Face Supports"]}`;
                    ordersArr.push([
                        desc8,
                        servicePlanValues?.nonFaceToFaceSupportUnit || ' ',
                        formatValue(qty8),
                        formatValue(unitPrice8),
                        gstLabel,
                        formatValue(amount8)
                    ]);
                    subTotal += amount8;
                }

                // Line 9: Cancellation Fee
                const baseUnitPrice9 = Number(servicePlanValues?.directSupportUnitPrice) || 0;
                const cancellationPercentage9 = Number(cancellationTypeValues?.billableToClient) || 0;
                const itemName9 = servicePlanValues?.directSupportItemName || '';
                const itemNumber9 = servicePlanValues?.directSupportItemNumber || '';
                const qty9 = Number(invoiceValues["Actual Shift Duration(Hr.)"]) || 0;
                const unitPrice9 = baseUnitPrice9 * (cancellationPercentage9 / 100);
                const amount9 = qty9 * unitPrice9;

                if (baseUnitPrice9 > 0 && amount9 > 0) {
                    let desc9 = 'Cancellation Fee' + `${itemNumber9 ? ' - ' + itemNumber9 : ''}`;
                    if (itemName9) {
                        desc9 += ` - [${itemName9}]`;
                    }

                    ordersArr.push([
                        desc9,
                        servicePlanValues?.directSupportUnit || ' ',
                        formatValue(qty9),
                        formatValue(unitPrice9),
                        gstLabel,
                        formatValue(amount9)
                    ]);
                    subTotal += amount9;
                }

                const orders = JSON.stringify(ordersArr);
                subTotal = formatValue(subTotal);
                const gstTotal = formatValue((parseFloat(subTotal) * parseFloat(gst) / 100));
                const total = formatValue(parseFloat(subTotal) + parseFloat(gstTotal));

                const clientDetails = {
                    Contact: participantProfileValues.billingContact || ' ',
                    Address: participantProfileValues.billingAddress || ' '
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
                            orders: orders,
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

                const filename = `output/${workspaceId}/${boardId}/NDIS-invoices/${invoiceNumber + '-ISO+™-' + item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);

                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename);
                    await handlePDFSuccess(workspaceId, boardId, item.id, fileUrl, 'NDIS Invoice', req, res);
                    await setGeneratedField(workspaceId, boardId, item.id, `${invoiceNumber} (ISO+™)`);
                } else {
                    throw new Error('Upload of PDF failed, please provide correct information.');
                }
            } catch (err) {
                await handlePDFError(err, workspaceId, boardId, item.id, 'Generate PDF NDIS Invoice', req, res);
            }
        }));
    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, req);
        return res.status(200).json({ message: err.message });
    }
});

router.get('/uploads/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const key = `pdfs/${filename}`;

        const fileUrl = await getS3FileUrl(key, 604800, true);

        if (fileUrl) {
            res.redirect(fileUrl);
        } else {
            throw new Error('Invalid file URL');
        }
    } catch (err) {
        error('Webhook-Service', 'Error downloading file', { message: err.message }, req);
        res.status(404).json({ message: 'File not found in ISO+™ Portal.' });
    }
});

export default router;
