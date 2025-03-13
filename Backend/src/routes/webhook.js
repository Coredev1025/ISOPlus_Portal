import express from 'express';
import { info, error } from '../utils/logger.js';
import fs from 'fs/promises';
import { generate } from '@pdfme/generator';
import { text, table, line, image, multiVariableText } from '@pdfme/schemas';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { access } from 'fs/promises';
import axios from "axios";
import AuditTrail from '../models/AuditTrail.js';
import Business from '../models/Business.js';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.post('/:workspaceId/:boardId/invoice', async (req, res) => {
    const { workspaceId, boardId } = req.params;

    if (req.body.items.length) {
        try {
            const business = await Business.findOne({ workspaceId });
            req.body.items?.map(async (item, index) => {
                axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${item.id}`, {
                    "values": [
                        {
                            "attribute_id": "b84bf475-b4f7-4e35-891a-72c24631468f",
                            "data": `<p>Running...</p>`
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
                const templatePath = path.join(__dirname, '..', 'assets', `invoice.json`);
                const templateData = await fs.readFile(templatePath, 'utf8');
                const template = JSON.parse(templateData);
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 7);

                const invoiceCnt = await AuditTrail.find({ workspaceId: workspaceId, action: 'Generate new PDF Link' }).countDocuments();
                const invoiceNumber = "INV-" + invoiceCnt.toString();
                //job planning: C77gZ1sVCC1 client: jayDw6aiceU
                let jobPlan = [], clients = [];
                const folderIds = await axios.get(`https://app.isoplus.online/api/${workspaceId}/folder/${boardId}`, {
                    headers: {
                        "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "X-API-Version": "2025-02-26.morava",
                    }
                });

                const folderPromises = folderIds.data.map(folder => {
                    if (folder.name.includes("Job Planning")) {
                        return axios.get(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/`, {
                            headers: {
                                "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                                "Content-Type": "application/json",
                                "Accept": "application/json",
                                "X-API-Version": "2025-02-26.morava",
                            }, params: {
                                "limit": "100",
                                "sort_by": "created_at",
                                "sort_direction": "desc",
                                "expand[0]": "values.attribute",
                                "folder_id": folder.id,
                            }
                        }).then(items => {
                            jobPlan = jobPlan.concat(items.data.data);
                            let has_more = items.data.has_more;
                            const promises = [];
                            while (has_more) {
                                promises.push(
                                    axios.get(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/`, {
                                        headers: {
                                            "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                                            "Content-Type": "application/json",
                                            "Accept": "application/json",
                                            "X-API-Version": "2025-02-26.morava",
                                        }, params: {
                                            "limit": "100",
                                            "sort_by": "created_at",
                                            "sort_direction": "desc",
                                            "expand[0]": "values.attribute",
                                            "folder_id": folder.id,
                                            "after": items.data.after
                                        }
                                    }).then(response => {
                                        if (response.status === 200) {
                                            jobPlan = jobPlan.concat(response.data.data);
                                            has_more = response.data.has_more;
                                        } else {
                                            has_more = false;
                                        }
                                    })
                                );
                            }
                            return Promise.all(promises);
                        });
                    } else if (folder.name.includes("Clients")) {
                        return axios.get(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/`, {
                            headers: {
                                "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                                "Content-Type": "application/json",
                                "Accept": "application/json",
                                "X-API-Version": "2025-02-26.morava",
                            }, params: {
                                "limit": "100",
                                "sort_by": "created_at",
                                "sort_direction": "desc",
                                "expand[0]": "values.attribute",
                                "folder_id": folder.id,
                            }
                        }).then(items => {
                            clients = clients.concat(items.data.data);
                            let has_more = items.data.has_more;
                            const promises = [];
                            while (has_more) {
                                promises.push(
                                    axios.get(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/`, {
                                        headers: {
                                            "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                                            "Content-Type": "application/json",
                                            "Accept": "application/json",
                                            "X-API-Version": "2025-02-26.morava",
                                        }, params: {
                                            "limit": "100",
                                            "sort_by": "created_at",
                                            "sort_direction": "desc",
                                            "expand[0]": "values.attribute",
                                            "folder_id": folder.id,
                                            "after": items.data.after
                                        }
                                    }).then(response => {
                                        if (response.status === 200) {
                                            clients = clients.concat(response.data.data);
                                            has_more = response.data.has_more;
                                        } else {
                                            has_more = false;
                                        }
                                    })
                                );
                            }
                            return Promise.all(promises);
                        });
                    }
                });

                await Promise.all(folderPromises);

                let clientName = "", clientDetailInfo;

                for (const job of jobPlan) {
                    const jobNumberAttribute = job.values.find(attr => attr.attribute.name === "Job Number");
                    const clientNameAttribute = job.values.find(attr => attr.attribute.name === "Client");

                    if (jobNumberAttribute && jobNumberAttribute.data === item.values["Job Number"][0]) {
                        clientName = clientNameAttribute.data[0];
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

                const pdfBytes = await generate({
                    template: template,
                    inputs: [
                        {
                            clientDetails: `{"Address":"${clientDetails.Address}","Suburb":"${clientDetails.Suburb}","State":"${clientDetails.State}","Postcode":"${clientDetails.Postcode}","Client":"${clientDetails.Client}"}`,
                            invoiceDetails: `{"Date":"${new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })}","Invoice Number":"${invoiceNumber}"}`,
                            companyName: `{"Company Name":"${business.name}"}`,
                            companyDetails: `{"ABN":"${business.abn}","Street Address":"${business.address.street}","Suburb":"${business.address.suburb}","State":"${business.address.state}","Postcode":"${business.address.postcode}","Country":"${business.address.country}"}`,
                            orders: `[["${index + 1}","${item.values["Undertaken Tasks Decription"]}","1","${item.values["Job Duration (Hrs.)"]}","${item.values["Total Invoiced Fee($) - GST Excl."]}","${item.values["Job Duration (Hrs.)"]}"]]`,
                            gstInput: `{"rate":"${item.values["Total Invoiced Fee($) - GST Excl."]}"}`,
                            dueDate: `{"Date":"${dueDate.toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })}"}`,
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

                const filename = `invoice_${Date.now()}.pdf`;
                const uploadDir = path.join(__dirname, '../../', 'invoice');

                await fs.mkdir(uploadDir, { recursive: true });
                const filePath = path.join(uploadDir, filename);
                await fs.writeFile(filePath, Buffer.from(pdfBytes));

                AuditTrail.insertOne({ workspaceId: workspaceId, action: 'Generate new PDF Link', detail: `Resourse ID: ${item.id}`, userEmail: item.values["Reporter's Email Address"] || "", userIp: req.ip?.split(':').pop() });

                const pdfUrl = `http://localhost:3001/api/webhook/uploads/${filename}`;
                axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${item.id}`, {
                    "values": [
                        {
                            "attribute_id": "b84bf475-b4f7-4e35-891a-72c24631468f",
                            "data": `<p>Your invoice successfully created. <br> Click <a href="${pdfUrl}">here</a></p>`
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

                axios.post(`http://localhost:3001/api/pdf`, { workspaceId: workspaceId, itemId: item.id, type: 'Invoice', pdfLink: pdfUrl, createdBy: item.values["Reporter's Email Address"] || "", isDeleted: false, SignatureStatus: "Unsigned" })

                setTimeout(async () => {
                    try {
                        await fs.unlink(filePath);
                        console.log(`File ${filename} has been removed after 5 minutes.`);
                        axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${item.id}`, {
                            "values": [
                                {
                                    "attribute_id": "b84bf475-b4f7-4e35-891a-72c24631468f",
                                    "data": `<p>Your invoice successfully created.</p>`
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

                info('Webhook-Service', 'Successfully generating PDF invoice', { link: pdfUrl }, req);

                res.json({ pdfUrl });
            });
        } catch (err) {
            axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${item.id}`, {
                "values": [
                    {
                        "attribute_id": "b84bf475-b4f7-4e35-891a-72c24631468f",
                        "data": `<p>An error occurred while creating the invoice. <br> More information: ${err.message}</p>`
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
        const filePath = path.join(__dirname, '../../', 'invoice', filename);
        // Check if file exists using promise-based fs
        await access(filePath);

        // Set headers for file download
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
        res.setHeader('Content-Type', 'application/pdf');

        // Stream the file using standard fs
        const fileStream = createReadStream(filePath);
        fileStream.pipe(res);
    } catch (err) {
        error('Workspace-Service', 'Error downloading file', { message: err.message }, req);
        res.status(404).json({ message: 'File not found' });
    }
});

export default router;
