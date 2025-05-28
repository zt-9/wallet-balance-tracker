/**
 * Data fetcher for the wallet tracker
 *
 * Handles:
 * - Network data retrieval
 * - Balance fetching
 * - Error handling and retries
 * - Response parsing
 */

import { loadConfig } from '../src/config.ts';
import { BalanceDatabase } from '../src/database.ts';
import { WalletTracker } from '../src/wallet-tracker.ts';

/**
 * Main function that initializes and runs the data fetcher
 * Continuously updates wallet balances and block mappings
 */
async function main() {
	try {
		const config = loadConfig();
		const db = new BalanceDatabase(config);
		await db.initialize();
		const tracker = new WalletTracker(config);
		await tracker.initialize();
		// Run update loop
		while (true) {
			await tracker.updateBalances();
			await new Promise(res => setTimeout(res, config.update_interval * 1000));
		}
	} catch (error) {
		console.error('Fetcher process failed:', error);
		process.exit(1);
	}
}

main();
