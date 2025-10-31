# Snipe WDOG - Solana Transaction Watcher

## Overview
A Node.js backend application that monitors Solana blockchain transactions for specific wallets and sends Telegram alerts when certain conditions are met. The application tracks movements of WDOG tokens between a top wallet and a list of watch wallets, with configurable filtering options.

## Project Architecture
- **Type**: Backend console application (no frontend)
- **Language**: Node.js (v20)
- **Main file**: `watch-wdog.js`
- **Framework**: None (vanilla Node.js)
- **Blockchain**: Solana
- **Notifications**: Telegram Bot API

## Core Functionality
The application:
1. Monitors a top wallet and multiple watch wallets on Solana
2. Polls for new transactions at configurable intervals
3. Analyzes token transfers (specifically WDOG tokens)
4. Filters transactions based on:
   - Transaction direction (outgoing from top wallet)
   - Receiver scope (watch wallets or known exchanges)
   - Minimum token amount thresholds
5. Sends formatted alerts via Telegram when conditions match
6. Maintains state to avoid duplicate notifications

## Dependencies
- `@solana/web3.js` (^1.98.4) - Solana blockchain interaction
- `node-fetch` (2.7.0) - HTTP requests (for Telegram API)

## Environment Variables
Required for full functionality:
- `TELEGRAM_TOKEN` - Telegram bot token for sending alerts
- `TELEGRAM_CHAT_ID` - Telegram chat ID to receive alerts

Optional configuration:
- `WDOG_MINT` - Token mint address for precise filtering
- `ONLY_TOP_OUT` - Only alert on outgoing transfers (default: true)
- `RECEIVER_SCOPE` - Filter by receiver type: "any" | "watch_only" | "watch_or_cex" (default: "watch_or_cex")
- `MIN_WDOG` - Minimum token amount threshold (default: 50000)
- `RPC_ENDPOINT` - Custom Solana RPC endpoint
- `POLL_INTERVAL_MS` - Polling interval in milliseconds (default: 120000)
- `PER_ADDR_DELAY_MS` - Delay between address checks (default: 3000)
- `MAX_SIGS_PER_ADDR` - Max signatures to fetch per address (default: 3)
- `SEED_ON_FIRST_RUN` - Seed state on first run without alerts (default: true)

## State Management
- `processed_signatures.json` - Tracks processed transaction signatures to avoid duplicates
- `seeded.flag` - Indicates initial seeding has been completed

## Recent Changes
- 2025-10-30: Initial import to Replit environment
- Configured workflow for continuous monitoring
- Updated .gitignore to exclude state files

## User Preferences
None specified yet.
