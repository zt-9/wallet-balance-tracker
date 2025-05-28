export interface Token {
	address: string;
	symbol: string;
	decimals: number;
}

export interface Network {
	id: number;
	name: string;
	rpc_url: string;
	native_token: {
		symbol: string;
		decimals: number;
	};
	tokens: Token[];
}

export interface Wallet {
	address: string;
	label?: string;
}

export interface WalletGroup {
	name: string;
	wallets: Wallet[];
}

export interface Config {
	update_interval: number;
	history_days: number;
	wallets_file: string;
	wallets?: Wallet[];
	networks: Network[];
}

export interface TokenBalance {
	address: string;
	symbol: string;
	balance: string;
	decimals: number;
}

export interface WalletBalance {
	address: string;
	label: string | undefined;
	network: string;
	network_id: number;
	native_balance: string;
	tokens: TokenBalance[];
	date: string;
}

export interface BalanceHistory {
	timestamp: string;
	balances: DisplayWalletBalance[];
}

/**
 * Represents a wallet balance in the balance history display
 * This is separate from the database WalletBalance to avoid breaking changes
 */
export interface DisplayWalletBalance {
	address: string;
	label: string | undefined;
	network: string;
	network_id: number;
	tokens: TokenBalance[];
	date: string;
}

export interface MissingData {
	wallet: Wallet;
	network: Network;
	isNative: boolean;
	tokenAddress?: string;
	date: Date;
}

export interface BalanceCheckResult {
	hasCurrentData: boolean;
	needsHistoricalFetch: boolean;
}
