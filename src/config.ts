import { parse } from 'toml';
import { readFileSync } from 'fs';
import { config as dotenvConfig } from 'dotenv';
import { Config, Wallet } from './types.js';

// Load environment variables
dotenvConfig();

function interpolateEnvVars(content: string): string {
	return content.replace(/\${([^}]+)}/g, (_, key) => {
		const value = process.env[key];
		if (!value) {
			throw new Error(`Environment variable ${key} is not set`);
		}
		return value;
	});
}

function loadWallets(filePath: string): Wallet[] {
	const content = readFileSync(filePath, 'utf-8');

	if (filePath.endsWith('.json')) {
		const data = JSON.parse(content);
		if (!Array.isArray(data.wallets)) {
			throw new Error('Invalid wallet configuration: wallets must be an array');
		}
		return data.wallets;
	} else if (filePath.endsWith('.toml')) {
		const data = parse(content);
		if (!Array.isArray(data.wallets)) {
			throw new Error('Invalid wallet configuration: wallets must be an array');
		}
		return data.wallets;
	} else {
		throw new Error('Unsupported wallet configuration format. Use .json or .toml');
	}
}

export function loadConfig(): Config {
	// Load environment variables
	dotenvConfig();

	// Read and parse TOML config
	const configContent = readFileSync('config.toml', 'utf-8');
	const interpolatedContent = interpolateEnvVars(configContent);
	const config = parse(interpolatedContent) as Config;

	// Load wallets from the specified file
	if (config.wallets_file) {
		try {
			const wallets = loadWallets(config.wallets_file);
			config.wallets = wallets;
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`Error loading wallet configuration: ${errorMessage}`);
			throw error;
		}
	}

	return config;
}
