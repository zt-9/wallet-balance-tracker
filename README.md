# Wallet Tracker

Track wallet balances across multiple EVM-compatible networks (Ethereum, Polygon, Arbitrum, Optimism, Base, etc.) with historical data, SQLite backend, and terminal/web UIs.

## Prerequisites

- Node.js v18+
- pnpm (or npm)

## Install

```sh
pnpm install
# or
npm install
```

## Configure

Edit `wallets.toml` to set up:

- Networks (id, name, rpc_url, native_token, tokens)
- Wallet addresses
- `history_days` (number of days to backfill)

Example:

```toml
wallets = [
  { address = "0x1234567890123456789012345678901234567890", label = "Main Wallet" },
  { address = "0x0987654321098765432109876543210987654321", label = "Trading Wallet" }
]

history_days = 7

[[networks]]
id = 1
name = "Ethereum"
rpc_url = "https://eth-mainnet.g.alchemy.com/v2/your-key"
[native_token]
symbol = "ETH"
decimals = 18
[[networks.tokens]]
address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
symbol = "USDC"
decimals = 6
```

## Usage

**Fetch balances (historical & current):**

```sh
pnpm dev-fetcher
```

**Terminal UI:**

```sh
pnpm dev-ui
```

**Web UI:**

```sh
pnpm dev-web
```

- Data is stored in `balances.db` (SQLite)
- Only missing or outdated data is fetched

---

For issues or improvements, open a PR or issue.
