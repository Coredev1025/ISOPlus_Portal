import express from 'express';
import PDFLink from '../models/PDFLink.js';
import { info, error } from '../utils/logger.js';
import { toRequiredQueryString } from '../utils/securityHelpers.js';

const router = express.Router();

// GET all PDF links
router.get('/', async (req, res) => {
    try {
        const workspaceId = toRequiredQueryString(req.query.workspaceId);
        if (!workspaceId) return res.status(400).json({ message: 'Invalid workspaceId' });
        const pdfLinks = await PDFLink.find({ workspaceId });
        info('PDFLink-Service', 'PDF links fetched', { workspaceId, count: pdfLinks.length }, req ?? null);
        res.json(pdfLinks);
    } catch (err) {
        error('PDFLink-Service', 'Failed to fetch PDF links', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

// GET selected PDF links
router.get('/:id', async (req, res) => {
    try {
        const workspaceId = toRequiredQueryString(req.query.workspaceId);
        const itemId = toRequiredQueryString(req.params.id);
        if (!workspaceId || !itemId) return res.status(400).json({ message: 'Invalid workspaceId or itemId' });
        const pdfLinks = await PDFLink.find({ workspaceId, itemId });
        info('PDFLink-Service', 'PDF links fetched by item', { workspaceId, itemId, count: pdfLinks.length }, req ?? null);
        res.json(pdfLinks);
    } catch (err) {
        error('PDFLink-Service', 'Failed to fetch PDF links by item', { err }, req);
        res.status(500).json({ message: err.message });
    }
});

// POST a new PDF link
router.post('/', async (req, res) => {
    const pdfLink = new PDFLink({
        itemId: toRequiredQueryString(req.body.itemId),
        workspaceId: toRequiredQueryString(req.body.workspaceId),
        pdfLink: toRequiredQueryString(req.body.pdfLink),
        SignatureStatus: toRequiredQueryString(req.body.SignatureStatus),
        type: toRequiredQueryString(req.body.type),
        createdBy: toRequiredQueryString(req.body.createdBy) || "xxx"
    });

    try {
        const newPDFLink = await pdfLink.save();
        info('PDFLink-Service', 'PDF link created', { pdfLinkId: newPDFLink._id, workspaceId: newPDFLink.workspaceId, itemId: newPDFLink.itemId }, req ?? null);
        res.status(201).json(newPDFLink);
    } catch (err) {
        error('PDFLink-Service', 'Failed to create PDF link', { err, body: req.body }, req);
        res.status(400).json({ message: err.message });
    }
});

// PUT update a PDF link
router.put('/', async (req, res) => {
    try {
        const workspaceId = toRequiredQueryString(req.body.workspaceId);
        const itemId = toRequiredQueryString(req.body.itemId);
        const pdfLinkStr = toRequiredQueryString(req.body.pdfLink);
        if (!workspaceId || !itemId || !pdfLinkStr) return res.status(400).json({ message: 'Invalid input' });
        const pdfLink = await PDFLink.findOne({ itemId, workspaceId, pdfLink: pdfLinkStr });
        if (!pdfLink) {
            return res.status(404).json({ message: 'PDF not found' });
        }

        pdfLink.isDeleted = true;

        const updatedPDFLink = await pdfLink.save();
        info('PDFLink-Service', 'PDF link marked deleted', { pdfLinkId: updatedPDFLink._id, workspaceId, itemId }, req ?? null);
        res.json(updatedPDFLink);
    } catch (err) {
        error('PDFLink-Service', 'Failed to update PDF link', { err, body: req.body }, req);
        res.status(500).json({ message: err.message });
    }
});

export default router;