/**
 * WalletTracker: Multi-network wallet balance tracking with batching and rate limiting.
 *
 * Core implementation:
 * - Uses multicall batching for efficient balance queries
 * - Maps dates to block numbers for historical accuracy:
 *     - Estimates block number for a given date using average block time
 *     - Fine-tunes by searching for the closest block to the target timestamp
 *     - Caches mappings for fast future lookups
 * - Applies per-network rate limiting to avoid API bans
 * - Caches historical data in a local database
 */

import { createPublicClient, http, Chain, defineChain } from 'viem';
import { Config, MissingData, Wallet, Network } from './types.ts';
import logger from './logger.js';
import { BalanceDatabase } from './database.ts';
import {
	NATIVE_TOKEN_ADDRESS,
	MULTICALL3_ADDRESS,
	WALLET_BALANCE_BATCH_SIZE,
} from './constants.ts';
import { RateLimiterManager } from './rate-limiter.ts';
import {
	toISODateString,
	getLastNDays,
	isBalanceTimestampValid,
	findBlockNumberForTimestamp,
	getWalletsBalances,
	groupMissingData,
} from './utils.ts';

export class WalletTracker {
	private config: Config;
	private clients: { [key: number]: ReturnType<typeof createPublicClient> } = {};
	private db: BalanceDatabase;
	private rateLimiter: RateLimiterManager;

	// =============== Public API ===============

	/**
	 * Creates a new WalletTracker instance
	 * @param config Configuration object containing networks, wallets, and settings
	 */
	constructor(config: Config) {
		this.config = config;
		this.initializeClients();
		this.rateLimiter = new RateLimiterManager(config.networks.map(n => n.id));
		this.db = new BalanceDatabase(config);
	}

	/**
	 * Initializes the wallet tracker
	 * Sets up the database and fetches historical data
	 */
	public async initialize(): Promise<void> {
		await this.db.initialize();
		// For initialization, we need to fetch all historical data
		const { historical: missingData } = this.checkMissingBalances();
		await this.fetchHistoricalBalances(missingData);
	}

	/**
	 * Updates current and historical balances
	 * Checks for missing data and fetches as needed
	 */
	public async updateBalances(): Promise<void> {
		if (!this.config.wallets?.length) return;

		const datesToCheck = getLastNDays(this.config.history_days);
		const fromDate = toISODateString(datesToCheck[datesToCheck.length - 1]);
		const toDate = toISODateString(datesToCheck[0]);
		logger.info(`Fetching data from ${fromDate} to ${toDate}`);

		// Check for missing data
		const { today: missingTodayData, historical: missingHistoricalData } =
			this.checkMissingBalances();

		// If we have missing data for today, fetch it
		if (missingTodayData.length > 0) {
			logger.info(`Fetching ${missingTodayData.length} missing entries for today`);
			await this.fetchTodayBalances(missingTodayData);
		}

		// If we have missing historical data, fetch it
		if (missingHistoricalData.length > 0) {
			logger.info(`Fetching ${missingHistoricalData.length} missing historical entries`);
			await this.fetchHistoricalBalances(missingHistoricalData);
		}

		logger.info(`Finished checking balances from ${fromDate} to ${toDate}`);
	}

	// =============== Private Methods ===============

	// -------- Initialization --------

	/**
	 * Initializes RPC clients for each network
	 */
	private initializeClients() {
		this.config.networks.forEach(network => {
			const chain: Chain = defineChain({
				id: network.id,
				name: network.name,
				nativeCurrency: {
					name: network.native_token.symbol,
					symbol: network.native_token.symbol,
					decimals: network.native_token.decimals,
				},
				rpcUrls: {
					default: { http: [network.rpc_url] },
					public: { http: [network.rpc_url] },
				},
				contracts: {
					multicall3: {
						address: MULTICALL3_ADDRESS,
					},
				},
			});

			this.clients[network.id] = createPublicClient({
				chain,
				transport: http(network.rpc_url),
			});
		});
	}

	// -------- Balance Checking --------

	/**
	 * Checks for missing or outdated balances and returns them grouped by today and historical dates.
	 * @returns Object containing arrays of missing data for today and historical dates
	 */
	private checkMissingBalances(): { today: MissingData[]; historical: MissingData[] } {
		const today = new Date();
		const todayStr = toISODateString(today);
		const datesToCheck = [
			today,
			...getLastNDays(this.config.history_days).filter(d => toISODateString(d) !== todayStr),
		];
		const missingTodayData: MissingData[] = [];
		const missingHistoricalData: MissingData[] = [];

		// 1. Build all queries
		const queries: {
			wallet: Wallet;
			network: Network;
			isNative: boolean;
			tokenAddress?: string;
			date: Date;
			dateStr: string;
			key: string;
		}[] = [];

		for (const wallet of this.config.wallets || []) {
			for (const network of this.config.networks) {
				for (const date of datesToCheck) {
					const dateStr = toISODateString(date);
					// Native
					queries.push({
						wallet,
						network,
						isNative: true,
						date,
						dateStr,
						key: `${wallet.address.toLowerCase()}-${network.id}-${NATIVE_TOKEN_ADDRESS.toLowerCase()}-${dateStr}`,
					});
					// Tokens
					for (const token of network.tokens) {
						queries.push({
							wallet,
							network,
							isNative: false,
							tokenAddress: token.address,
							date,
							dateStr,
							key: `${wallet.address.toLowerCase()}-${network.id}-${token.address.toLowerCase()}-${dateStr}`,
						});
					}
				}
			}
		}

		// 2. Batch DB check
		const dbResults = this.db.getBalancesTimestampsBatch(
			queries.map(q => ({
				walletAddress: q.wallet.address,
				networkId: q.network.id,
				tokenAddress: q.isNative ? NATIVE_TOKEN_ADDRESS : q.tokenAddress!,
				dateStr: q.dateStr,
			}))
		);

		// 3. Process results
		for (const q of queries) {
			const isToday = q.dateStr === todayStr;
			const arr = isToday ? missingTodayData : missingHistoricalData;
			const ts = dbResults[q.key];
			const valid = ts && isBalanceTimestampValid(ts, q.date, isToday);

			if (!valid) {
				arr.push({
					wallet: q.wallet,
					network: q.network,
					isNative: q.isNative,
					...(q.tokenAddress ? { tokenAddress: q.tokenAddress } : {}),
					date: q.date,
				});
			}
		}

		return { today: missingTodayData, historical: missingHistoricalData };
	}

	// -------- Balance Fetching --------

	/**
	 * Fetches and updates balances for today's date for the specified missing data.
	 * Uses the current block number and timestamp for accurate balance recording.
	 * Groups requests by wallet and network for efficient batching.
	 * @param missingData Array of missing data items to fetch
	 */
	private async fetchTodayBalances(missingData: MissingData[]): Promise<void> {
		if (!missingData.length) return;

		const today = new Date();
		const todayStr = today.toISOString().split('T')[0];

		// Group by wallet and network to minimize API calls
		const groupedData = groupMissingData(missingData);

		// Fetch missing data for each group
		for (const [key] of groupedData) {
			const [walletAddress, networkIdStr] = key.split('-');
			const networkId = Number(networkIdStr);
			const wallet = this.config.wallets?.find(w => w.address === walletAddress);
			const network = this.config.networks.find(n => n.id === networkId);
			if (!wallet || !network) continue;

			const blockNumber = await this.clients[network.id].getBlockNumber();
			const block = await this.clients[network.id].getBlock({ blockNumber });
			const blockTimestampDate = new Date(Number(block.timestamp) * 1000);

			await this.fetchAndSaveWalletBatches(
				[wallet],
				network,
				blockNumber,
				todayStr,
				blockTimestampDate
			);
		}
	}

	/**
	 * Fetches historical balances for the specified missing data.
	 * Uses block number mapping for historical accuracy and efficient batching.
	 * Groups requests by wallet and network to minimize API calls.
	 * @param missingData Array of missing data items to fetch
	 */
	private async fetchHistoricalBalances(missingData: MissingData[]): Promise<void> {
		if (!missingData.length) {
			return;
		}

		// Group by date first, then by wallet and network
		const groupedByDate = new Map<string, MissingData[]>();
		missingData.forEach(data => {
			const dateStr = toISODateString(data.date);
			if (!groupedByDate.has(dateStr)) {
				groupedByDate.set(dateStr, []);
			}
			groupedByDate.get(dateStr)!.push(data);
		});

		// Process each date's data
		for (const [dateStr, dateData] of groupedByDate) {
			logger.info(`Fetching ${dateData.length} missing entries for ${dateStr}`);

			// Group by wallet and network to minimize API calls
			const groupedData = groupMissingData(dateData);

			// Fetch missing data for each group
			for (const [key] of groupedData) {
				const [walletAddress, networkIdStr] = key.split('-');
				const networkId = Number(networkIdStr);
				const wallet = this.config.wallets?.find(w => w.address === walletAddress);
				const network = this.config.networks.find(n => n.id === networkId);
				if (!wallet || !network) continue;

				const blockNumber = await this.getBlockNumberForDate(new Date(dateStr), network.id);
				const block = await this.clients[network.id].getBlock({ blockNumber });
				const blockTimestampDate = new Date(Number(block.timestamp) * 1000);

				await this.fetchAndSaveWalletBatches(
					[wallet],
					network,
					blockNumber,
					dateStr,
					blockTimestampDate
				);
			}
		}
	}

	// -------- Block Number Management --------

	/**
	 * Gets the block number for a specific date
	 * Uses block time estimation and fine-tuning for accuracy
	 * @param date Target date to find block number for
	 * @param networkId Network ID to query
	 */
	private async getBlockNumberForDate(date: Date, networkId: number): Promise<bigint> {
		const dateStr = date.toISOString().split('T')[0];

		// First check if we already have a block number for this date
		const existingBlock = await this.db.getBlockNumberForDate(networkId, dateStr);
		if (existingBlock) {
			return existingBlock;
		}

		try {
			// Convert date to Unix timestamp (seconds) at end of day (23:59:59 UTC)
			const endOfDay = new Date(date);
			endOfDay.setUTCHours(23, 59, 59, 999);
			const targetTimestamp = BigInt(Math.floor(endOfDay.getTime() / 1000));

			const { blockNumber, blockTimestamp } = await findBlockNumberForTimestamp(
				this.clients[networkId],
				targetTimestamp,
				networkId
			);

			// Save the mapping for future use
			await this.db.saveBlockMapping(networkId, dateStr, blockNumber, blockTimestamp);

			return blockNumber;
		} catch (error) {
			logger.error(`Error getting block for date ${dateStr}: ${error}`);

			// Fallback to current block if timestamp query fails
			const currentBlock = await this.clients[networkId].getBlockNumber();
			return currentBlock;
		}
	}

	// -------- Helper Methods --------

	/**
	 * Helper to fetch and save wallet balances in batches for a given network and block.
	 * Handles batching, rate limiting, and saving to the database.
	 */
	private async fetchAndSaveWalletBatches(
		wallets: Wallet[],
		network: Network,
		blockNumber: bigint,
		dateStr: string,
		blockTimestampDate: Date
	): Promise<void> {
		for (let i = 0; i < wallets.length; i += WALLET_BALANCE_BATCH_SIZE) {
			const walletBatch = wallets.slice(i, i + WALLET_BALANCE_BATCH_SIZE);
			const balances = await this.rateLimiter.execute(
				network.id,
				() => getWalletsBalances(this.clients[network.id], walletBatch, network, blockNumber),
				'getWalletsBalances'
			);
			balances.forEach(balance => {
				this.db.saveBalances(balance, blockNumber, dateStr, blockTimestampDate);
			});
		}
	}
}
