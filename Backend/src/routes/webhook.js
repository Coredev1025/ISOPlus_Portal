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

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.post('/:clientID/invoice', async (req, res) => {
    const { clientID } = req.params;

    try {
        const integrationData = process.env.INTEGRATION ? JSON.parse(process.env.INTEGRATION) : {};
        const clientIntegration = integrationData[clientID];
        if (!clientIntegration) {
            return res.status(400).json({ message: 'Invalid client ID or integration data not found' });
        }

        req.body.items?.map(async (item) => {
            console.log(item)
            let logoBase64 = '';

            const templatePath = path.join(__dirname, '..', 'assets', `invoice.json`);
            const templateData = await fs.readFile(templatePath, 'utf8');
            const template = JSON.parse(templateData);
            const pdfBytes = await generate({
                template: template,
                inputs: [
                    {
                        orders: "[[\"" + item.values['Undertaken Tasks Decription'] + "\",\"" + item.values['Job Duration (Hrs.)'] + "\",\"123\",\"123\"]]",
                        taxInput: "{\"rate\":\"" + item.values['Total Invoiced Fee($) - GST Excl.'] + "\"}",
                        logo: logoBase64 || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUgAAAGQBAMAAAA+V+RCAAAAAXNSR0IArs4c6QAAABtQTFRFAAAAR3BMAAAAAAAAAAAAAAAAAAAAAAAAAAAAqmQqwQAAAAh0Uk5TDQAvVYGtxusE1uR9AAAKg0lEQVR42tTbwU7bQBDG8TWoPeOBPoBbdbhiVMGV0Kr0GChSe0RtRfccEOROnP0eu8ckTMHrjD27/h4Afvo7u4kUxZXbjuboZ+Hx9vrz+6J8eW5rJKPHhYfr46J/JHn0u/DnuHcko/eF71Ub0j6k3P1Rr0jGIHs4bkPah5RbnveHZMBQ6VKHlMqjnpCMAdfUApk8pNx91QeSMex+C2R2IYFwrkcyht6yEsjkIeXutEjG8AtnApldSGBRqJAMk10JZHYhgaZSIBlG+yWQipAGKZ0ipNmr0uUaEmiKLZEMw52tkLqQD7f6PT7iv1uskLqQV06/nQ9ffswhF+oVUhMS07KX7Xz6+8ot5BQhBVLF/Pry0XGKkAKpGp3IRz7pjmQMiSz3TvB8s85I8h2ReuWy6IpkDIws6UI8745I8oMjy10vnnc3JGN4ZPlRnO9OSPIWyL0LcZ93QTIskOXuXPz9eCR5G2R5io09dUEyjJD7c3kJudiQJkiZMtTxSIYZ8mAu/oGLDGmHLL9hfXfRSIYh8g3W18QiyVsh5VdtoYpEMsyQ8uhM4pDk7ZDyeU/jkAw7pHzesygkeUOkPN+LKCTDGsnP3nNcREhz5MHm8Y5AMkyRskvdjiRvi5Qvyst2JCMB8hBru2lFkjdGypty1opkpEDuY21PbUjy1kh5nS/akIwkyL2fWK0pXEtIc6Q83ssWJCMR8nTjNncxIe2Rh/FIRirkW6ytdjEh7ZHvopGMFEj5EWPiYkLaI/djkYyEyDlWu3SakOmRjIRIWkdOnSJkeiQjfyT5ESAZ+SPJjwDJyB9JfgRIRv5I8iNAMvJHkh8BkpE/kvwIkIz8keRHgGTkjyQ/AiQjfyT5ESAZ+SPJjwDJyB9JfgRIRv5I8iNAMjJF6kLi0gSpC4mJMZJ8tkhdSNQmSF3IUNkiGfkiVSHRFCZIVUgsShOkKiRmNkhVSNzYIFUhMbFBqkKGygapCtkUhkhW/JrUAqkJiakRUhMy1EZITcimsEOy4keaNkhFyFBbIRUhF4UZkv61dzfdaRtRGIBHtqFbXQn2RhizDdg1XprYsVk2TlxryYlTo2WP4yLtwaCf3dNGyu3wWkqaczQzizurAGb05M6HPtBcJT+/jtQU8ucDuekZQwaJc8MGkV33AonIloFAWkO+9NxHbi/IfeQDuY987rmP/AuN9pEYR/eQmP7MbeQ25Xx3lpBX3yuXJxETzSN//AxVkIIUpCAFKUhBClKQghSkIAUpSEEKUpCCFKQgBSlIQQpSkIIUpCAFKUhBClKQghSkIAUpSEEKUpCCFKQgmyy+AeRedKi/jKr+LvII3z25uru7uhx7jSL379PlW/3lB+/1v0vhg+B08XXD6edxM0h+ntJm9K2eGJ7FW3xw/88Ht7vw/65L8BpDtvQF/MdVC5wGxQdg5O08eE0hz4v1a3pe9AsI+AwX0QeasYhzE0g/0XKIhBks8dY/eNI6CqzeagYZZtqa7k7VysBjzD4xeG3ZUQNIVs11y3YKvYLXVfMQg3LbHJKbccjrF7FX8BP+MJD8fzCIXEGv4Mp4JGG5MIbEkLSgsk5FUgVjSFyKPoTKhlVrcU0hMYXDjCvTJlQsU5PIJ712rgzzp6dpxi/mJpFr7a+gMt7A5sM4Ornm/5whJH6rDW9PvhnHROQHZzwtmEFi5zqHymY707d/YwU5h8excGW8ubVHsNc3iFxh5VxZiJPAxGifxOm8C5V1sO4Do1MQTudDqKyNc0AQm5zMMSvhDCob5ti4Az4wMYZkQJBAZRMcXeSfpennnlkkN2WIlc1e2wn60dgjM0j8XqsaOSIohpFlmCZYWcyvrCK5w8VQme8OclVWjcjEMhKm805eidx4VpAIomN8L8gsI2E6P3cUuS3f5Kbdas2dcYewhnzOeDoPM36LI+kA8ikuTv34EOgyq4tkdFqm1Dg0hzwvdyjlW9uoLpL7i7wsy5ExZJun89lXzn4d8gYuD5hAdsoNlhWvwhpkmMHlARPIICsRnSKmdcgupOEzgqRZ+dWi4adBDbIN1zDMIIflBidFHXWRHFpCtop/+HExYwYOIovArYOM36icJ1t2kOXOcHNU1FgbyY4dZHlYsb0vRmxtJP3YChIfCR5kNUdBg8wKUm/CNUEkNaR/+vvjY2IayRXy69ojc6VUOcZH5pAU6y0Y7iCx6l8sICd6DUFWf7bIB8wmkS39jCwEJESS3zOGDLWjL45k5RWMoQVkkGhXCUJAwjVrHkxmkAWkpEAkJ+WW8LeeF6PIIVcAkYTrk9xP12QS2eWpnDcAV3pBsDKJ5CqfCCJ5gHV3IbgmkH5cVgeRrPn1IZ8bRPJw3Y4gkry5Z2/3F/GpWWS7nFMwkhTv3Bvi3/DWjCJDHgkcSfht8c2/xl9572QWGSRlt8NI8gni8jKK+tcZ753MImnIX+dI4i8SaZrmvG3TyE7GoeFI4hkDbMwkks6yfDkiiCR3SihrMo70+yeHBJHkL2L5ZB5Jvk8EkYT2hm2ZQnLBSOL1fh7bTSL//N/IIEHjdtT4XX+MnFduYOPV3fX3QI0gA/3+yVblA/j8BI7NbjBDfzNImmmXZ8PqVptBpwsTuMezIWRL23YQV+5/j3GHcpBoxrfUAJJZHLpB5a2aQYIN2r/nzWzeNnmf+SJNWRVcp+lnj14rR4t0uduge+/SvJH7zPGe+4i4+P3KexSik0McT9Hpu7s/7q7GnttrH3ylPFlFIkhBClKQghSkIAUpSEEKUpCCFKQgBSlIQQpSkIIUpCAFKUhBClKQghSkIAUpSEEKUpCCFKQgbSO7cPO35YKpKN5ryNxN5FR13ETm1cipK0hdpTTze1eQeifUkXNXkG0dubsY337B1HI68osryImO9BNct2W/zLSsFcqPIT+a/bKDUhp623Nwr7gmRecwmzs2l69I6dlxfrPuw2Q4T6SonTs2B2FKRkXd3L3hPdN3g4rC3LmREyT6OFE7SSOn9omYIlKRr7E/2SdiBiJFNHOsU6JIQbpLZ6ZynnAUHxY5M1N2NdCcSHE3deZAaLKbMkxxdF1pb/QoIordau+WxnkhIgXhXXt2jf4Mup8Cuu35vJNBwyo+MGK7Q8MmHxVIP4GV9tavXfD+pkDSOYTSmUCuqES2cgilxUDiXKPgE6sD3L+BeBVITKdxaws5gOcRlUh8hM3GSoNjAoX8iRgJ6VOeezaMmIpiykiehHiEe+aN/tmuYuMxktuby4NnxYitzchOjkrDLR6cZWCYMrIiXc7zoUnj3nX1s8ZUTbqc5eWhMeLpoibvkdJmemBejSPVeIn6V4ssr0nXo7QzNCxp+th4KVKEQXkmRvLQcaxcANKPXTO+eICkgWvIW0JkEDsWyB4hkgbuBRKRQexcIBFJA/cCichg5o5x7VUg6SCzTMN0YYikiSvIL1SNDGLnRg0i6ch2g2PeNUTSmQvIBwIknAtZLXgWiEgKY+sdckTfQ9J+Yte4eUOIhHJkQ4mJABGJSvvGeiT1F7aMyzH9KJL2biyN6zdUjUTlr6l54vZDj+qQWPrXmWEi5KUEJBa//26RGRMuP449+jEkprV8TLPGgenjx8uomkj0N73+g6V/XjknAAAAAElFTkSuQmCC",
                        invoiceInfo: "{\"InvoiceNo\":\"123456\",\"Date\":\"" + new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }) + "\"}",
                        billedToInput: item.values["Client's Representative"] + "\n+123-456-7890 \n63 Ivy Road, Hawkville, GA, USA 31036"
                    },
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
            const pdfUrl = `http://localhost:3001/api/webhook/uploads/${filename}`;
            axios.put(`https://app.isoplus.online/api/v2/workspaces/${clientIntegration.workspaceID}/boards/${clientIntegration.boardID}/items/${item.id}`, {
                "values": [
                    {
                        "attribute_id": "b84bf475-b4f7-4e35-891a-72c24631468f",
                        "data": `<p>Download <a href="${pdfUrl}">Here</a></p>`
                    }
                ],
            }, {
                headers: {
                    "Authorization": `Bearer ${clientIntegration.personalAccessToken}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-API-Version": "2024-12-17.morava",
                }
            });           

            setTimeout(async () => {
                try {
                    await fs.unlink(filePath);
                    console.log(`File ${filename} has been removed after 5 minutes.`);
                    const putdata = await axios.put(`https://app.isoplus.online/api/v2/workspaces/${clientIntegration.workspaceID}/boards/${clientIntegration.boardID}/items/${item.id}`, {
                        "values": [
                            {
                                "attribute_id": "b84bf475-b4f7-4e35-891a-72c24631468f",
                                "data": `<p>Download <a href="${pdfUrl}">Here</a></p><p>Link is expired, please generate again.</p>`
                            }
                        ],
                    }, {
                        headers: {
                            "Authorization": `Bearer ${clientIntegration.personalAccessToken}`,
                            "Content-Type": "application/json",
                            "Accept": "application/json",
                            "X-API-Version": "2024-12-17.morava",
                        }
                    });
                } catch (err) {
                    console.error(`Error removing file ${filename}:`, err);
                }
            }, 5 * 60 * 1000);

            info('Webhook-Service', 'Successfully generating PDF invoice', { link: pdfUrl }, req);

            res.json({ pdfUrl });
        });

    } catch (err) {
        error('Webhook-Service', 'Server error', { message: err.message }, req);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/uploads/:filename', async (req, res) => {
    try {
        const { filename } = req.params;
        const filePath = path.join(__dirname, '../../', 'invoice', filename);
        // Check if file exists using promise-based fs
        await access(filePath);
        console.log(filePath);

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
