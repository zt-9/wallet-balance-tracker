/**
 * Contract ABIs used for interacting with Ethereum contracts
 */

export const ERC20_ABI = [
	{
		inputs: [{ name: 'account', type: 'address' }],
		name: 'balanceOf',
		outputs: [{ name: '', type: 'uint256' }],
		stateMutability: 'view',
		type: 'function' as const,
	},
] as const;

export const MULTICALL3_ABI = [
	{
		type: 'function',
		name: 'getEthBalance',
		stateMutability: 'view',
		inputs: [{ name: 'addr', type: 'address' }],
		outputs: [{ name: 'balance', type: 'uint256' }],
	},
] as const;
