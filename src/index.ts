import React from 'react';
import { loadConfig } from './config.ts';
import { BalanceDatabase } from './database.ts';
import { TerminalUI } from './ui/terminal/index.tsx';
import { render } from 'ink';
import { WalletTracker } from './wallet-tracker.ts';

function main() {
	try {
		// Load configuration
		const config = loadConfig();

		// Initialize database
		const db = new BalanceDatabase(config);
		db.initialize().catch(error => {
			console.error('Failed to initialize database:', error);
		});

		// Create tracker instance
		const tracker = new WalletTracker(config);

		// Start UI immediately
		if (process.stdout.isTTY) {
			// Terminal UI
			render(
				React.createElement(TerminalUI, {
					config,
					db,
					tracker,
				})
			);

			// Start tracker initialization after UI is rendered
			tracker
				.initialize()
				.then(async () => {
					// Start background updates
					await tracker.updateBalances();
				})
				.catch(error => {
					console.error('Failed to initialize tracker:', error);
				});
		} else {
			// Web UI
			// TODO: Start web server
			console.log('Web UI not implemented yet');
		}
	} catch (error) {
		console.error('Failed to start wallet tracker:', error);
		process.exit(1);
	}
}

main();
