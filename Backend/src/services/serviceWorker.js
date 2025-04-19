import schedule from 'node-schedule';
import Business from '../models/Business.js';
import { info, error } from '../utils/logger.js';
import { configure, refreshTokenSet } from '../services/xero.js';

export const getXeroIntegratedBusinesses = async (current) => {
    try {
        const businesses = await Business.find({
            xeroIntegrated: true,
            'xeroTokens.accessToken': { $exists: true },
            'xeroTokens.expiresAt': { $lt: Date.now() - 4320000 }
        });

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
                await configure();
                const newTokenSet = await refreshTokenSet({
                    access_token: business.xeroTokens.accessToken,
                    refresh_token: business.xeroTokens.refreshToken,
                    expires_at: Date.now() / 1000 + 300, // Set a new expiration time
                    token_type: 'Bearer'
                });

                const updateData = {
                    access_token: newTokenSet.access_token,
                    refresh_token: newTokenSet.refresh_token,
                    expires_at: newTokenSet.expires_at,
                };

                Business.updateOne(
                    { _id: business._id },
                    {
                        $set: {
                            xeroTokens: {
                                ...updateData
                            }
                        }
                    }
                );
            }

            info('Successfully completed Xero daily sync');
        } catch (err) {
            error('Error in Xero worker:', err);
        }
    });

    info('Xero background worker scheduled');
}