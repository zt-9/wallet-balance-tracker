/**
 * Configuration constants for the wallet tracker
 *
 * Contains:
 * - Network-specific settings (block times, rate limits)
 * - Default values for various parameters
 * - Contract addresses
 * - Retry and timeout configurations
 */

// Network-specific constants
export const NETWORK_BLOCK_TIMES: Record<number, number> = {
	1: 12000, // Ethereum: 12s
	137: 2000, // Polygon: 2s
	42161: 250, // Arbitrum: 0.25s
	8453: 2000, // Base: 2s
	10: 2000, // Optimism: 2s
} as const;

export const NETWORK_RATE_LIMITS: Record<number, number> = {
	1: 10, // Ethereum: 10 RPS
	137: 20, // Polygon: 20 RPS
	42161: 30, // Arbitrum: 30 RPS
	8453: 20, // Base: 20 RPS
	10: 20, // Optimism: 20 RPS
} as const;

// Default values for network parameters
export const DEFAULT_BLOCK_TIME = 12000; // Default to 12s
export const DEFAULT_RATE_LIMIT = 10; // Default to 10 RPS

// Contract addresses for common operations
export const NATIVE_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as `0x${string}`;

// Retry and timeout configuration for API calls
export const DEFAULT_MAX_RETRIES = 3; // Default number of retry attempts
export const DEFAULT_RETRY_DELAY = 1000; // Default delay between retries in milliseconds
export const DEFAULT_RETRY_TIMEOUT = 30000; // Default timeout for rate-limited requests in milliseconds

/**
 * Number of wallets to process in a single batch when fetching balances.
 * Tune this value based on RPC limits and performance needs.
 */
export const WALLET_BALANCE_BATCH_SIZE = 5;
