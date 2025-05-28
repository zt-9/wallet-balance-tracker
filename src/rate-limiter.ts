/**
 * Rate limiter for managing API request limits
 *
 * Provides functionality for:
 * - Per-network rate limiting
 * - Request queuing and execution
 * - Automatic retry with backoff
 * - Concurrent request management
 */

import { RateLimiter } from 'limiter';
import logger from './logger.js';
import {
	NETWORK_RATE_LIMITS,
	DEFAULT_RATE_LIMIT,
	DEFAULT_RETRY_DELAY,
	DEFAULT_RETRY_TIMEOUT,
} from './constants.ts';

/**
 * Manages rate limiting for multiple networks
 * Handles token acquisition, retries, and timeouts
 */
export class RateLimiterManager {
	private limiters: { [key: number]: RateLimiter } = {};

	/**
	 * Initializes rate limiters for each network
	 * @param networkIds Array of network IDs to initialize limiters for
	 */
	constructor(networkIds: number[]) {
		networkIds.forEach(networkId => {
			const limit = NETWORK_RATE_LIMITS[networkId] ?? DEFAULT_RATE_LIMIT;
			this.limiters[networkId] = new RateLimiter({
				tokensPerInterval: limit,
				interval: 'second',
				fireImmediately: true,
			});
			logger.debug(`Initialized rate limiter for network ${networkId} with ${limit} RPS`);
		});
	}

	/**
	 * Executes a rate-limited request with retry logic
	 * @param networkId Network ID to apply rate limiting
	 * @param request The async request to execute
	 * @param operationName Optional name for logging
	 */
	public async execute<T>(
		networkId: number,
		request: () => Promise<T>,
		operationName: string = 'request'
	): Promise<T> {
		const limiter = this.limiters[networkId];
		if (!limiter) {
			throw new Error(`No rate limiter found for network ${networkId}`);
		}

		try {
			// Try to remove a token, with timeout
			const tokenRemoved = await Promise.race([
				limiter.removeTokens(1),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('Rate limit timeout')), DEFAULT_RETRY_TIMEOUT)
				),
			]);

			if (!tokenRemoved) {
				throw new Error('Failed to acquire rate limit token');
			}

			// Execute the request
			return await request();
		} catch (error) {
			if (error instanceof Error && error.message === 'Rate limit timeout') {
				logger.debug(`Rate limit timeout for network ${networkId} (${operationName}), retrying...`);
				// Wait a bit and retry
				await new Promise(resolve => setTimeout(resolve, DEFAULT_RETRY_DELAY));
				return this.execute(networkId, request, operationName);
			}
			throw error;
		}
	}

	/**
	 * Gets the current rate limit for a network
	 * @param networkId Network ID to check
	 */
	public getRateLimit(networkId: number): number {
		return NETWORK_RATE_LIMITS[networkId] ?? DEFAULT_RATE_LIMIT;
	}
}
