import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_REGION || !process.env.AWS_BUCKET) {
    throw new Error('Missing required AWS environment variables');
}

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
});

export const uploadFileToS3 = async (fileBuffer, key) => {
    const params = {
        Bucket: process.env.AWS_BUCKET,
        Key: key,
        Body: fileBuffer,
        // ACL: 'public-read', // Make the file publicly readable
    };

    try {
        const data = await s3Client.send(new PutObjectCommand(params));
        console.log('File uploaded successfully:', data);
        return data;
    } catch (err) {
        console.error('Error uploading file:', err);
        throw err;
    }
};

export const downloadFileFromS3Stream = async (key, downloadPath) => {
    const params = {
        Bucket: process.env.AWS_BUCKET,
        Key: key,
    };

    try {
        const data = await s3Client.send(new GetObjectCommand(params));
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

export const getS3FileUrl = async (key) => {
    const params = {
        Bucket: process.env.AWS_BUCKET,
        Key: key,
    };

    try {
        const url = await getSignedUrl(s3Client, new GetObjectCommand(params), { expiresIn: 3600, requestPayer: 'requester' });
        return url;
    } catch (err) {
        console.error('Error generating signed URL:', err);
        throw err;
    }
};

export const deleteFileFromS3 = async (key) => {
    const params = {
        Bucket: process.env.AWS_BUCKET,
        Key: key,
    };

    try {
        const data = await s3Client.send(new DeleteObjectCommand(params));
        console.log('File deleted successfully:', data);
        return data;
    } catch (err) {
        console.error('Error deleting file:', err);
        throw err;
    }
};