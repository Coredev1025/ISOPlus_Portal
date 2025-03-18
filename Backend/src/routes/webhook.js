import express from 'express';
import { info, error } from '../utils/logger.js';
import fs from 'fs/promises';
import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from "axios";
import AuditTrail from '../models/AuditTrail.js';
import Business from '../models/Business.js';
import { getS3FileUrl, deleteFileFromS3, uploadFileToS3 } from '../utils/uploadS3.js';
import { getFolder, getItem, putInternalMessage } from '../utils/isoplusservices.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const router = express.Router();

router.post('/:workspaceId/:boardId/invoice', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (req.body.items.length) {
        try {
            const business = await Business.findOne({ workspaceId });
            req.body.items?.map(async (item, index) => {
                putInternalMessage(workspaceId, boardId, item.id, "Running...");
                const templatePath = path.join(__dirname, '..', 'assets', `invoice.json`);
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 7);

                const invoiceCnt = await AuditTrail.find({ workspaceId: workspaceId, action: 'Generate new PDF Link' }).countDocuments();
                const invoiceNumber = "INV-" + invoiceCnt.toString();
                let invoiceDescription = item.values["Undertaken Tasks Decription"].replace(/<.*?>/g, "");

                let jobPlan = [], clients = [], serviceFee = [], materialFee = [];
                const folderIds = await getFolder(workspaceId, boardId);

                for (const folder of folderIds.data) {
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

                invoiceDescription = `[["1", "${jobTitle}-${item.values["Service Fee Type"]}-${item.values["Job Duration (Hrs.)"]}Hrs.", "${item.values["Job Duration (Hrs.)"]}", "${service.values[1].data}", "${item.values["Payable Service Fee($) - GST Excl."]}", "${(parseFloat(item.values["Job Duration (Hrs.)"])) * (parseFloat(service.values[1].data))}"]`;

                if (item.values["Payable Material Fee($) - GST Excl."] > 0) {
                    invoiceDescription += `,["2", "Used Material/Part", "1", "${material.values[2].data}", "${item.values["Payable Material Fee($) - GST Excl."]}", "${material.values[2].data}"]`;
                }

                if (item.values["Other Payable Fee($) - GST Excl."] > 0) {
                    if (item.values["Payable Material Fee($) - GST Excl."] > 0) {
                        invoiceDescription += `,["3", "Other Payable Fee", "1", "${item.values["Other Payable Fee($) - GST Excl."]}", "${item.values["Other Payable Fee($) - GST Excl."]}", "${item.values["Other Payable Fee($) - GST Excl."]}"]`;
                    } else {
                        invoiceDescription += `,["2", "Other Payable Fee", "1", "${item.values["Other Payable Fee($) - GST Excl."]}", "${item.values["Other Payable Fee($) - GST Excl."]}", "${item.values["Other Payable Fee($) - GST Excl."]}"]`;
                    }
                }

                invoiceDescription += "]";

                const pdfBytes = await generate({
                    template: template,
                    inputs: [
                        {
                            clientDetails: `{"Address":"${clientDetails.Address}","Suburb":"${clientDetails.Suburb}","State":"${clientDetails.State}","Postcode":"${clientDetails.Postcode}","Client":"${clientDetails.Client}"}`,
                            invoiceDetails: `{"Date":"${new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}","Invoice Number":"${invoiceNumber}"}`,
                            companyName: `{"Company Name":"${business.name}"}`,
                            companyDetails: `{"ABN":"${business.abn}","Street Address":"${business.address.street}","Suburb":"${business.address.suburb}","State":"${business.address.state}","Postcode":"${business.address.postcode}","Country":"${business.address.country}"}`,
                            orders: invoiceDescription,
                            dueDate: `{"Date":"${dueDate.toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}"}`,
                            bankDetails: `{"Account Name":"${business.bankDetails.accountName}","Bank Name":"${business.bankDetails.bankName}","BSB":"${business.bankDetails.bsb}","Account Number":"${business.bankDetails.accountNumber}","invoice Number":"${business.bankDetails.paymentReference}"}`
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

                const filename = `invoice/${Date.now()}.pdf`;
                const location = await uploadFileToS3(Buffer.from(pdfBytes), filename);
                console.log(location);
                const { fileUrl, key } = ["", ""];

                putInternalMessage(workspaceId, boardId, item.id, `Your invoice successfully created. \n Click <a href="${fileUrl}">here</a>`);
                AuditTrail.insertOne({ workspaceId: workspaceId, action: 'Generate new PDF Link', detail: `Resourse ID: ${item.id}`, userEmail: "", userIp: req.ip?.split(':').pop() });
                axios.post(`http://localhost:3001/api/pdf`, { workspaceId: workspaceId, itemId: item.id, type: 'Invoice', pdfLink: fileUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" })

                setTimeout(async () => {
                    try {
                        await deleteFileFromS3(key);
                        console.log(`File ${filename} has been removed from S3 after 1 hour.`);
                        putInternalMessage(workspaceId, boardId, item.id, "Your invoice successfully created.");

                        await axios.put(`http://localhost:3001/api/pdf`, {
                            workspaceId,
                            itemId: item.id,
                            pdfLink: null,
                            isDeleted: true
                        });

                        AuditTrail.insertOne({
                            workspaceId,
                            action: 'Remove PDF Link',
                            detail: `Resource ID: ${item.id}`,
                            userEmail: "",
                            userIp: req.ip?.split(':').pop()
                        });
                    } catch (err) {
                        console.error(`Error removing file ${filename} from S3:`, err);
                    }
                }, 60 * 60 * 1000); // 1 hour

                info('Webhook-Service', 'Successfully generating PDF invoice', { link: fileUrl }, req);

                res.json({ pdfUrl: fileUrl });
            });
        } catch (err) {
            putInternalMessage(workspaceId, boardId, item.id, `An error occurred while creating the invoice. \n More information: ${err.message}`);
            error('Webhook-Service', 'Server error', { message: err.message }, req);
            res.status(500).json({ message: 'Server error' });
        }
    } else {
        error('Webhook-Service', 'Server error', { message: "There are no item." }, req);
        res.status(500).json({ message: 'Server error' });
    }

});

router.post('/:workspaceId/:boardId/purchaseorder', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (req.body.items.length) {
        try {
            req.body.items?.map(async (item, index) => {
                putInternalMessage(workspaceId, boardId, item.id, "Running...");

                const purchaseOrderValues = item.values;
                const templatePath = path.join(__dirname, '..', 'assets', `purchaseOrder.json`);
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 7);
                const folderIds = await getFolder(workspaceId, boardId);

                let contractor = [];
                for (const folder of folderIds.data) {
                    if (folder.name.includes("Contractor")) {
                        const result = await getItem(workspaceId, boardId, folder.id);
                        if (result.status === 200) contractor = result.item;
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
                };
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

                const inputs = {
                    issueDate: `{"IssueDate": "${purchaseOrderValues['Issue Date'] && new Date(purchaseOrderValues['Issue Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}"}`,
                    deliveryDate: `{"DeliveryDate": "${purchaseOrderValues['Delivery Date'] && new Date(purchaseOrderValues['Delivery Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}"}`,
                    purchaseOrderNumber: `{"PurchaseOrderNumber": "${purchaseOrderValues['PO Number']}"}`,
                    LineItems: `[[
                        "${purchaseOrderValues['Job Type'][0]}",
                        "${purchaseOrderValues['Job Title']}${purchaseOrderValues['Job Description'].replace(/<.*?>/g, "") ? ` - ${purchaseOrderValues['Job Description'].replace(/<.*?>/g, "")}` : ''}",
                        "${purchaseOrderValues.Quantity || 1}",
                        "${purchaseOrderValues['Unit Price($) - GST Excl.'] || 1}",
                        "${purchaseOrderValues['Total Price($) - GST Excl.'] || 1}"
                    ]]`,
                    attentionTo: `{"AttentionTo": "${contractorReference.ContactPersonsFirstName} ${contractorReference.ContactPersonsLastName}"}`,
                    deliveryAddress: `{"DeliveryAddress": "${contractorReference.Address} ${contractorReference.Suburb} ${contractorReference.State} ${contractorReference.Postcode}"}`,
                    telephone: `{"Telephone": "${contractorReference.PhoneNumber}"}`
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

                const filename = `purchase_${Date.now()}.pdf`;
                const uploadDir = path.join(__dirname, '../../', 'purchase');

                await fs.mkdir(uploadDir, { recursive: true });
                const filePath = path.join(uploadDir, filename);
                await fs.writeFile(filePath, Buffer.from(pdfBytes));

                const pdfUrl = `http://localhost:3001/api/webhook/uploads/${filename}`;

                putInternalMessage(workspaceId, boardId, item.id, `Your purchase order successfully created. \n Click <a href="${pdfUrl}">here</a>`);
                AuditTrail.insertOne({ workspaceId: workspaceId, action: 'Generate new PDF Link', detail: `Resourse ID: ${item.id}`, userEmail: "", userIp: req.ip?.split(':').pop() });
                axios.post(`http://localhost:3001/api/pdf`, { workspaceId: workspaceId, itemId: item.id, type: 'PurchaseOrder', pdfLink: pdfUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" })

                setTimeout(async () => {
                    try {
                        await fs.unlink(filePath);
                        console.log(`File ${filename} has been removed after 5 minutes.`);
                        putInternalMessage(workspaceId, boardId, item.id, `Your purchase order successfully created.`);
                        axios.put(`http://localhost:3001/api/pdf`, { workspaceId: workspaceId, itemId: item.id, pdfLink: pdfUrl })
                        AuditTrail.insertOne({ workspaceId: workspaceId, action: 'Remove PDF Link', detail: `Resourse ID: ${item.id}`, userEmail: "", userIp: req.ip?.split(':').pop() });
                    } catch (err) {
                        console.error(`Error removing file ${filename}:`, err);
                    }
                }, 60 * 1000); // For testing purpose, let's change time to 1 min.

                info('Webhook-Service', 'Successfully generating PDF for Purchase Order', { link: pdfUrl }, req);

                res.json({ pdfUrl });
            });
        } catch (err) {
            putInternalMessage(workspaceId, boardId, item.id, `An error occurred while creating the purchase order. <br> More information: ${err.message}`);
            error('Webhook-Service', 'Server error', { message: err.message }, req);
            res.status(500).json({ message: 'Server error' });
        }
    } else {
        error('Webhook-Service', 'Server error', { message: "There are no item." }, req);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/:workspaceId/:boardId/quote', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (req.body.items.length) {
        try {
            req.body.items?.map(async (item, index) => {
                putInternalMessage(workspaceId, boardId, item.id, "Running...");

                const quoteValues = item.values;
                const templatePath = path.join(__dirname, '..', 'assets', `quote.json`);
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);

                const pdfBytes = await generate({
                    template: template,
                    inputs: [
                        {
                            issueDate: `{"IssueDate": "${quoteValues['Issue Date'] ? new Date(quoteValues['Issue Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}"}`,
                            expiryDate: `{"ExpiryDate": "${quoteValues['Expiry Date'] ? new Date(quoteValues['Expiry Date']).toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleString('en-AU', { month: 'numeric', day: 'numeric', year: 'numeric' })}"}`,
                            quoteNumber: `{"QuoteNumber": "${quoteValues['Quote Number']}"}`,
                            jobDescription: `{"JobDescription": "${quoteValues['Job Description'].replace(/<.*?>/g, "")}"}`,
                            jobTitle: `{"Title": "${quoteValues['Job Title'].replace(/<.*?>/g, "")}"}`,
                            LineItems: `[["${quoteValues['Job Type'][0]}","${quoteValues['Job Title']} - ${quoteValues['Job Description'].replace(/<.*?>/g, "")}","${quoteValues.Quantity || 1}","${quoteValues['Unit Price($) - GST Excl.'] || 1}", "${quoteValues['Total Price($) - GST Excl.'] || 1}"]]`,
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

                const filename = `quote_${Date.now()}.pdf`;
                const uploadDir = path.join(__dirname, '../../', 'quote');

                await fs.mkdir(uploadDir, { recursive: true });
                const filePath = path.join(uploadDir, filename);
                await fs.writeFile(filePath, Buffer.from(pdfBytes));

                const pdfUrl = `http://localhost:3001/api/webhook/uploads/${filename}`;

                putInternalMessage(workspaceId, boardId, item.id, `Your quote successfully created. \n Click <a href="${pdfUrl}">here</a>`);
                AuditTrail.insertOne({ workspaceId: workspaceId, action: 'Generate new PDF Link', detail: `Resourse ID: ${item.id}`, userEmail: "", userIp: req.ip?.split(':').pop() });
                axios.post(`http://localhost:3001/api/pdf`, { workspaceId: workspaceId, itemId: item.id, type: 'Quote', pdfLink: pdfUrl, createdBy: "", isDeleted: false, SignatureStatus: "Unsigned" })

                setTimeout(async () => {
                    try {
                        await fs.unlink(filePath);
                        console.log(`File ${filename} has been removed after 5 minutes.`);
                        axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${item.id}`, {
                            "values": [
                                {
                                    "attribute_id": "b84bf475-b4f7-4e35-891a-72c24631468f",
                                    "data": `<p>Your quote successfully created.</p>`
                                }
                            ],
                        }, {
                            headers: {
                                "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                                "Content-Type": "application/json",
                                "Accept": "application/json",
                                "X-API-Version": "2025-02-26.morava",
                            }
                        });
                        axios.put(`http://localhost:3001/api/pdf`, { workspaceId: workspaceId, itemId: item.id, pdfLink: pdfUrl })
                        AuditTrail.insertOne({ workspaceId: workspaceId, action: 'Remove PDF Link', detail: `Resourse ID: ${item.id}`, userEmail: "", userIp: req.ip?.split(':').pop() });
                    } catch (err) {
                        console.error(`Error removing file ${filename}:`, err);
                    }
                }, 60 * 1000); // For testing purpose, let's change time to 1 min.

                info('Webhook-Service', 'Successfully generating PDF quote', { link: pdfUrl }, req);

                res.json({ pdfUrl });
            });
        } catch (err) {
            putInternalMessage(workspaceId, boardId, item.id, `An error occurred while creating the quote. \n More information: ${err.message}`);
            error('Webhook-Service', 'Server error', { message: err.message }, req);
            res.status(500).json({ message: 'Server error' });
        }
    } else {
        error('Webhook-Service', 'Server error', { message: "There are no item." }, req);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/uploads/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const key = `pdfs/${filename}`;

        // Get a signed URL for temporary access
        const fileUrl = await getS3FileUrl(S3_BUCKET, key);

        // Redirect to the signed URL
        res.redirect(fileUrl);
    } catch (err) {
        error('Workspace-Service', 'Error downloading file', { message: err.message }, req);
        res.status(404).json({ message: 'File not found' });
    }
});

export default router;
