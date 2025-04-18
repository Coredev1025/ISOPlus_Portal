import schedule from 'node-schedule';
import Business from '../models/Business.js';
import { info, error } from '../utils/logger.js';

export const getXeroIntegratedBusinesses = async (current) => {
    try {
        const businesses = await Business.find({
            xeroIntegrated: true,
            'xeroTokens.accessToken': { $exists: true },
            'xeroTokens.expiresAt': { $lt: Date.now() - 4320000}
        });

        console.log(businesses);
        info(`Found ${businesses.length} Xero integrated businesses`);
        return businesses;
    } catch (err) {
        error('Error fetching Xero integrated businesses:', err);
        throw new Error('Failed to fetch Xero integrated businesses');
    }
};

export function startXeroWorker() {
    // Schedule job to run at midnight every day
    schedule.scheduleJob('0 0 * * *', async () => {
        try {
            info('Starting daily Xero data sync');

            // Fetch Xero integrated businesses
            const currentTime = parseInt(Date.now() / 1000);

            const businesses = await getXeroIntegratedBusinesses(currentTime);
            info('Successfully fetched Xero integrated businesses');

            // Perform operations for each business
            for (const business of businesses) {
                info(`Processing business: ${business.name}`);
                // Add your business-specific logic here
            }

            info('Successfully completed Xero daily sync');
        } catch (err) {
            error('Error in Xero worker:', err);
        }
    });

    info('Xero background worker scheduled');
}