import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import dotenv from 'dotenv';
// Offline, every function here swaps to a local directory served by
// /api/local-files, so a generated PDF is still downloadable with no AWS
// account. Nothing here serves a request; see routes/localFiles.js for the
// ISOPLUS_OFFLINE-in-production hazard on the read side.
import { isOfflineMode } from '../services/offlineIsoplus.js';
import { saveLocalFile, resolveLocalFilePath, buildLocalFileUrl } from './localFileStore.js';

dotenv.config();

const checkS3ENV = (publicRead) => {
    if(publicRead) {
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION || !process.env.AWS_BUCKET_PUBLIC) {
            throw new Error('Missing required AWS environment variables');
        }
    } else {
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION || !process.env.AWS_BUCKET) {
            throw new Error('Missing required AWS environment variables');
        }
    }
}

// Built on first use, not at import. Reading the region and credentials at
// module scope captured whatever the environment held the instant this file was
// first imported — before a caller had loaded them — and the client kept those
// values for the life of the process. checkS3ENV reads the same variables at
// call time, so the guard would pass while the client still held `undefined`
// credentials and every presign failed with "Resolved credential object is not
// valid". The cache key rebuilds the client if any of the three change.
let s3ClientCache = null;
let s3ClientCacheKey = null;

const getS3Client = () => {
    const key = [
        process.env.AWS_REGION,
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY,
    ].map((part) => part ?? '').join('\n');

    if (!s3ClientCache || s3ClientCacheKey !== key) {
        s3ClientCache = new S3Client({
            region: process.env.AWS_REGION,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
            },
        });
        s3ClientCacheKey = key;
    }

    return s3ClientCache;
};

export const uploadFileToS3 = async (fileBuffer, key, publicRead = false) => {
    if (isOfflineMode()) {
        await saveLocalFile(key, fileBuffer);
        // The one field callers read; see webhookNdisPdfHandlers' status check.
        return { '$metadata': { httpStatusCode: 200 } };
    }
    checkS3ENV(publicRead);
    const params = {
        Bucket: publicRead ? process.env.AWS_BUCKET_PUBLIC : process.env.AWS_BUCKET,
        Key: key,
        Body: fileBuffer,
        // ACL: publicRead ? 'public-read' : undefined,
    };

    try {
        const data = await getS3Client().send(new PutObjectCommand(params));
        console.log('File uploaded successfully:', data);
        return data;
    } catch (err) {
        console.error('Error uploading file:', err);
        throw err;
    }
};

export const downloadFileFromS3Stream = async (key, downloadPath) => {
    if (isOfflineMode()) {
        // Copy rather than stream: the local store is a plain directory, so the
        // point of streaming does not apply.
        fs.copyFileSync(resolveLocalFilePath(key), downloadPath);
        return downloadPath;
    }
    const params = {
        Bucket: process.env.AWS_BUCKET,
        Key: key,
    };

    try {
        const data = await getS3Client().send(new GetObjectCommand(params));
        const s3Stream = data.Body;

        const fileStream = fs.createWriteStream(downloadPath);
        s3Stream.pipe(fileStream);

        fileStream.on('close', () => {
            console.log(`File downloaded successfully to ${downloadPath}`);
        });

        fileStream.on('error', (err) => {
            console.error('Error writing file:', err);
        });

        s3Stream.on('error', (err) => {
            console.error('Error downloading file:', err);
        });
    } catch (err) {
        console.error('Error downloading file:', err);
        throw err;
    }
};

export const getS3FileUrl = async (key, expiration = 3600, publicRead = false) => {
    if (isOfflineMode()) {
        return buildLocalFileUrl(key);
    }
    checkS3ENV(publicRead);
    if (publicRead) {
        return 'https://' + process.env.AWS_BUCKET_PUBLIC + '.s3.' + process.env.AWS_REGION + '.amazonaws.com/' + key.replace(/\+/g, '%2B');
    }

    const params = {
        Bucket: process.env.AWS_BUCKET,
        Key: key,
    };

    try {
        const url = await getSignedUrl(getS3Client(), new GetObjectCommand(params), { expiresIn: expiration });
        return url;
    } catch (err) {
        console.error('Error generating signed URL:', err);
        throw err;
    }
};

export const deleteFileFromS3 = async (key, publicRead = false) => {
    if (isOfflineMode()) {
        // force: a delete of something already gone is not an error here, the
        // same way S3 answers 204 for a missing key.
        fs.rmSync(resolveLocalFilePath(key), { force: true });
        return { key };
    }
    checkS3ENV(publicRead);
    const params = {
        Bucket: publicRead ? process.env.AWS_BUCKET_PUBLIC : process.env.AWS_BUCKET,
        Key: key,
    };

    try {
        const data = await getS3Client().send(new DeleteObjectCommand(params));
        console.log('File deleted successfully:', data);
        return data;
    } catch (err) {
        console.error('Error deleting file:', err);
        throw err;
    }
};

export const getS3File = async (key, publicRead = false) => {
    if (isOfflineMode()) {
        return fs.readFileSync(resolveLocalFilePath(key));
    }
    checkS3ENV(publicRead);
    const params = {
        Bucket: publicRead ? process.env.AWS_BUCKET_PUBLIC : process.env.AWS_BUCKET,
        Key: key,
    };

    try {
        const data = await getS3Client().send(new GetObjectCommand(params));
        const chunks = [];
        
        for await (const chunk of data.Body) {
            chunks.push(chunk);
        }
        
        return Buffer.concat(chunks);
    } catch (err) {
        console.error('Error downloading file:', err);
        throw err;
    }
};

export const getContentType = (fileExtension) => {
    const contentTypes = {
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'webp': 'image/webp',
        'bmp': 'image/bmp',
        'ico': 'image/x-icon'
    };
    
    return contentTypes[fileExtension] || 'application/octet-stream';
};