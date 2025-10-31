# Solana WDOG Token Watcher

A Node.js application that monitors Solana blockchain transactions for WDOG token movements and sends alerts via Telegram.

## Quick Start

1. **Install dependencies** (already done):
   ```bash
   npm install
   ```

2. **Configure environment variables**:
   
   Required for Telegram alerts:
   - `TELEGRAM_TOKEN` - Your Telegram bot token
   - `TELEGRAM_CHAT_ID` - Your Telegram chat ID
   
   Optional configuration:
   - `WDOG_MINT` - Token mint address for filtering
   - `RPC_ENDPOINT` - Custom Solana RPC endpoint (recommended to avoid rate limits)
   - `ONLY_TOP_OUT` - Only alert on outgoing transfers (default: "1")
   - `RECEIVER_SCOPE` - Filter receivers: "any", "watch_only", or "watch_or_cex" (default: "watch_or_cex")
   - `MIN_WDOG` - Minimum token amount threshold (default: 50000)
   - `POLL_INTERVAL_MS` - Polling interval in milliseconds (default: 120000)
   - `PER_ADDR_DELAY_MS` - Delay between address checks (default: 3000)
   - `MAX_SIGS_PER_ADDR` - Max signatures per address (default: 3)

3. **Run the application**:
   ```bash
   npm start
   ```

## Features

- Monitors a top wallet and multiple watch wallets on Solana
- Tracks WDOG token transfers
- Filters by transaction direction, receiver type, and amount
- Sends formatted alerts via Telegram
- Built-in rate limit handling with RPC rotation
- State persistence to avoid duplicate alerts
- Initial seeding to prevent noise on first run

## How It Works

1. **Initial Seed**: On first run, the app loads recent transactions without sending alerts to build state
2. **Continuous Monitoring**: Polls monitored wallets at regular intervals
3. **Transaction Analysis**: Checks for WDOG token movements
4. **Alert Filtering**: Only sends alerts when conditions match (direction, receiver, amount)
5. **Telegram Notification**: Sends formatted alerts with transaction details and Solscan link

## Configuration

### Monitored Wallets

The application monitors one top wallet and multiple watch wallets. These are hardcoded in `watch-wdog.js` and can be modified as needed.

### RPC Endpoints

The app uses a pool of Solana RPC endpoints to avoid rate limits. You can add your own RPC endpoint by setting the `RPC_ENDPOINT` environment variable. Consider using:
- Paid RPC providers (Helius, QuickNode, Alchemy)
- Your own Solana node
- Additional free endpoints (already configured as fallbacks)

### Rate Limiting

The application has built-in protection against rate limits:
- Exponential backoff on 429 errors
- Automatic RPC rotation
- Configurable delays between requests

## Telegram Setup

1. Create a bot with [@BotFather](https://t.me/botfather)
2. Get your bot token
3. Get your chat ID by messaging [@userinfobot](https://t.me/userinfobot)
4. Set the environment variables in Replit Secrets

## State Files

- `processed_signatures.json` - Tracks processed transactions
- `seeded.flag` - Indicates initial seeding completed

These files are git-ignored and persist between runs.

## Notes

- The application runs continuously and will automatically restart in Replit
- First run will take longer as it seeds the state
- Rate limits are normal when using public RPC endpoints
- Consider using a paid RPC provider for better performance
