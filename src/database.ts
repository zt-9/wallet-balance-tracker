/**
 * Database interface for the wallet tracker
 *
 * Handles all database operations including:
 * - Wallet and balance storage
 * - Historical data management
 * - Block number caching
 * - Data validation and cleanup
 */

import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Config, WalletBalance, BalanceHistory, DisplayWalletBalance } from './types.ts';
import { EventEmitter } from 'events';
import { NATIVE_TOKEN_ADDRESS } from './constants.ts';
import { standardizeAddress } from './utils.ts';

/**
 * Represents a single balance record in the database
 */
interface BalanceRow {
	wallet_address: string;
	network_id: number;
	token_address: string;
	symbol: string;
	balance: string;
	block_number: number;
	timestamp: string;
	date: string;
	decimals: number;
}

/**
 * Manages all database operations for wallet balances
 * Handles storage, retrieval, and caching of balance data
 */
export class BalanceDatabase extends EventEmitter {
	private db!: Database.Database;
	private config: Config;

	constructor(config: Config) {
		super();
		this.config = config;
	}

	/**
	 * Initializes the database connection and creates required tables
	 */
	public async initialize(): Promise<void> {
		const dbDir = join(process.cwd(), 'data');
		await mkdir(dbDir, { recursive: true });

		this.db = new Database(join(dbDir, 'balances.db'));
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS balances (
        wallet_address TEXT NOT NULL,
        network_id INTEGER NOT NULL,
        token_address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        balance TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        date TEXT NOT NULL,
        PRIMARY KEY (wallet_address, network_id, token_address, date)
      );
      CREATE TABLE IF NOT EXISTS block_mapping (
        network_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        block_number TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (network_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_balances_wallet_network_token_date ON balances(wallet_address, network_id, token_address, date);
      CREATE INDEX IF NOT EXISTS idx_balances_network_date ON balances(network_id, date);
      CREATE INDEX IF NOT EXISTS idx_block_mapping_network_date ON block_mapping(network_id, date);
      CREATE INDEX IF NOT EXISTS idx_balances_wallet_lower ON balances(LOWER(wallet_address));
      CREATE INDEX IF NOT EXISTS idx_balances_token_lower ON balances(LOWER(token_address));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_balances_unique_lower ON balances(LOWER(wallet_address), network_id, LOWER(token_address), date);
    `);
	}

	/**
	 * Checks if a balance record exists for a specific date
	 * @param walletAddress Wallet address to check
	 * @param networkId Network ID to check
	 * @param tokenAddress Token address to check
	 * @param date Date to check
	 */
	public async hasBalanceForDate(
		walletAddress: string,
		networkId: number,
		tokenAddress: string,
		date: string
	): Promise<boolean> {
		const standardizedWalletAddress = standardizeAddress(walletAddress);
		const standardizedTokenAddress = standardizeAddress(tokenAddress);
		const stmt = this.db.prepare(`
      SELECT 1
      FROM balances
      WHERE LOWER(wallet_address) = LOWER(?)
        AND network_id = ?
        AND LOWER(token_address) = LOWER(?)
        AND date = ?
      LIMIT 1
    `);

		const result = stmt.get(standardizedWalletAddress, networkId, standardizedTokenAddress, date);
		return result !== undefined;
	}

	/**
	 * Saves wallet balances to the database
	 * @param walletBalance Balance data to save
	 * @param blockNumber Block number when balance was recorded
	 * @param dateStr Date string in YYYY-MM-DD format
	 * @param timestamp Exact timestamp of the balance
	 */
	public saveBalances(
		walletBalance: WalletBalance,
		blockNumber: bigint,
		dateStr: string,
		timestamp: Date
	): void {
		const network = this.config.networks.find(n => n.name === walletBalance.network);
		if (!network) return;

		// Standardize wallet address
		const standardizedAddress = standardizeAddress(walletBalance.address);

		// Convert timestamp to ISO string (standard, including ms)
		const timestampStr = timestamp.toISOString();

		const stmt = this.db.prepare(`
			INSERT INTO balances (
				wallet_address, network_id, token_address, symbol, balance, block_number, timestamp, date
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(LOWER(wallet_address), network_id, LOWER(token_address), date) DO UPDATE SET
				symbol=excluded.symbol,
				balance=excluded.balance,
				block_number=excluded.block_number,
				timestamp=excluded.timestamp
		`);

		// Use transaction to ensure all operations succeed or fail together
		const transaction = this.db.transaction(() => {
			try {
				// Save native token balance
				stmt.run(
					standardizedAddress,
					network.id,
					NATIVE_TOKEN_ADDRESS,
					network.native_token.symbol,
					walletBalance.native_balance,
					blockNumber.toString(),
					timestampStr,
					dateStr
				);

				// Save token balances
				walletBalance.tokens.forEach(token => {
					stmt.run(
						standardizedAddress,
						network.id,
						standardizeAddress(token.address),
						token.symbol,
						token.balance,
						blockNumber.toString(),
						timestampStr,
						dateStr
					);
				});
			} catch (error) {
				this.emit('DB saveBalances error', error);
				throw error;
			}
		});

		try {
			// Execute transaction
			transaction();
			// Emit change event
			this.emit('balancesChanged');
		} catch (error) {
			this.emit('DB saveBalances TX error', error);
			throw error;
		}
	}

	/**
	 * Retrieves balance history for a specified number of days
	 * @param config Configuration containing history_days and other settings
	 */
	public getBalanceHistory(config: Config): BalanceHistory {
		const query = config.history_days
			? `WHERE date >= date('now', '-${config.history_days - 1} days')`
			: '';

		// Build allowed wallets and tokens sets
		const allowedWallets = config.wallets
			? new Set(config.wallets.map(w => standardizeAddress(w.address)))
			: undefined;
		const allowedTokensByNetwork: Record<number, Set<string>> = {};
		for (const net of config.networks) {
			allowedTokensByNetwork[net.id] = new Set([
				standardizeAddress(NATIVE_TOKEN_ADDRESS),
				...net.tokens.map(t => standardizeAddress(t.address)),
			]);
		}

		// Add filtering conditions
		let filterConditions = '';
		const conditions = [];
		if (allowedWallets) {
			conditions.push(
				`LOWER(wallet_address) IN (${Array.from(allowedWallets)
					.map(w => `LOWER('${w}')`)
					.join(',')})`
			);
		}
		if (Object.keys(allowedTokensByNetwork).length > 0) {
			const networkConditions = Object.entries(allowedTokensByNetwork).map(
				([networkId, tokens]) =>
					`(network_id = ${networkId} AND LOWER(token_address) IN (${Array.from(tokens)
						.map(t => `LOWER('${t}')`)
						.join(',')}))`
			);
			conditions.push(`(${networkConditions.join(' OR ')})`);
		}
		if (conditions.length > 0) {
			filterConditions = query ? ' AND ' : ' WHERE ';
			filterConditions += conditions.join(' AND ');
		}

		const stmt = this.db.prepare(`
			SELECT
				wallet_address,
				network_id,
				token_address,
				symbol,
				balance,
				block_number,
				timestamp,
				date
			FROM balances
			${query}${filterConditions}
			ORDER BY date DESC, timestamp DESC
		`);

		const rows = stmt.all() as BalanceRow[];
		// Add decimals from config
		rows.forEach(row => {
			const network = config.networks.find(n => n.id === row.network_id);
			if (!network) {
				row.decimals = 18; // Default if network not found
				return;
			}

			if (standardizeAddress(row.token_address) === standardizeAddress(NATIVE_TOKEN_ADDRESS)) {
				row.decimals = network.native_token.decimals;
			} else {
				const token = network.tokens.find(
					t => standardizeAddress(t.address) === standardizeAddress(row.token_address)
				);
				row.decimals = token?.decimals ?? 18;
			}
		});
		return this.processBalanceRows(rows);
	}

	/**
	 * Processes raw balance rows into a structured history object
	 * @param rows Raw balance rows from the database
	 */
	private processBalanceRows(rows: BalanceRow[]): BalanceHistory {
		const history: { [key: string]: DisplayWalletBalance[] } = {};

		// Create a map of network IDs to names for quick lookup
		const networkNames = new Map<number, string>();
		for (const net of this.config.networks) {
			networkNames.set(net.id, net.name);
		}

		rows.forEach(row => {
			if (!history[row.timestamp]) {
				history[row.timestamp] = [];
			}

			let walletBalance = history[row.timestamp].find(
				b => b.address === row.wallet_address && b.network_id === row.network_id
			);

			if (!walletBalance) {
				const networkName = networkNames.get(row.network_id) || `Chain ID ${row.network_id}`;
				walletBalance = {
					address: row.wallet_address,
					label: undefined,
					network: networkName,
					network_id: row.network_id,
					tokens: [],
					date: row.date,
				};
				history[row.timestamp].push(walletBalance);
			}

			if (walletBalance) {
				// Add token balance
				walletBalance.tokens.push({
					address: row.token_address,
					symbol: row.symbol,
					balance: row.balance,
					decimals: row.decimals,
				});
			}
		});

		return {
			timestamp: new Date().toISOString(),
			balances: Object.values(history).flat(),
		};
	}

	/**
	 * Retrieves the block number associated with a specific date
	 * @param networkId Network ID to check
	 * @param date Date to get block number for
	 */
	public async getBlockNumberForDate(networkId: number, date: string): Promise<bigint | null> {
		const stmt = this.db.prepare(`
      SELECT block_number
      FROM block_mapping
      WHERE network_id = ? AND date = ?
    `);

		const result = stmt.get(networkId, date) as { block_number: string } | undefined;
		return result ? BigInt(result.block_number) : null;
	}

	/**
	 * Saves a mapping between dates and block numbers
	 * @param networkId Network ID
	 * @param date Date string
	 * @param blockNumber Block number
	 * @param timestamp Block timestamp
	 */
	public async saveBlockMapping(
		networkId: number,
		date: string,
		blockNumber: bigint,
		timestamp: bigint
	): Promise<void> {
		const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO block_mapping (network_id, date, block_number, timestamp)
      VALUES (?, ?, ?, ?)
    `);

		stmt.run(networkId, date, blockNumber.toString(), timestamp.toString());

		// Emit change event
		this.emit('blockMappingChanged');
	}

	/**
	 * Gets the balance for a specific wallet/token/date combination
	 * @param walletAddress Wallet address
	 * @param networkId Network ID
	 * @param tokenAddress Token address
	 * @param date Date string
	 */
	public getBalanceForDate(
		walletAddress: string,
		networkId: number,
		tokenAddress: string,
		date: string
	): string | undefined {
		const standardizedWalletAddress = standardizeAddress(walletAddress);
		const standardizedTokenAddress = standardizeAddress(tokenAddress);
		const stmt = this.db.prepare(`
      SELECT balance
      FROM balances
      WHERE LOWER(wallet_address) = LOWER(?)
        AND network_id = ?
        AND LOWER(token_address) = LOWER(?)
        AND date = ?
      LIMIT 1
    `);

		const result = stmt.get(
			standardizedWalletAddress,
			networkId,
			standardizedTokenAddress,
			date
		) as { balance: string } | undefined;
		return result ? result.balance : undefined;
	}

	/**
	 * Gets the timestamp of a balance record
	 * @param walletAddress Wallet address
	 * @param networkId Network ID
	 * @param tokenAddress Token address
	 * @param date Date string
	 */
	public getBalanceTimestampForDate(
		walletAddress: string,
		networkId: number,
		tokenAddress: string,
		date: string
	): Date | undefined {
		const standardizedWalletAddress = standardizeAddress(walletAddress);
		const standardizedTokenAddress = standardizeAddress(tokenAddress);
		const stmt = this.db.prepare(`
      SELECT timestamp
      FROM balances
      WHERE LOWER(wallet_address) = LOWER(?)
        AND network_id = ?
        AND LOWER(token_address) = LOWER(?)
        AND date = ?
      LIMIT 1
    `);
		const result = stmt.get(
			standardizedWalletAddress,
			networkId,
			standardizedTokenAddress,
			date
		) as { timestamp: string } | undefined;
		return result ? new Date(result.timestamp) : undefined;
	}

	/**
	 * Batch get balance timestamps for multiple wallet/network/token/date combinations
	 */
	public getBalancesTimestampsBatch(
		queries: { walletAddress: string; networkId: number; tokenAddress: string; dateStr: string }[]
	): { [key: string]: Date | undefined } {
		if (queries.length === 0) return {};
		const result: { [key: string]: Date | undefined } = {};

		// Build a set of unique keys for fast lookup
		const keySet = new Set(
			queries.map(
				q =>
					`${standardizeAddress(q.walletAddress)}-${q.networkId}-${standardizeAddress(q.tokenAddress)}-${q.dateStr}`
			)
		);

		// Build SQL with OR conditions
		const conditions = queries
			.map(
				() =>
					`(LOWER(wallet_address) = LOWER(?) AND network_id = ? AND LOWER(token_address) = LOWER(?) AND date = ?)`
			)
			.join(' OR ');

		const sql = `
			SELECT LOWER(wallet_address) as wallet_address, network_id, LOWER(token_address) as token_address, date, timestamp
			FROM balances
			WHERE ${conditions}
		`;

		const params = queries.flatMap(q => [
			standardizeAddress(q.walletAddress),
			q.networkId,
			standardizeAddress(q.tokenAddress),
			q.dateStr,
		]);

		const rows = this.db.prepare(sql).all(...params) as Array<{
			wallet_address: string;
			network_id: number;
			token_address: string;
			date: string;
			timestamp: string;
		}>;

		for (const row of rows) {
			const key = `${standardizeAddress(row.wallet_address)}-${row.network_id}-${standardizeAddress(row.token_address)}-${row.date}`;
			result[key] = new Date(row.timestamp);
		}

		// Fill in undefined for missing
		for (const k of keySet) {
			if (!(k in result)) result[k] = undefined;
		}
		return result;
	}
}
