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
import { isEmpty } from '../utils/helpers.js';
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
    const errorMessage = (err && err.message) ? err.message : 'Server error: An unknown error occurred. Please contact support via ISO+™ Portal.';
    await setIntegrationMessage(workspaceId, boardId, itemId, errorMessage);
    error('Webhook-Service', 'Server error', { message: errorMessage }, req);
    logAuditTrail({
        workspaceId,
        action,
        detail: `Resource ID: ${itemId}, Error: ${errorMessage}`,
        req
    });
    return res.status(200).json({ message: errorMessage });
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
    if (!isNaN(num)) {
      const factor = Math.pow(10, 2);
      const result = Math.round(num * factor) / factor;
  
      return result.toFixed(2);
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
    if (docType.toLowerCase().includes("ndis")) {
        await setIntegrationMessage(workspaceId, boardId, itemId, `Your ${docType} has been successfully created.\n`);
    } else {
        await setIntegrationMessage(workspaceId, boardId, itemId, `Your ${docType} has been successfully created.\n Click <a href="${fileUrl}">here</a> to download.`);
    }
    await setPDFLinkAttribute(workspaceId, boardId, itemId, fileUrl, docType);
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
                    business.documentNumbering.invoice.nextNumber += 1;
                    await business.save();
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
                    business.documentNumbering.purchaseOrder.nextNumber += 1;
                    await business.save();
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
                    business.documentNumbering.quote.nextNumber += 1;
                    await business.save();
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
                if (NDISQuoteValues['Quantity (Direct Support)'] && NDISQuoteValues['Unit Price for Direct Support($)']) {
                    const desc = `${NDISQuoteValues['Direct Support Item Number'] || ''}${directSupportValues && directSupportValues.itemName ? '-' + directSupportValues.itemName : ''}`;
                    const qty = Number(NDISQuoteValues['Quantity (Direct Support)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Direct Support($)']) || 0;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Direct Support',
                        NDISQuoteValues['Unit (Direct Support)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 2. Provider Travel - Non-Labour Cost
                if (NDISQuoteValues['Quantity (Provider Travel)'] && NDISQuoteValues['Unit Price for Provider Travel($)']) {
                    const desc = `${NDISQuoteValues['Provider Travel - Non-Labour Cost Item Number'] || ''}${providerTravelValues && providerTravelValues.itemName ? '-' + providerTravelValues.itemName : ''}`;
                    const qty = Number(NDISQuoteValues['Quantity (Provider Travel)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Provider Travel($)']) || 0;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Provider Travel - Non-Labour Cost',
                        NDISQuoteValues['Unit (Provider Travel - Non-Labour Cost)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 3. Activity Based Transport
                if (NDISQuoteValues['Quantity (Activity Based Transport)'] && NDISQuoteValues['Unit Price for Activity Based Transport($)']) {
                    const desc = `${NDISQuoteValues['Activity Based Transport Item Number'] || ''}${activityBasedTransportValues && activityBasedTransportValues.itemName ? '-' + activityBasedTransportValues.itemName : ''}`;
                    const qty = Number(NDISQuoteValues['Quantity (Activity Based Transport)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Activity Based Transport($)']) || 0;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Activity Based Transport',
                        NDISQuoteValues['Unit (Activity Based Transport)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 4. Centre Capital Costs
                if (NDISQuoteValues['Quantity (Centre Capital Costs)'] && NDISQuoteValues['Unit Price for Centre Capital Costs($)']) {
                    const desc = `${NDISQuoteValues['Centre Capital Costs Item'] || ''}${centreCapitalCostsValues && centreCapitalCostsValues.itemName ? '-' + centreCapitalCostsValues.itemName : ''}`;
                    const qty = Number(NDISQuoteValues['Quantity (Centre Capital Costs)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Centre Capital Costs($)']) || 0;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Centre Capital Costs',
                        NDISQuoteValues['Unit (Centre Capital Costs)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 5. Provider Travel - Labour Travel Time Costs
                if (NDISQuoteValues['Quantity (Labour Travel Time)']) {
                    const desc = 'Provider Travel - Labour Travel Time Costs' + (providerTravelLabourTravelTime && providerTravelLabourTravelTime.itemName ? '-' + providerTravelLabourTravelTime.itemName : '');
                    const qty = Number(NDISQuoteValues['Quantity (Labour Travel Time)']) || 0;
                    const unitPrice = Number(NDISQuoteValues['Unit Price for Labour Travel Time ($)']) || 1;
                    const amount = qty * unitPrice;
                    ordersArr.push([
                        desc || 'Provider Travel - Labour Travel Time Costs',
                        NDISQuoteValues['Unit (Labour Travel Time)'] || '',
                        formatValue(qty),
                        formatValue(unitPrice),
                        gstLabel,
                        formatValue(amount)
                    ]);
                    subTotal += amount;
                }
                // 6. Allowances
                if (NDISQuoteValues['Allowances'] && NDISQuoteValues['Allowances Amount($)']) {
                    const desc = isEmpty(NDISQuoteValues['Allowances']) ? 'Allowances' : `Allowances - ${NDISQuoteValues['Allowances']}`;
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
                // 7. Non-Face-to-Face Support
                if (NDISQuoteValues['Non-Face-to-Face Supports'] && NDISQuoteValues['Quantity (Non-Face-to-Face Support)']) {
                    const desc = isEmpty(NDISQuoteValues['Non-Face-to-Face Supports']) ? 'Non-Face-to-Face Support' : `Non-Face-to-Face Support - ${NDISQuoteValues['Non-Face-to-Face Supports']}`;
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
                    business.documentNumbering.quote.nextNumber += 1;
                    await business.save();
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

                const invoiceValues = item.values;
                const invoiceDate = invoiceValues["Invoice Date"] ? invoiceValues["Invoice Date"].replace('Z', '') : "";
                const dueDate = invoiceValues["Due Date"] ? invoiceValues["Due Date"].replace('Z', '') : "";

                let ordersArr = [];
                let subTotal = 0;
                const groupSize = Number(invoiceValues['Group Size']) || 1;
                const gst = "0%";
                const gstLabel = "GST Free";

                if (invoiceValues['Job Status'] !== 'Cancelled') {
                    // Line 1: Direct Support - Hour based
                    if (servicePlanValues?.directSupportUnit === "Hour(H)") {
                        const unitPrice1 = Number(servicePlanValues?.directSupportUnitPrice) / groupSize || 0;
                        const itemNumber1 = servicePlanValues?.directSupportItemNumber || '';
                        const itemName1 = servicePlanValues?.directSupportItemName || '';
                        const startTime1 = invoiceValues["Actual Shift Start Date and Time"] ? new Date(invoiceValues["Actual Shift Start Date and Time"]).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                        const endTime1 = invoiceValues["Actual Shift End Date and Time"] ? new Date(invoiceValues["Actual Shift End Date and Time"]).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                        let qty1 = 0;
                        let actualShiftDuration1 = Number(invoiceValues["Actual Shift Duration(Hr.)"]);
                        if (typeof actualShiftDuration1 === 'number' && !isNaN(actualShiftDuration1)) {
                            qty1 = Number(actualShiftDuration1.toFixed(1));
                        }
                        const amountValue1 = formatValue(Number(invoiceValues["Direct Support Value($) - Time Based Support"])) || 0;
                        const amount1 = formatValue(qty1 * unitPrice1);

                        if (amountValue1 > 0) {
                            let desc1 = itemName1;
                            if (itemNumber1) {
                                desc1 += ` - ${itemNumber1}`;
                            }
                            if (startTime1 && endTime1) {
                                desc1 += ` - from ${startTime1} to ${endTime1}`;
                            }
                            if (desc1 == '') {
                                desc1 = 'Direct Support - Hour based';
                            }

                            if (parseFloat(formatValue(amountValue1)) != parseFloat(formatValue(amount1))) {
                                setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                                throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            }

                            ordersArr.push([
                                desc1,
                                servicePlanValues?.directSupportUnit || ' ',
                                formatValue(qty1),
                                formatValue(unitPrice1),
                                gstLabel,
                                formatValue(amount1)
                            ]);
                            subTotal += Number(amount1);
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
                        const amountValue2 = formatValue(Number(invoiceValues["Direct Support Value($) - Non Time Based Support"])) || 0;
                        const amount2 = formatValue(qty2 * unitPrice2);

                        if (amountValue2 > 0) {
                            let desc2 = itemName2;
                            if (itemNumber2) {
                                desc2 += ` - ${itemNumber2}`;
                            }
                            if (quantity2 && unit2) {
                                desc2 += ` - ${quantity2} ${unit2}`;
                            }
                            if (desc2 == '') {
                                desc2 = 'Direct Support - NOT Hour based';
                            }

                            if (parseFloat(formatValue(amountValue2)) != parseFloat(formatValue(amount2))) {
                                setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                                throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            }

                            ordersArr.push([
                                desc2,
                                unit2 || ' ',
                                formatValue(qty2),
                                formatValue(unitPrice2),
                                gstLabel,
                                formatValue(amount2)
                            ]);
                            subTotal += Number(amount2);
                        }
                    }

                    // Line 3: Provider Travel - Non-Labour Cost
                    const unitPrice3 = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
                    const mileage3 = invoiceValues["Provider Travel - Non-Labour - Mileage (kms) as per the Service Plan, if a Vehicle is Used."] || '';
                    const others3 = invoiceValues["Provider Travel - Non-Labour - as per the Service Plan, if other costs are applied."] || '';
                    const itemName3 = servicePlanValues?.providerTravelItemName || '';
                    const itemNumber3 = servicePlanValues?.providerTravelItemNumber || '';
                    const qty3 = Number(invoiceValues["Provider Travel - Non-Labour Cost Amount($)"]) || 0;
                    const amountValue3 = formatValue(Number(invoiceValues["Provider Travel - Non-Labour Cost Amount($)"]) * unitPrice3) || 0;
                    const amount3 = formatValue(qty3 * unitPrice3);

                    if (amountValue3 > 0) {
                        let desc3 = itemName3;
                        if (itemNumber3) {
                            desc3 += ` - ${itemNumber3}`;
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

                        if (parseFloat(formatValue(amountValue3)) != parseFloat(formatValue(amount3))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc3,
                            servicePlanValues?.nonLabourTravelUnit || ' ',
                            formatValue(qty3),
                            formatValue(unitPrice3),
                            gstLabel,
                            formatValue(amount3)
                        ]);
                        subTotal += Number(amount3);
                    }

                    // Line 4: Activity Based Transport
                    const unitPrice4 = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
                    const mileage4 = invoiceValues["Activity Base Transport Mileage(Kms) as per the Service Plan, if a Vehicle is Used."] || '';
                    const others4 = invoiceValues["Activity Base Transport Costs as per the Service Plan, if other costs are applied."] || '';
                    const itemName4 = servicePlanValues?.activityBasedTransportItemName || '';
                    const itemNumber4 = servicePlanValues?.activityBasedTransportItemNumber || '';
                    const qty4 = Number(invoiceValues["Activity Base Transport Amount($)"]) || 0;
                    const amountValue4 = formatValue(Number(invoiceValues["Activity Base Transport Amount($)"]) * unitPrice4) || 0;
                    const amount4 = formatValue(qty4 * unitPrice4);

                    if (amountValue4 > 0) {
                        let desc4 = itemName4;
                        if (itemNumber4) {
                            desc4 += ` - ${itemNumber4}`;
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

                        if (parseFloat(formatValue(amountValue4)) != parseFloat(formatValue(amount4))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc4,
                            servicePlanValues?.activityBasedTransportUnit || ' ',
                            formatValue(qty4),
                            formatValue(unitPrice4),
                            gstLabel,
                            formatValue(amount4)
                        ]);
                        subTotal += Number(amount4);
                    }

                    // Line 5: Centre Capital Costs
                    const unitPrice5 = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
                    const itemName5 = servicePlanValues?.centreCapitalCostsItemName || '';
                    const itemNumber5 = servicePlanValues?.centreCapitalCostsItemNumber || '';
                    let qty5 = 0;
                    let actualShiftDuration5 = Number(invoiceValues["Actual Shift Duration(Hr.)"]);
                    if (typeof actualShiftDuration5 === 'number' && !isNaN(actualShiftDuration5)) {
                        qty5 = Number(actualShiftDuration5.toFixed(1));
                    }
                    const amountValue5 = formatValue(Number(invoiceValues["Centre Capital Costs Amount($)"])) || 0;
                    const amount5 = formatValue(qty5 * unitPrice5);

                    if (amountValue5 > 0) {
                        let desc5 = itemName5;
                        if (itemNumber5) {
                            desc5 += ` - ${itemNumber5}`;
                        }
                        if (desc5 == '') {
                            desc5 = 'Centre Capital Costs Item';
                        }

                        if (parseFloat(formatValue(amountValue5)) != parseFloat(formatValue(amount5))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc5,
                            servicePlanValues?.centreCapitalCostsUnit || ' ',
                            formatValue(qty5),
                            formatValue(unitPrice5),
                            gstLabel,
                            formatValue(amount5)
                        ]);
                        subTotal += Number(amount5);
                    }

                    // Line 6: Labour Travel Time
                    const unitPrice6 = Number(servicePlanValues?.labourTravelTimeUnitPrice) || 0;
                    const qty6 = Number(invoiceValues["Labour Travel Time (Min.) as per the Service Plan, regarding the Time Cap, if applicable."]) || 0;
                    const amountValue6 = formatValue(Number(invoiceValues["Labour Travel Time Amount($)"])) || 0;
                    const amount6 = formatValue(qty6 * unitPrice6);

                    if (amountValue6 > 0) {
                        const desc6 = 'Provider Travel - Labour Travel Time Costs';

                        if (parseFloat(formatValue(amountValue6)) != parseFloat(formatValue(amount6))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc6,
                            servicePlanValues?.labourTravelTimeUnit || ' ',
                            formatValue(qty6),
                            formatValue(unitPrice6),
                            gstLabel,
                            formatValue(amount6)
                        ]);
                        subTotal += Number(amount6);
                    }

                    // Line 7: Allowances
                    const unitPrice7 = Number(invoiceValues['Used Allowance Amount($) as per the Service Plan']) || 0;
                    const qty7 = 1;
                    const amountValue7 = formatValue(Number(invoiceValues["Allowances Amount($)"])) || 0;
                    const amount7 = formatValue(unitPrice7);

                    if (amountValue7 > 0) {
                        const desc7 = `Allowances - ${invoiceValues["Allowances"]}`;

                        if (parseFloat(formatValue(amountValue7)) != parseFloat(formatValue(amount7))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc7,
                            servicePlanValues?.usedAllowanceUnit || ' ',
                            formatValue(qty7),
                            formatValue(unitPrice7),
                            gstLabel,
                            formatValue(amount7)
                        ]);
                        subTotal += Number(amount7);
                    }

                    // Line 8: Non-Face-to-Face Support
                    const unitPrice8 = Number(servicePlanValues?.nonFaceToFaceSupportUnitPrice) || 0;
                    const qty8 = Number(invoiceValues["Time spent in the Non-Face-to-Face Amount as per the Service Plan (Hr.)"]) || 0;
                    const amountValue8 = formatValue(Number(invoiceValues["Non-Face-to-Face Amount($)"])) || 0;
                    const amount8 = formatValue(qty8 * unitPrice8);

                    if (amountValue8 > 0) {
                        const desc8 = `Non-Face-to-Face Support - ${invoiceValues["Non-Face-to-Face Supports"]}`;

                        if (parseFloat(formatValue(amountValue8)) != parseFloat(formatValue(amount8))) {
                            setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                            throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        }

                        ordersArr.push([
                            desc8,
                            servicePlanValues?.nonFaceToFaceSupportUnit || ' ',
                            formatValue(qty8),
                            formatValue(unitPrice8),
                            gstLabel,
                            formatValue(amount8)
                        ]);
                        subTotal += Number(amount8);
                    }
                } else {
                    if (!cancellationTypeValues) {
                        setIntegrationMessage(workspaceId, boardId, item.id, "Cancellation Type Item not found");
                        throw new Error("Cancellation Type Item not found");
                    }
                    const cancellationPercentage1 = Number(cancellationTypeValues?.billableToClient) || 0;
                    const scheduledShiftDuration = (invoiceValues['Scheduled Shift Duration(Hr.)'] > 0)
                        ? Number(invoiceValues['Scheduled Shift Duration(Hr.)']).toFixed(1)
                        : 0;
                    let totalCancellationFee = 0;
                    const amountValue1 = formatValue(Number(invoiceValues["Cancellation Fee($)"])) || 0;
                    if (servicePlanValues.directSupportShortNoticeCancellations === 'Y') {
                        // Line 1: Direct Support - Hour based (Cancelled)
                        const baseUnitPrice1 = Number(servicePlanValues?.directSupportUnitPrice) / groupSize || 0;
                        const itemName1 = servicePlanValues?.directSupportItemName || '';
                        const itemNumber1 = servicePlanValues?.directSupportItemNumber || '';
                        let unitPrice1, amount1;
                        let qty1 = scheduledShiftDuration;
                        if (servicePlanValues?.directSupportUnit === "Hour(H)") {
                            unitPrice1 = Number((baseUnitPrice1 * (cancellationPercentage1 / 100)).toFixed(2));
                        } else {
                            const nonTimeBasedValue = Number(servicePlanValues?.directSupportUnitPrice) || 0;
                            unitPrice1 = Number((nonTimeBasedValue * (cancellationPercentage1 / 100)).toFixed(2));
                            qty1 = Number(invoiceValues["Quantity (Direct Support - Non Time Based Support)"]) || 0;
                        }

                        amount1 = formatValue(qty1 * unitPrice1);

                        if (amountValue1 > 0) {
                            let desc1 = 'Cancellation Fee';
                            if (itemName1) {
                                desc1 += ` - ${itemName1}`;
                            }
                            if (itemNumber1) {
                                desc1 += ` - ${itemNumber1}`;
                            }
                            desc1 += ` - ${cancellationPercentage1}%`;

                            ordersArr.push([
                                desc1,
                                servicePlanValues?.directSupportUnit || ' ',
                                formatValue(qty1),
                                formatValue(unitPrice1),
                                gstLabel,
                                formatValue(amount1)
                            ]);
                            subTotal += Number(amount1);
                            totalCancellationFee += Number(amount1);
                        }
                    }
                    if (servicePlanValues.providerTravelShortNoticeCancellations === 'Y') {
                        // Line 3: Provider Travel - Non-Labour Cost
                        const baseUnitPrice3 = Number(servicePlanValues?.nonLabourTravelUnitPrice) || 0;
                        const itemName3 = servicePlanValues?.providerTravelItemName || '';
                        const itemNumber3 = servicePlanValues?.providerTravelItemNumber || '';
                        const qty3 = scheduledShiftDuration;
                        const unitPrice3 = Number((baseUnitPrice3 * (cancellationPercentage1 / 100)).toFixed(2));
                        const amount3 = formatValue(qty3 * unitPrice3);

                        if (amount3 > 0) {
                            let desc3 = 'Cancellation Fee';
                            if (itemName3) {
                                desc3 += ` - ${itemName3}`;
                            }
                            if (itemNumber3) {
                                desc3 += ` - ${itemNumber3}`;
                            }
                            desc3 += ` - ${cancellationPercentage1}%`;

                            ordersArr.push([
                                desc3,
                                servicePlanValues?.nonLabourTravelUnit || ' ',
                                formatValue(qty3),
                                formatValue(unitPrice3),
                                gstLabel,
                                formatValue(amount3)
                            ]);
                            subTotal += Number(amount3);
                            totalCancellationFee += Number(amount3);
                        }
                    }
                    if (servicePlanValues.activityBasedTransportShortNoticeCancellations === 'Y') {
                        // Line 4: Activity Based Transport
                        const baseUnitPrice4 = Number(servicePlanValues?.activityBasedTransportUnitPrice) || 0;
                        const itemName4 = servicePlanValues?.activityBasedTransportItemName || '';
                        const itemNumber4 = servicePlanValues?.activityBasedTransportItemNumber || '';
                        const qty4 = scheduledShiftDuration;
                        const unitPrice4 = Number((baseUnitPrice4 * (cancellationPercentage1 / 100)).toFixed(2));
                        const amount4 = formatValue(qty4 * unitPrice4);
                        if (amount4 > 0) {
                            let desc4 = 'Cancellation Fee';
                            if (itemName4) {
                                desc4 += ` - ${itemName4}`;
                            }
                            if (itemNumber4) {
                                desc4 += ` - ${itemNumber4}`;
                            }
                            desc4 += ` - ${cancellationPercentage1}%`;

                            ordersArr.push([
                                desc4,
                                servicePlanValues?.activityBasedTransportUnit || ' ',
                                formatValue(qty4),
                                formatValue(unitPrice4),
                                gstLabel,
                                formatValue(amount4)
                            ]);
                            subTotal += Number(amount4);
                            totalCancellationFee += Number(amount4);
                        }
                    }
                    if (servicePlanValues.centreCapitalCostsShortNoticeCancellations === 'Y') {
                        // Line 5: Centre Capital Costs
                        const baseUnitPrice5 = Number(servicePlanValues?.centreCapitalCostsUnitPrice) || 0;
                        const itemName5 = servicePlanValues?.centreCapitalCostsItemName || '';
                        const itemNumber5 = servicePlanValues?.centreCapitalCostsItemNumber || '';
                        let qty5 = scheduledShiftDuration;
                        const unitPrice5 = Number((baseUnitPrice5 * (cancellationPercentage1 / 100)).toFixed(2));
                        const amount5 = formatValue(qty5 * unitPrice5);
                        if (baseUnitPrice5 > 0 && amount5 > 0) {
                            let desc5 = 'Cancellation Fee';
                            if (itemName5) {
                                desc5 += ` - ${itemName5}`;
                            }
                            if (itemNumber5) {
                                desc5 += ` - ${itemNumber5}`;
                            }
                            desc5 += ` - ${cancellationPercentage1}%`;
                            
                            ordersArr.push([
                                desc5,
                                servicePlanValues?.centreCapitalCostsUnit || ' ',
                                formatValue(qty5),
                                formatValue(unitPrice5),
                                gstLabel,
                                formatValue(amount5)
                            ]);
                            subTotal += Number(amount5);
                            totalCancellationFee += Number(amount5);
                        }
                    }
                    if (parseFloat(formatValue(amountValue1)) != parseFloat(formatValue(totalCancellationFee))) {
                        setIntegrationMessage(workspaceId, boardId, item.id, "Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                        throw new Error("Before creating the invoice, please enter the values or click the automatic calculation button and wait for the amounts to be generated.");
                    }
                }

                if (ordersArr.length === 0) {
                    await setIntegrationMessage(workspaceId, boardId, item.id, "There is nothing to invoice!");
                    return res.status(200).json({ message: "There is nothing to invoice!" });
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
                    business.documentNumbering.invoice.nextNumber += 1;
                    await business.save();
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
