import express from 'express';
import mongoose from 'mongoose';
import PDFLink from '../models/PDFLink.js';
import { authenticateToken } from '../middleware/auth.js';
import { GENERATED_DOCUMENT_PUBLIC_READ, GENERATED_PDF_URL_EXPIRY_SECONDS } from '../constants/storage.js';
import { s3ObjectKeyFromUrl } from '../utils/s3ObjectKey.js';
import { getS3FileUrl, getS3File } from '../utils/uploadS3.js';
import { requireWorkspaceMember } from '../utils/workspaceAccessHelpers.js';
import {
  assertGeneratedDocumentKeyForWorkspace,
  filenameFromObjectKey,
  safeAttachmentFilename,
} from '../utils/pdfFileDownloadHelpers.js';
import { info, warn, error } from '../utils/logger.js';
import { toRequiredQueryString } from '../utils/securityHelpers.js';

const router = express.Router();

/**
 * Re-sign a generated document and redirect to it.
 *
 * The stored `pdfLink` is a presigned S3 URL captured at generation time, and
 * seven days is the longest signature AWS SigV4 will issue. So every link the
 * Automation Status panel shows — and every link stored against a document —
 * stops working a week after the run that produced it, with nothing in the UI
 * to say why. This route holds the object KEY's stable identity (the PDFLink
 * row) and mints a fresh signature on each request, so the panel's links do not
 * expire.
 *
 * Authenticated and workspace-scoped, deliberately. The other handlers in this
 * file predate that and are unguarded; adding an UNAUTHENTICATED redirect that
 * hands out presigned URLs would be a worse hole than the expiry it fixes, so
 * this one carries both gates rather than matching its neighbours.
 *
 * Declared before `/:id` in source order for readability only — the two cannot
 * collide, since this path has a second segment.
 */
router.get('/download/:id', authenticateToken, async (req, res) => {
  try {
    const id = toRequiredQueryString(req.params.id);
    if (!id || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid document id' });
    }

    const link = await PDFLink.findById(id).lean();
    // A deleted document is gone as far as this route is concerned, and 404 for
    // both cases keeps the response from confirming that an id exists in
    // another workspace.
    if (!link || link.isDeleted) return res.status(404).json({ message: 'Document not found' });

    if (!(await requireWorkspaceMember(req, res, link.workspaceId))) return;

    const key = s3ObjectKeyFromUrl(link.pdfLink);
    if (!key) return res.status(404).json({ message: 'Document not found' });

    const url = await getS3FileUrl(key, GENERATED_PDF_URL_EXPIRY_SECONDS, GENERATED_DOCUMENT_PUBLIC_READ);
    info('PDFLink-Service', 'Re-signed a generated document', {
      pdfLinkId: id, workspaceId: link.workspaceId, type: link.type,
    }, req ?? null);
    // 302, not 301: the target carries a signature that expires, and a browser
    // must never cache this hop as permanent.
    return res.redirect(302, url);
  } catch (err) {
    warn('PDFLink-Service', 'Could not re-sign a generated document', {
      pdfLinkId: req.params.id, error: err.message,
    }, req ?? null);
    return res.status(502).json({ message: 'Could not prepare the document for download' });
  }
});

/**
 * Stream a generated PDF through the API so the browser never fetches S3.
 *
 * Monthly Statement and Invoice Generator used to `fetch(presignedS3Url)` so
 * they could attach a download filename. That fails without bucket CORS; the
 * UI then fell back to opening the URL in a new tab ("Download failed, opened
 * PDF in new tab instead."). This route reads the object server-side and
 * returns the bytes with Content-Disposition, so the download works without
 * any S3 CORS change.
 *
 * Body: { fileUrl, workspaceId, filename? }. Authenticated and workspace-
 * scoped; the object key must sit under output/<workspaceId>/.
 */
router.post('/file', authenticateToken, async (req, res) => {
  try {
    const fileUrl = toRequiredQueryString(req.body?.fileUrl);
    const workspaceId = toRequiredQueryString(req.body?.workspaceId);
    if (!fileUrl || !workspaceId) {
      return res.status(400).json({ message: 'fileUrl and workspaceId are required' });
    }

    if (!(await requireWorkspaceMember(req, res, workspaceId))) return;

    const key = s3ObjectKeyFromUrl(fileUrl);
    if (!assertGeneratedDocumentKeyForWorkspace(key, workspaceId)) {
      return res.status(400).json({ message: 'Document does not belong to this workspace' });
    }

    const filename = safeAttachmentFilename(
      toRequiredQueryString(req.body?.filename) || filenameFromObjectKey(key),
    );

    let bytes;
    try {
      bytes = await getS3File(key, GENERATED_DOCUMENT_PUBLIC_READ);
    } catch (err) {
      warn('PDFLink-Service', 'Generated document missing for proxy download', {
        workspaceId, key, error: err.message,
      }, req ?? null);
      return res.status(404).json({ message: 'Document not found' });
    }

    info('PDFLink-Service', 'Streamed a generated document for download', {
      workspaceId, key, filename, bytes: bytes.length,
    }, req ?? null);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(bytes);
  } catch (err) {
    error('PDFLink-Service', 'Failed to stream generated document', { err }, req);
    return res.status(500).json({ message: 'Could not download the document' });
  }
});

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