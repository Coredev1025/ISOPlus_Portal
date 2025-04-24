import express from 'express';
import { info, error } from '../utils/logger.js';
import fs from 'fs/promises';
import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';
import path from 'path';
import { fileURLToPath } from 'url';
import AuditTrail from '../models/AuditTrail.js';
import Business from '../models/Business.js';
import PDFLink from '../models/PDFLink.js';
import { getS3FileUrl, uploadFileToS3 } from '../utils/uploadS3.js';
import { getFolder, getItem, putInternalMessage } from '../services/isoplus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

router.post('/:workspaceId/:boardId/invoice', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (req.body.items.length) {
        const business = await Business.findOne({ workspaceId });
        req.body.items?.map(async (item) => {
            try {
                putInternalMessage(workspaceId, boardId, item.id, "Running...");
                const templatePath = path.join(__dirname, '..', 'assets', `invoice.json`);
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 7);

                const logoKey = business.defaultLogo;
                let logoUrl = '';
                if (logoKey) {
                    logoUrl = await getS3FileUrl(logoKey);
                    if (!logoUrl) {
                        throw new Error('Failed to retrieve logo from S3');
                    }
                }

                let logoBase64 = '';
                if (logoUrl) {
                    const response = await fetch(logoUrl);
                    if (!response.ok) {
                        throw new Error('Failed to fetch logo from URL');
                    }
                    const buffer = await response.arrayBuffer();
                    const type = business.defaultLogo.split('.').pop();
                    logoBase64 = `data:image/${type};base64,${Buffer.from(buffer).toString('base64')}`;
                }

                const invoiceNumber = business.documentNumbering.invoice.prefix + business.documentNumbering.invoice.nextNumber;
                business.documentNumbering.invoice.nextNumber += 1;
                await business.save();
                let invoiceDescription = item.values["Undertaken Tasks Decription"].replace(/<.*?>/g, "");

                let jobPlan = [], clients = [], serviceFee = [], materialFee = [], folderIds = [], subTotal = 0, gstTotal = 0, total = 0;
                const result = await getFolder(workspaceId, boardId);
                if (result.status === 200) folderIds = result.folder;

                for (const folder of folderIds) {
                    if (folder.name.includes("Job Planning")) {
                        const result = await getItem(workspaceId, boardId, folder.id);
                        if (result.status === 200) jobPlan = result.item;
                    } else if (folder.name.includes("Clients")) {
                        const result = await getItem(workspaceId, boardId, folder.id);
                        if (result.status === 200) clients = result.item;
                    } else if (folder.name.includes("Service Fees")) {
                        const result = await getItem(workspaceId, boardId, folder.id);
                        if (result.status === 200) serviceFee = result.item;
                    } else if (item.values["Payable Material Fee($) - GST Excl."] > 0 && folder.name.includes("Material Fees")) {
                        const result = await getItem(workspaceId, boardId, folder.id);
                        if (result.status === 200) materialFee = result.item;
                    }
                }

                let clientName = "", jobTitle = "", clientDetailInfo;

                for (const job of jobPlan) {
                    const jobNumberAttribute = job.values.find(attr => attr.attribute.name === "Job Number");
                    const clientNameAttribute = job.values.find(attr => attr.attribute.name === "Client");
                    const jobTitleAttribute = job.values.find(attr => attr.attribute.name === "Job Title");

                    if (jobNumberAttribute && jobNumberAttribute.data === item.values["Job Number"][0]) {
                        clientName = clientNameAttribute.data[0];
                        jobTitle = jobTitleAttribute.data[0];
                    }
                }

                if (!clientName) {
                    throw new Error('Job Number not found for the given job number');
                }

                for (const client of clients) {
                    if (client.id == clientName) {
                        clientDetailInfo = client;
                    }
                }

                if (!clientDetailInfo) {
                    throw new Error('Client not found for the given client name');
                }

                const clientDetails = {
                    Address: "",
                    Suburb: "",
                    State: "",
                    Postcode: "",
                    Client: ""
                };

                for (const key of Object.keys(clientDetails)) {
                    const attr = clientDetailInfo.values.find(item => item.attribute.name === key);
                    if (attr) {
                        if (attr.attribute.type == 'label') {
                            const label = attr.attribute.settings.labels.find(item => item.id === attr.data[0]);
                            clientDetails[key] = label.name;
                        } else
                            clientDetails[key] = attr.data;
                    }
                }

                const service = serviceFee.find(service => service.values[0].data === item.values["Service Fee Type"][0]);
                const material = materialFee.find(material => material.values[1].data === item.values["Used Materials/Parts"][0]);

                invoiceDescription = `[["${jobTitle}-${item.values["Service Fee Type"]}-${item.values["Job Duration (Hrs.)"]}Hrs.", "${item.values["Job Duration (Hrs.)"]}", "${service.values[1].data}", "${item.values["GST"]}", "${parseFloat(item.values["Job Duration (Hrs.)"]) * parseFloat(service.values[1].data)}"]`;
                subTotal += parseFloat(item.values["Job Duration (Hrs.)"]) * parseFloat(service.values[1].data);
                if (item.values["Payable Material Fee($) - GST Excl."] > 0) {
                    invoiceDescription += `,["Used Material/Part", "1", "${material.values[2].data}", "${item.values["GST"]}", "${parseFloat(material.values[2].data)}"]`;
                    subTotal += parseFloat(material.values[2].data);
                }

                if (item.values["Other Payable Fee($) - GST Excl."] > 0) {
                    invoiceDescription += `,["Other Payable Fee", "1", "${item.values["Other Payable Fee($) - GST Excl."]}", "${item.values["GST"]}", "${parseFloat(item.values["Other Payable Fee($) - GST Excl."])}"]`;
                    subTotal += parseFloat(item.values["Other Payable Fee($) - GST Excl."]);
                }

                invoiceDescription += "]";
                gstTotal = subTotal * parseFloat(item.values["GST"]) / 100;
                total = subTotal + gstTotal;

                const pdfBytes = await generate({
                    template: template,
                    inputs: [
                        {
                            logo: logoBase64,
                            subtotal: `${subTotal}`,
                            totalGST: `${gstTotal}`,
                            total: `${total}`,
                            clientDetails: `{"Address":"${clientDetails.Address}","Suburb":"${clientDetails.Suburb}","State":"${clientDetails.State}","Postcode":"${clientDetails.Postcode}","Client":"${clientDetails.Client}"}`,
                            invoiceDetails: `{"Date":"${new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}","Invoice Number":"${invoiceNumber}"}`,
                            companyName: `{"Company Name":"${business.name}"}`,
                            companyDetails: `{"ABN":"${business.abn}","Street Address":"${business.address.street}","Suburb":"${business.address.suburb}","State":"${business.address.state}","Postcode":"${business.address.postcode}","Country":"${business.address.country}"}`,
                            orders: invoiceDescription,
                            "Due date": `${dueDate.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}`,
                            "Bank Details": `{"Account Name":"${business.bankDetails.accountName}","Bank Name":"${business.bankDetails.bankName}","BSB":"${business.bankDetails.bsb}","Account Number":"${business.bankDetails.accountNumber}","invoice Number":"${business.bankDetails.paymentReference}"}`
                        }
                    ],
                    plugins: {
                        text,
                        image,
                        line,
                        table,
                        multiVariableText
                    }
                });

                const filename = `output/${workspaceId}/${boardId}/invoices/${item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename, 7 * 24 * 60 * 60); // 7 days expiration
                    const expiryDate = new Date(Date.now() + 604800000); // 7 days in milliseconds
                    putInternalMessage(workspaceId, boardId, item.id, `Your invoice successfully created. \n Click <a href="${fileUrl}">here</a> \n This is a temporary link and will expire on ${expiryDate.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}. Make sure to download the file before expiry.`);
                    AuditTrail.insertOne({ workspaceId: workspaceId, action: 'Generate new PDF Link', detail: `Resourse ID: ${item.id}`, userEmail: "", userIp: req.ip?.split(':').pop() });
                    PDFLink.insertOne({ workspaceId: workspaceId, itemId: item.id, type: 'Invoice', pdfLink: fileUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" });
                    info('Webhook-Service', 'Successfully generating PDF invoice', { link: fileUrl }, req);

                    res.json({ pdfUrl: fileUrl });
                } else {
                    throw new Error('Upload PDF failed, please provide correct information');
                }
            } catch (err) {
                const errorMessage = (err && err.message) ? err.message : 'An unknown error occurred. Please contact admin';
                putInternalMessage(workspaceId, boardId, item.id, 'Server error: ' + errorMessage);
                error('Webhook-Service', 'Server error', { message: errorMessage }, req);
                res.status(200).json({ message: 'Server error: ' + errorMessage });
            }
        });
    } else {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, req);
        res.status(200).json({ message: 'Server error' });
    }

});

router.post('/:workspaceId/:boardId/purchaseorder', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (req.body.items.length) {
        const business = await Business.findOne({ workspaceId });
        req.body.items?.map(async (item, index) => {
            try {
                putInternalMessage(workspaceId, boardId, item.id, "Running...");

                const purchaseOrderValues = item.values;
                const templatePath = path.join(__dirname, '..', 'assets', `purchaseOrder.json`);
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 7);

                const logoKey = business.defaultLogo;
                let logoUrl = '';
                if (logoKey) {
                    logoUrl = await getS3FileUrl(logoKey);
                    if (!logoUrl) {
                        throw new Error('Failed to retrieve logo from S3');
                    }
                }

                let logoBase64 = '';
                if (logoUrl) {
                    const response = await fetch(logoUrl);
                    if (!response.ok) {
                        throw new Error('Failed to fetch logo from URL');
                    }
                    const buffer = await response.arrayBuffer();
                    logoBase64 = `data:${response.headers['content-type']};base64,${Buffer.from(buffer).toString('base64')}`;
                }

                const purchaseOrderNumber = business.documentNumbering.purchaseOrder.prefix + business.documentNumbering.purchaseOrder.nextNumber;
                business.documentNumbering.purchaseOrder.nextNumber += 1;
                business.save();

                let folderIds = [], contractor = [], clients = [], subTotal = 0, gstTotal = 0, total = 0;;
                const result = await getFolder(workspaceId, boardId);
                if (result.status === 200) folderIds = result.folder;

                for (const folder of folderIds) {
                    if (folder.name.includes("Contractor")) {
                        const result = await getItem(workspaceId, boardId, folder.id);
                        if (result.status === 200) contractor = result.item;
                    } else if (folder.name.includes("Clients")) {
                        const result = await getItem(workspaceId, boardId, folder.id);
                        if (result.status === 200) clients = result.item;
                    }
                }

                let contractorReference = {
                    Contractor: "",
                    ContactPersonsFirstName: "",
                    ContactPersonsLastName: "",
                    Address: "",
                    Suburb: "",
                    State: "",
                    Postcode: "",
                    PhoneNumber: ""
                }, clientDetails = {
                    Address: "",
                    Suburb: "",
                    State: "",
                    Postcode: "",
                    Client: ""
                }, clientDetailInfo;

                for (const con of contractor) {

                    const attrContractor = con.values.find(item => item.attribute.name === "Contractor");
                    const attrContactPersonsFirstName = con.values.find(item => item.attribute.name === "Contact Person's First Name");
                    const attrContactPersonsLastName = con.values.find(item => item.attribute.name === "Contact Person's Last Name");
                    const attrAddress = con.values.find(item => item.attribute.name === "Address");
                    const attrSuburb = con.values.find(item => item.attribute.name === "Suburb");
                    const attrState = con.values.find(item => item.attribute.name === "State");
                    const attrPostcode = con.values.find(item => item.attribute.name === "Postcode");
                    const attrPhoneNumber = con.values.find(item => item.attribute.name === "Phone Number");

                    if (attrContractor && attrContractor.data === item.values["Contractor"][0]) {
                        const stateLabel = attrState.attribute.settings.labels.find(item => item.id === attrState.data[0]);

                        contractorReference = {
                            Contractor: attrContractor.data,
                            ContactPersonsFirstName: attrContactPersonsFirstName.data,
                            ContactPersonsLastName: attrContactPersonsLastName.data,
                            Address: attrAddress.data,
                            Suburb: attrSuburb.data,
                            State: stateLabel.name,
                            Postcode: attrPostcode.data,
                            PhoneNumber: attrPhoneNumber.data
                        };
                        break;
                    }
                }

                if (!contractorReference.Contractor) {
                    throw new Error('Contract not found for the given contract name');
                }

                for (const client of clients) {
                    const attrContactPersonsFirstName = client.values.find(item => item.attribute.name === "Contact Person's First Name");
                    const attrContactPersonsLastName = client.values.find(item => item.attribute.name === "Contact Person's Last Name");

                    if (attrContactPersonsFirstName.data == contractorReference.ContactPersonsFirstName && attrContactPersonsLastName.data == contractorReference.ContactPersonsLastName) {
                        clientDetailInfo = client;
                    }
                }

                if (!clientDetailInfo) {
                    throw new Error('Client not found for the given client name');
                }

                for (const key of Object.keys(clientDetails)) {
                    const attr = clientDetailInfo.values.find(item => item.attribute.name === key);
                    if (attr) {
                        if (attr.attribute.type == 'label') {
                            const label = attr.attribute.settings.labels.find(item => item.id === attr.data[0]);
                            clientDetails[key] = label.name;
                        } else
                            clientDetails[key] = attr.data;
                    }
                }

                subTotal += (purchaseOrderValues.Quantity || 1) * (purchaseOrderValues['Unit Price($) - GST Excl.'] || 1)
                gstTotal = subTotal * parseFloat(item.values["GST"]) / 100;
                total += subTotal + gstTotal;

                const inputs = {
                    logo: logoBase64,
                    subtotal: `${subTotal}`,
                    totalGST: `${gstTotal}`,
                    total: `${total}`,
                    clientDetails: `{"Address":"${clientDetails.Address}","Suburb":"${clientDetails.Suburb}","State":"${clientDetails.State}","Postcode":"${clientDetails.Postcode}","Supplier":"${clientDetails.Client}"}`,
                    companyDetails: `{"ABN":"${business.abn}","Street Address":"${business.address.street}","Suburb":"${business.address.suburb}","State":"${business.address.state}","Postcode":"${business.address.postcode}","Country":"${business.address.country}"}`,
                    quoteDetails: `{"Issue Date":"${purchaseOrderValues['Issue Date'] && new Date(purchaseOrderValues['Issue Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}","expiry Date":"${new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}","PO Number":"${purchaseOrderNumber || purchaseOrderValues['PO Number']}"}`,
                    companyName: `{"Company Name":"${business.name}"}`,
                    termsInput: `{"Delivery Date":"${purchaseOrderValues['Delivery Date'] && new Date(purchaseOrderValues['Delivery Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}","Delivery Address":"${contractorReference.Address} ${contractorReference.Suburb} ${contractorReference.State} ${contractorReference.Postcode}"}`,
                    orders: `[[
                        "${purchaseOrderValues['Job Title']}${purchaseOrderValues['Job Description'].replace(/<.*?>/g, "") ? ` - ${purchaseOrderValues['Job Description'].replace(/<.*?>/g, "")}` : ''}",
                        "${purchaseOrderValues.Quantity || 1}",
                        "${purchaseOrderValues['Unit Price($) - GST Excl.'] || 1}",
                        "${purchaseOrderValues['Total Price($) - GST Excl.'] || 1}", 
                        "${(purchaseOrderValues.Quantity || 1) * (purchaseOrderValues['Unit Price($) - GST Excl.'] || 1)}"
                    ]]`,
                };

                if (!purchaseOrderValues['Issue Date']) {
                    delete inputs.issueDate;
                }

                if (!purchaseOrderValues['Delivery Date']) {
                    delete inputs.deliveryDate;
                }

                if (!purchaseOrderValues['Delivery Date']) {
                    delete inputs.deliveryDate;
                }

                const pdfBytes = await generate({
                    template: template,
                    inputs: [inputs],
                    plugins: {
                        text,
                        image,
                        line,
                        table,
                        multiVariableText
                    }
                });

                const filename = `output/${workspaceId}/${boardId}/purchaseorder/${item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename, 7 * 24 * 60 * 60); // 7 days expiration
                    const expiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                    putInternalMessage(workspaceId, boardId, item.id, `Your purchase order successfully created. \n Click <a href="${fileUrl}">here</a> \n This is a temporary link and will expire on ${expiryDate.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}. Make sure to download the file before expiry.`);
                    AuditTrail.insertOne({ workspaceId: workspaceId, action: 'Generate new PDF Link', detail: `Resourse ID: ${item.id}`, userEmail: "", userIp: req.ip?.split(':').pop() });
                    PDFLink.insertOne({ workspaceId: workspaceId, itemId: item.id, type: 'Purchase Order', pdfLink: fileUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" });
                    info('Webhook-Service', 'Successfully generating PDF for Purchase Order', { link: fileUrl }, req);

                    res.json({ pdfUrl: fileUrl });
                } else {
                    throw new Error('Upload PDF failed, please provide correct information');
                }
            } catch (err) {
                const errorMessage = (err && err.message) ? err.message : 'An unknown error occurred. Please contact admin';
                putInternalMessage(workspaceId, boardId, item.id, 'Server error: ' + errorMessage);
                error('Webhook-Service', 'Server error', { message: errorMessage }, req);
                res.status(200).json({ message: 'Server error: ' + errorMessage });
            }
        });
    } else {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, req);
        res.status(200).json({ message: 'Server error' });
    }
});

router.post('/:workspaceId/:boardId/quote', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (req.body.items.length) {
        const business = await Business.findOne({ workspaceId });
        req.body.items?.map(async (item, index) => {
            try {
                putInternalMessage(workspaceId, boardId, item.id, "Running...");

                const quoteValues = item.values;
                const templatePath = path.join(__dirname, '..', 'assets', `quote.json`);
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);

                const logoKey = business.defaultLogo;
                let logoUrl = '';
                if (logoKey) {
                    logoUrl = await getS3FileUrl(logoKey);
                    if (!logoUrl) {
                        throw new Error('Failed to retrieve logo from S3');
                    }
                }

                let logoBase64 = '';
                if (logoUrl) {
                    const response = await fetch(logoUrl);
                    if (!response.ok) {
                        throw new Error('Failed to fetch logo from URL');
                    }
                    const buffer = await response.arrayBuffer();
                    logoBase64 = `data:${response.headers['content-type']};base64,${Buffer.from(buffer).toString('base64')}`;
                }

                const quoteNumber = business.documentNumbering.quote.prefix + business.documentNumbering.quote.nextNumber;
                business.documentNumbering.quote.nextNumber += 1;
                business.save();

                let clients = [], folderIds = [], clientDetailInfo, subTotal = 0, gstTotal = 0, total = 0;
                const result = await getFolder(workspaceId, boardId);
                if (result.status === 200) folderIds = result.folder;

                for (const folder of folderIds) {
                    if (folder.name.includes("Clients")) {
                        const result = await getItem(workspaceId, boardId, folder.id);
                        if (result.status === 200) clients = result.item;
                    }
                }

                for (const client of clients) {
                    const attrClient = client.values.find(attr => attr.attribute.name == "Client");

                    if (attrClient && attrClient.data == item.values.Client[0]) {
                        clientDetailInfo = client;
                        break;
                    }
                }

                if (!clientDetailInfo) {
                    throw new Error('Client not found for the given client name');
                }

                const clientDetails = {
                    Address: "",
                    Suburb: "",
                    State: "",
                    Postcode: "",
                    Client: ""
                };

                for (const key of Object.keys(clientDetails)) {
                    const attr = clientDetailInfo.values.find(item => item.attribute.name === key);
                    if (attr) {
                        if (attr.attribute.type == 'label') {
                            const label = attr.attribute.settings.labels.find(item => item.id === attr.data[0]);
                            clientDetails[key] = label.name;
                        } else
                            clientDetails[key] = attr.data;
                    }
                }

                subTotal += (quoteValues.Quantity || 1) * (quoteValues['Unit Price($) - GST Excl.'] || 1);
                gstTotal = subTotal * parseFloat(item.values["GST"]) / 100;
                total = subTotal + gstTotal;

                const pdfBytes = await generate({
                    template: template,
                    inputs: [
                        {
                            logo: logoBase64,
                            subtotal: `${subTotal}`,
                            totalGST: `${gstTotal}`,
                            total: `${total}`,
                            clientDetails: `{"Address":"${clientDetails.Address}","Suburb":"${clientDetails.Suburb}","State":"${clientDetails.State}","Postcode":"${clientDetails.Postcode}","Client":"${clientDetails.Client}"}`,
                            quoteDetails: `{"Issue Date":"${quoteValues['Issue Date'] ? new Date(quoteValues['Issue Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}","expiry Date":"${new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}","Quote Number":"${quoteNumber || quoteValues['Quote Number']}"}`,
                            companyName: `{"Company Name":"${business.name}"}`,
                            companyDetails: `{"ABN":"${business.abn}","Street Address":"${business.address.street}","Suburb":"${business.address.suburb}","State":"${business.address.state}","Postcode":"${business.address.postcode}","Country":"${business.address.country}"}`,
                            orders: `[["${quoteValues['Job Title']} - ${quoteValues['Job Description'].replace(/<.*?>/g, "")}","${quoteValues.Quantity || 1}","${quoteValues['Unit Price($) - GST Excl.'] || 1}", "${quoteValues['Total Price($) - GST Excl.'] || 1}", "${(quoteValues.Quantity || 1) * (quoteValues['Unit Price($) - GST Excl.'] || 1)}"]]`,
                        }
                    ],
                    plugins: {
                        text,
                        image,
                        line,
                        table,
                        multiVariableText
                    }
                });

                const filename = `output/${workspaceId}/${boardId}/quote/${item.id}.pdf`;
                const uploadResult = await uploadFileToS3(Buffer.from(pdfBytes), filename);
                if (uploadResult['$metadata'].httpStatusCode === 200) {
                    const fileUrl = await getS3FileUrl(filename, 7 * 24 * 60 * 60); // 7 days expiration
                    const expiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                    putInternalMessage(workspaceId, boardId, item.id, `Your quote successfully created. \n Click <a href="${fileUrl}">here</a> \n This is a temporary link and will expire on ${expiryDate.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}. Make sure to download the file before expiry.`);
                    AuditTrail.insertOne({ workspaceId: workspaceId, action: 'Generate new PDF Link', detail: `Resourse ID: ${item.id}`, userEmail: "", userIp: req.ip?.split(':').pop() });
                    PDFLink.insertOne({ workspaceId: workspaceId, itemId: item.id, type: 'Quote', pdfLink: fileUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" });
                    info('Webhook-Service', 'Successfully generating PDF for Quote', { link: fileUrl }, req);

                    res.json({ pdfUrl: fileUrl });
                } else {
                    throw new Error('Upload PDF failed, please provide correct information');
                }
            } catch (err) {
                const errorMessage = (err && err.message) ? err.message : 'An unknown error occurred. Please contact admin';
                putInternalMessage(workspaceId, boardId, item.id, 'Server error: ' + errorMessage);
                error('Webhook-Service', 'Server error', { message: errorMessage }, req);
                res.status(200).json({ message: 'Server error: ' + errorMessage });
            }
        });
    } else {
        error('Webhook-Service', 'Server error', { message: "There are no items." }, req);
        res.status(200).json({ message: 'Server error' });
    }
});

router.get('/uploads/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const key = `pdfs/${filename}`;

        // Get a signed URL for temporary access
        const fileUrl = await getS3FileUrl(S3_BUCKET, key);

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
