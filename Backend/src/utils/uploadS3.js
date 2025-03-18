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
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

export const uploadFileToS3 = async (fileBuffer, key) => {
    const params = {
        Bucket: process.env.AWS_BUCKET,
        Key: key,
        Body: fileBuffer,
        ACL: 'public-read', // Make the file publicly readable
    };

    try {
        const data = await s3Client.send(new PutObjectCommand(params));
        console.log(data);
        return data;
    } catch (err) {
        console.error(err);
        throw err;
    }
};

export const downloadFileFromS3Stream = (key, downloadPath) => {
    const params = {
        Bucket: process.env.AWS_BUCKET,
        Key: key,
    };

    const s3Stream = s3Client.send(new GetObjectCommand(params)).then((data) => data.Body);

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
};

export const getS3FileUrl = async (key) => {
    const params = {
        Bucket: process.env.AWS_BUCKET,
        Key: key,
    };

    try {
        const url = await getSignedUrl(s3Client, new GetObjectCommand(params), { expiresIn: 3600 });
        return url;
    } catch (err) {
        console.error(err);
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
        return data;
    } catch (err) {
        console.error(err);
        throw err;
    }
};