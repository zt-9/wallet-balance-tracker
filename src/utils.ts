/**
 * Utility functions for time and date operations
 */

import { createPublicClient, isAddress } from 'viem';
import { NETWORK_BLOCK_TIMES, DEFAULT_BLOCK_TIME } from './constants.ts';
import { MULTICALL3_ABI, ERC20_ABI } from './abi.ts';
import { MULTICALL3_ADDRESS } from './constants.ts';
import { Wallet, Network, WalletBalance, MissingData } from './types.ts';

// Time constants in milliseconds
export const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Validates if a string is a valid Ethereum address
 * @param address Address to validate
 * @returns boolean indicating if the address is valid
 */
export function isValidEthereumAddress(address: string): boolean {
	return isAddress(address, { strict: false });
}

/**
 * Standardizes an Ethereum address to lowercase
 * @param address Address to standardize
 * @returns Standardized address as 0x-prefixed lowercase string
 * @throws Error if address is invalid
 */
export function standardizeAddress(address: string): `0x${string}` {
	if (!isAddress(address)) {
		throw new Error(`Invalid Ethereum address: ${address}`);
	}
	return address.toLowerCase() as `0x${string}`;
}

/**
 * Checks if a timestamp is within a specified duration of a target time
 * @param timestamp Timestamp to check
 * @param targetTime Target time to check against
 * @param durationMs Duration in milliseconds to check within
 * @returns boolean indicating if timestamp is within specified duration of target time
 */
export function isWithinDuration(timestamp: Date, targetTime: Date, durationMs: number): boolean {
	const diff = Math.abs(targetTime.getTime() - timestamp.getTime());
	return diff <= durationMs;
}

/**
 * Gets the end of day (23:59:59.999 UTC) for a given date
 * @param date Date to get end of day for
 * @returns Date object set to end of day
 */
export function getEndOfDay(date: Date): Date {
	const endOfDay = new Date(date);
	endOfDay.setUTCHours(23, 59, 59, 999);
	return endOfDay;
}

/**
 * Converts a Date to ISO date string (YYYY-MM-DD)
 * @param date Date to convert
 * @returns ISO date string
 */
export function toISODateString(date: Date): string {
	return date.toISOString().split('T')[0];
}

/**
 * Creates an array of dates for the last N days
 * @param days Number of days to go back
 * @param startDate Optional start date (defaults to today)
 * @returns Array of dates in UTC
 */
export function getLastNDays(days: number, startDate: Date = new Date()): Date[] {
	// Ensure start date is in UTC
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);

	// If startDate is in the future, use today instead
	const effectiveStartDate = startDate > today ? today : startDate;
	effectiveStartDate.setUTCHours(0, 0, 0, 0);

	return Array.from({ length: days }, (_, i) => {
		const date = new Date(effectiveStartDate);
		date.setUTCDate(effectiveStartDate.getUTCDate() - i);
		return date;
	});
}

/**
 * Checks if a date is today
 * @param date Date to check
 * @returns boolean indicating if date is today
 */
export function isToday(date: Date): boolean {
	const today = new Date();
	return toISODateString(date) === toISODateString(today);
}

/**
 * Checks if a balance timestamp is valid for a given date
 * @param timestamp Balance timestamp to check
 * @param date Date to check against
 * @param isCurrentDay Whether this is the current day
 * @returns boolean indicating if the timestamp is valid
 */
export function isBalanceTimestampValid(
	timestamp: Date | null | undefined,
	date: Date,
	isCurrentDay: boolean
): boolean {
	if (!timestamp) return false;

	// more generous for history day, because we failed to get a closer block number for the day in polygon
	const isValid = isCurrentDay
		? isWithinDuration(timestamp, new Date(), ONE_HOUR_MS)
		: isWithinDuration(timestamp, getEndOfDay(date), 3 * ONE_HOUR_MS);

	return isValid;
}

/**
 * Core logic for finding block number for a date
 * Pure function that doesn't depend on external modules
 * NOTE: somehow it fails to get the block number for some dates in polygon. might be some issue unique to polygon.
 * @param client Viem public client for the network
 * @param targetTimestamp Target timestamp to find block for
 * @param networkId Network ID to query
 * @returns Promise<{ blockNumber: bigint, blockTimestamp: bigint }>
 */
export async function findBlockNumberForTimestamp(
	client: ReturnType<typeof createPublicClient>,
	targetTimestamp: bigint,
	networkId: number
): Promise<{ blockNumber: bigint; blockTimestamp: bigint }> {
	// Get the current block to check if the date is in the future
	const currentBlock = await client.getBlockNumber();
	const currentBlockData = await client.getBlock({ blockNumber: currentBlock });

	if (targetTimestamp > currentBlockData.timestamp) {
		return {
			blockNumber: currentBlock,
			blockTimestamp: currentBlockData.timestamp,
		};
	}

	// Use block time in milliseconds (all integers)
	const blockTimeMs = NETWORK_BLOCK_TIMES[networkId] ?? DEFAULT_BLOCK_TIME;

	// Calculate time difference in ms
	const timeDiffMs = Number(currentBlockData.timestamp - targetTimestamp) * 1000;
	const estimatedBlocksAgo = BigInt(Math.floor(timeDiffMs / blockTimeMs));
	const estimatedBlock = currentBlock - estimatedBlocksAgo;

	// Get the block at our estimate
	const estimatedBlockData = await client.getBlock({ blockNumber: estimatedBlock });

	// If the estimated block is after the target, walk backwards until we find a block <= targetTimestamp
	if (estimatedBlockData.timestamp > targetTimestamp) {
		let blockNumber = estimatedBlock;
		let blockData = estimatedBlockData;
		while (blockData.timestamp > targetTimestamp && blockNumber > 0n) {
			blockNumber -= 1n;
			blockData = await client.getBlock({ blockNumber });
		}
		return {
			blockNumber,
			blockTimestamp: blockData.timestamp,
		};
	}

	// If we're within 1 hour (3600 seconds) of the target, we're good
	const oneHour = BigInt(3600);
	if (Math.abs(Number(estimatedBlockData.timestamp - targetTimestamp)) <= Number(oneHour)) {
		return {
			blockNumber: estimatedBlock,
			blockTimestamp: estimatedBlockData.timestamp,
		};
	}

	// If we're not close enough, do a small linear search (up to 100 blocks)
	const direction = estimatedBlockData.timestamp > targetTimestamp ? -1n : 1n;
	let currentBlockNumber = estimatedBlock;
	let closestBlock = estimatedBlock;
	let closestDiff = estimatedBlockData.timestamp - targetTimestamp;
	let lastBlockBeforeOrAtTarget = estimatedBlock;
	let lastBlockBeforeOrAtTargetTimestamp = estimatedBlockData.timestamp;

	for (let i = 0; i < 100; i++) {
		currentBlockNumber += direction;
		const blockData = await client.getBlock({ blockNumber: currentBlockNumber });
		const diff = blockData.timestamp - targetTimestamp;

		if (blockData.timestamp <= targetTimestamp) {
			lastBlockBeforeOrAtTarget = currentBlockNumber;
			lastBlockBeforeOrAtTargetTimestamp = blockData.timestamp;
		}

		if (Math.abs(Number(diff)) < Math.abs(Number(closestDiff))) {
			closestBlock = currentBlockNumber;
			closestDiff = diff;
		} else {
			// If we're getting further away, we've passed the closest block
			break;
		}
		// Stop if within 1 hour
		if (Math.abs(Number(diff)) <= Number(oneHour)) {
			closestBlock = currentBlockNumber;
			break;
		}
	}

	// After search, ensure we use the last block before or at the target timestamp
	let finalBlock = closestBlock;
	let finalBlockTimestamp = (await client.getBlock({ blockNumber: finalBlock })).timestamp;
	if (finalBlockTimestamp > targetTimestamp) {
		finalBlock = lastBlockBeforeOrAtTarget;
		finalBlockTimestamp = lastBlockBeforeOrAtTargetTimestamp;
	}

	return {
		blockNumber: finalBlock,
		blockTimestamp: finalBlockTimestamp,
	};
}

/**
 * Fetches balances for multiple wallets on a network at a specific block number using multicall.
 *
 * IMPORTANT: This function does NOT handle API rate limiting. If you are making many requests,
 * you must implement your own rate limiting or throttling in the calling code to avoid exceeding
 * RPC or API limits. The caller is also responsible for passing a properly configured client.
 *
 * @param client Viem public client for the network
 * @param wallets Array of wallets to fetch balances for
 * @param network Network to query
 * @param blockNumber Block number to query at
 * @returns Array of WalletBalance objects
 */
export async function getWalletsBalances(
	client: ReturnType<typeof createPublicClient>,
	wallets: Wallet[],
	network: Network,
	blockNumber: bigint
): Promise<WalletBalance[]> {
	const standardizedWallets = wallets.map(wallet => ({
		...wallet,
		address: standardizeAddress(wallet.address),
	}));

	const allCalls = [
		// Native balance calls
		...standardizedWallets.map(wallet => ({
			address: MULTICALL3_ADDRESS,
			abi: MULTICALL3_ABI,
			functionName: 'getEthBalance',
			args: [wallet.address],
		})),
		// Token balance calls
		...network.tokens.flatMap(token =>
			standardizedWallets.map(wallet => ({
				address: token.address as `0x${string}`,
				abi: ERC20_ABI,
				functionName: 'balanceOf',
				args: [wallet.address],
			}))
		),
	];

	const results = (await client.multicall({
		contracts: allCalls,
		blockNumber,
	})) as { result: bigint | undefined }[];

	const walletsPerToken = standardizedWallets.length;
	const nativeBalanceResults = results.slice(0, standardizedWallets.length);
	const tokenBalanceResults = results.slice(standardizedWallets.length);

	return standardizedWallets.map((wallet, walletIndex) => {
		const nativeBalance = nativeBalanceResults[walletIndex].result?.toString() || '0';
		const walletTokenBalances = network.tokens.map((token, tokenIndex) => {
			const balanceIndex = tokenIndex * walletsPerToken + walletIndex;
			const balance = tokenBalanceResults[balanceIndex].result?.toString() || '0';
			return {
				address: token.address,
				symbol: token.symbol,
				balance,
				decimals: token.decimals,
			};
		});
		return {
			address: wallet.address,
			label: wallet.label,
			network: network.name,
			network_id: network.id,
			native_balance: nativeBalance,
			tokens: walletTokenBalances,
			date: '', // The caller should set the date if needed
		};
	});
}

/**
 * Groups missing data by wallet and network
 * @param missingData Array of missing data items
 * @returns Map with key `${wallet.address}-${network.id}` and array of MissingData
 */
export function groupMissingData(missingData: MissingData[]): Map<string, MissingData[]> {
	const groupedData = new Map<string, MissingData[]>();
	missingData.forEach(item => {
		const key = `${item.wallet.address}-${item.network.id}`;
		if (!groupedData.has(key)) {
			groupedData.set(key, []);
		}
		groupedData.get(key)!.push(item);
	});
	return groupedData;
}
