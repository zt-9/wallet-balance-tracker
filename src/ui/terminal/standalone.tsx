import React from 'react';
import { render } from 'ink';
import { loadConfig } from '../../config.ts';
import { BalanceDatabase } from '../../database.ts';
import { TerminalUI } from './index.tsx';

(async function main() {
	let app: ReturnType<typeof render> | undefined;
	try {
		const config = loadConfig();
		const db = new BalanceDatabase(config);
		await db.initialize(); // Wait for DB to be ready
		app = render(
			React.createElement(TerminalUI, {
				config,
				db,
			})
		);

		process.on('SIGINT', async () => {
			app?.unmount();
			await app?.waitUntilExit();
			process.exit(0);
		});
		process.on('SIGTERM', async () => {
			app?.unmount();
			await app?.waitUntilExit();
			process.exit(0);
		});
	} catch (error) {
		app?.unmount();
		await app?.waitUntilExit();
		console.error('Failed to start UI:', error);
		process.exit(1);
	}
})();
