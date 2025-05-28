import { useEffect, useState } from 'react';
import type { FC } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { Config, DisplayWalletBalance } from '../../types.ts';
import { BalanceDatabase } from '../../database.ts';
import { WalletTracker } from '../../wallet-tracker.ts';
import { standardizeAddress } from '../../utils.ts';
import { NATIVE_TOKEN_ADDRESS } from '../../constants.ts';

interface Props {
	config: Config;
	db: BalanceDatabase;
	tracker?: WalletTracker;
}

// Utility to pad or truncate strings, robust to undefined
const pad = (str: string | undefined, len: number) =>
	(str ?? '').length > len ? (str ?? '').slice(0, len - 3) + '...' : (str ?? '').padEnd(len, ' ');

const shortenAddress = (addr: string) =>
	addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

// Utility to format balances with decimals
function formatWithDecimals(balance: string, decimals: number): string {
	if (!balance) return '';
	const value = Number(balance) / Math.pow(10, decimals);
	return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

export const TerminalUI: FC<Props> = ({ config, db, tracker }) => {
	const [balances, setBalances] = useState<DisplayWalletBalance[]>([]);
	const [isInitialLoading, setIsInitialLoading] = useState(true);
	const [isUpdating, setIsUpdating] = useState(false);
	const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
	const [error, setError] = useState<string | null>(null);

	// Dummy interval to keep the UI alive
	useEffect(() => {
		const interval = setInterval(() => {}, 1000);
		return () => clearInterval(interval);
	}, []);

	// Load balances from database
	useEffect(() => {
		let isMounted = true;
		const loadBalances = async () => {
			try {
				setError(null);
				const latestBalances = await db.getBalanceHistory(config);
				if (isMounted) {
					setBalances(latestBalances.balances);
					setLastUpdate(new Date());
				}
			} catch (error) {
				console.error('Failed to load balances:', error);
				setError('Failed to load balances. Will retry...');
			} finally {
				setIsInitialLoading(false);
			}
		};

		// Initial load
		loadBalances();

		// Listen for database changes (in-process)
		const onBalancesChanged = () => {
			loadBalances();
		};
		const onBlockMappingChanged = () => {
			loadBalances();
		};
		db.on('balancesChanged', onBalancesChanged);
		db.on('blockMappingChanged', onBlockMappingChanged);

		// Polling for cross-process changes
		const pollInterval = setInterval(loadBalances, 5000);

		return () => {
			isMounted = false;
			db.off('balancesChanged', onBalancesChanged);
			db.off('blockMappingChanged', onBlockMappingChanged);
			clearInterval(pollInterval);
		};
	}, [db, config]);

	// Start background updates
	useEffect(() => {
		if (!tracker) return; // Only run if tracker is provided
		const updateBalances = async () => {
			try {
				setIsUpdating(true);
				setError(null);
				await tracker.updateBalances();
			} catch (error) {
				console.error('Failed to update balances:', error);
				setError('Failed to update balances. Will retry...');
			} finally {
				setIsUpdating(false);
			}
		};

		updateBalances();
		const interval = setInterval(updateBalances, config.update_interval * 1000);
		return () => clearInterval(interval);
	}, [config.update_interval, tracker]);

	// Build allowed tokens per network from config
	const allowedTokensByNetwork: Record<string, Set<string>> = {};
	for (const net of config.networks) {
		allowedTokensByNetwork[net.name] = new Set([
			standardizeAddress(NATIVE_TOKEN_ADDRESS),
			...net.tokens.map(t => standardizeAddress(t.address)),
		]);
	}

	// 1. Collect all unique dates (already filtered by config.history_days)
	const allDatesSet = new Set<string>();
	balances.forEach(b => {
		if (b.date) {
			allDatesSet.add(b.date);
		}
	});
	const allDates = Array.from(allDatesSet).sort();

	// 2. Build a map: key = address+label+network+token, value = { [date]: balance }
	type RowKey = string;
	interface RowData {
		address: string;
		label: string | undefined; // Make it explicitly optional
		network: string;
		network_id: number;
		token: string;
		rowKey: RowKey;
		balancesByDate: { [date: string]: string };
	}
	const rowMap = new Map<RowKey, RowData>();
	balances.forEach(b => {
		const dateStr = b.date;
		if (!dateStr) return;

		// Find wallet label from config
		const walletConfig = config.wallets?.find(
			w => standardizeAddress(w.address) === standardizeAddress(b.address)
		);
		const walletLabel = walletConfig?.label;

		// Process all tokens (including native token)
		b.tokens.forEach(t => {
			const key = `${standardizeAddress(b.address)}|${b.network_id}|${standardizeAddress(t.address)}`;
			if (!rowMap.has(key)) {
				rowMap.set(key, {
					address: b.address,
					label: walletLabel,
					network: b.network,
					network_id: b.network_id,
					token: t.symbol,
					rowKey: key,
					balancesByDate: {},
				});
			}
			// Format token balance with decimals
			rowMap.get(key)!.balancesByDate[dateStr] = formatWithDecimals(t.balance, t.decimals);
		});
	});

	// 3. Sort/group rows by address, then network, then token
	const sortedRows = Array.from(rowMap.values()).sort((a, b) => {
		const aKey = (a.label ? a.label : '') + a.address;
		const bKey = (b.label ? b.label : '') + b.address;
		if (aKey < bKey) return -1;
		if (aKey > bKey) return 1;
		if (a.network_id < b.network_id) return -1;
		if (a.network_id > b.network_id) return 1;
		if (a.token < b.token) return -1;
		if (a.token > b.token) return 1;
		return 0;
	});

	// 4. Table column widths
	const addrCol = 28,
		netCol = 15,
		tokenCol = 10,
		dateCol = 12;

	// const filteredRows = sortedRows;
	const filteredRows = sortedRows.filter(row =>
		allDates.some(date => {
			const bal = row.balancesByDate[date];
			return bal && bal !== '0' && bal !== '0.0';
		})
	);

	// Helper to group dates by year/month
	const groupDatesByYearMonth = (dates: string[]) => {
		const groups: { year: string; month: string; days: string[] }[] = [];
		let lastYear = '';
		let lastMonth = '';
		let currentGroup: { year: string; month: string; days: string[] } | null = null;
		for (const date of dates) {
			const [year, month, day] = date.split('-');
			if (year !== lastYear || month !== lastMonth) {
				if (currentGroup) groups.push(currentGroup);
				currentGroup = { year, month, days: [day] };
				lastYear = year;
				lastMonth = month;
			} else {
				currentGroup!.days.push(day);
			}
		}
		if (currentGroup) groups.push(currentGroup);
		return groups;
	};

	const renderTable = () => {
		if (filteredRows.length === 0) {
			return <Text>No balance data available.</Text>;
		}
		// Group dates for header
		const dateGroups = groupDatesByYearMonth(allDates);
		return (
			<Box flexDirection="column">
				{/* Header: Year/Month */}
				<Box>
					<Text>{pad('Address / Label', addrCol)}</Text>
					<Text>{pad('Network', netCol)}</Text>
					<Text>{pad('Token', tokenCol)}</Text>
					{dateGroups.map((group, i) => (
						<Text key={i}>{pad(`${group.year}/${group.month}`, dateCol * group.days.length)}</Text>
					))}
				</Box>
				{/* Header: Day */}
				<Box>
					<Text>{' '.repeat(addrCol)}</Text>
					<Text>{' '.repeat(netCol)}</Text>
					<Text>{' '.repeat(tokenCol)}</Text>
					{dateGroups.map((group, i) =>
						group.days.map((day, j) => <Text key={`${i}-${j}`}>{pad(day, dateCol)}</Text>)
					)}
				</Box>
				{/* Separator */}
				<Box>
					<Text>{'-'.repeat(addrCol)}</Text>
					<Text>{'-'.repeat(netCol)}</Text>
					<Text>{'-'.repeat(tokenCol)}</Text>
					{allDates.map(date => (
						<Text key={date}>{'-'.repeat(dateCol)}</Text>
					))}
				</Box>
				{/* Rows */}
				{filteredRows.map(row => {
					const shortAddr = shortenAddress(row.address);
					const labelAndAddr = row.label ? `${row.label} (${shortAddr})` : shortAddr;
					return (
						<Box key={row.rowKey}>
							<Text>{pad(labelAndAddr, addrCol)}</Text>
							<Text>{pad(row.network, netCol)}</Text>
							<Text>{pad(row.token, tokenCol)}</Text>
							{allDates.map(date => {
								const bal = row.balancesByDate[date];
								return <Text key={date}>{pad(bal, dateCol)}</Text>;
							})}
						</Box>
					);
				})}
			</Box>
		);
	};

	return (
		<Box flexDirection="column">
			<Box marginBottom={1}>
				<Text>
					{isInitialLoading ? (
						<Text>
							<Spinner type="dots" /> Loading initial balances...
						</Text>
					) : isUpdating ? (
						<Text>
							<Spinner type="dots" /> Updating balances...
						</Text>
					) : error ? (
						<Text color="red">{error}</Text>
					) : (
						<Text>Last update: {lastUpdate.toLocaleTimeString()}</Text>
					)}
				</Text>
			</Box>
			{renderTable()}
		</Box>
	);
};
