import AWS from 'aws-sdk';
const fs = require('fs');

AWS.config.update({
    accessKeyId: 'YOUR_AWS_ACCESS_KEY_ID',
    secretAccessKey: 'YOUR_AWS_SECRET_ACCESS_KEY',
    region: 'YOUR_AWS_REGION',
});

const s3 = new AWS.S3();

export const uploadFileToS3 = (fileBuffer, bucketName, key) => {
    const params = {
        Bucket: bucketName,
        Key: key,
        Body: fileBuffer,
        ACL: 'public-read', // Make the file publicly readable
    };

    return s3.upload(params).promise().then(data => data.Location); // Return the file URL
};

export const downloadFileFromS3Stream = (bucketName, key, downloadPath) => {
    const params = {
        Bucket: bucketName,
        Key: key,
    };

    const s3Stream = s3.getObject(params).createReadStream();

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

export const getS3FileUrl = (bucketName, key) => {
    return s3.getSignedUrl('getObject', {
        Bucket: bucketName,
        Key: key,
        Expires: 60 * 60, // URL expires in 1 hour
    });
};

export const deleteFileFromS3 = (bucketName, key) => {
    const params = {
        Bucket: bucketName,
        Key: key,
    };

    return s3.deleteObject(params).promise();
};