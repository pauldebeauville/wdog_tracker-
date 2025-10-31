// =========================
// 🐶 WDOG WATCHER - multi-wallet
// - Lire la liste WDOG_WALLETS (comma-separated)
// - Comparer avec balances.json
// - Envoyer Telegram uniquement si changement (diff)
// - Mettre à jour balances.json et commit/push si GITHUB_TOKEN présent
// =========================

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
const exec = promisify(execCb);

if (process.env.CI !== 'true') {
  const res = dotenv.config();
  if (res.parsed) console.log(`[dotenv] loaded ${Object.keys(res.parsed).length} keys locally`);
}

// ---- Config / variables d'env requises ----
const required = [
  'SOLANA_RPC_URL',
  'WDOG_MINT',
  'WDOG_WALLETS',         // Liste comma-separated d'adresses à surveiller
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID'
];

for (const k of required) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    console.error(`[CONFIG] Missing environment variable: ${k}`);
    process.exit(1);
  }
}

const isBase58 = (s) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);

// Parsage des wallets
const rawWallets = process.env.WDOG_WALLETS.split(',').map(s => s.trim()).filter(Boolean);
if (!rawWallets.length) {
  console.error('[CONFIG] WDOG_WALLETS is empty after parsing');
  process.exit(1);
}
for (const w of rawWallets) {
  if (!isBase58(w)) {
    console.error(`[CONFIG] Wallet not base58: "${w}"`);
    process.exit(1);
  }
}
if (!isBase58(process.env.WDOG_MINT.trim())) {
  console.error(`[CONFIG] WDOG_MINT not base58: "${process.env.WDOG_MINT}"`);
  process.exit(1);
}

const RPC_URL = process.env.SOLANA_RPC_URL.trim();
const WDOG_MINT = new PublicKey(process.env.WDOG_MINT.trim());
const WATCH_WALLETS = rawWallets.map(s => new PublicKey(s));
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID.trim();

const BALANCES_FILE = path.resolve(process.cwd(), 'balances.json'); // stocké à la racine du repo

// --- utilitaires Solana ---
async function getTokenBalanceForOwner(connection, ownerPubkey, mintPubkey) {
  // récupère tous les comptes token de l'owner pour ce mint, puis somme les uiAmount
  try {
    const res = await connection.getTokenAccountsByOwner(ownerPubkey, { mint: mintPubkey });
    if (!res.value || res.value.length === 0) return 0;
    let sum = 0;
    for (const acc of res.value) {
      try {
        const bal = await connection.getTokenAccountBalance(acc.pubkey);
        const ui = bal?.value?.uiAmount ?? 0;
        sum += ui;
      } catch (e) {
        // ignore per-account errors but log
        console.warn('Warning getTokenAccountBalance failed for', acc.pubkey.toBase58(), e?.message || e);
      }
    }
    return sum;
  } catch (e) {
    console.error('Error getTokenAccountsByOwner:', e?.message || e);
    throw e;
  }
}

// --- Telegram ---
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Telegram API returned not ok:', data);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram send error:', err?.message || err);
    return false;
  }
}

// --- balances file read/write ---
async function readBalancesFile() {
  try {
    const raw = await fs.readFile(BALANCES_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {}; // pas de fichier encore
  }
}
async function writeBalancesFile(obj) {
  const payload = JSON.stringify(obj, null, 2) + os.EOL;
  await fs.writeFile(BALANCES_FILE, payload, 'utf8');
}

// --- commit & push (optionnel en CI) ---
async function gitCommitAndPushIfNeeded(commitMessage = 'chore: update balances.json by wdog-watcher') {
  const token = process.env.GITHUB_TOKEN || process.env.REPO_WRITE_TOKEN;
  if (!token) {
    console.log('No GITHUB_TOKEN/REPO_WRITE_TOKEN provided — skipping git commit/push.');
    return;
  }
  const repo = process.env.GITHUB_REPOSITORY; // owner/repo
  if (!repo) {
    console.log('GITHUB_REPOSITORY not set — skipping push.');
    return;
  }

  // configure git, commit file, push using token via HTTPS
  try {
    await exec('git config user.name "github-actions[bot]"');
    await exec('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
    await exec(`git add ${path.basename(BALANCES_FILE)}`);
    // check if any change staged
    const status = await exec('git status --porcelain');
    if (!status.stdout.trim()) {
      console.log('No changes to commit.');
      return;
    }
    await exec(`git commit -m "${commitMessage}"`);
    // remote push using token
    const remoteUrl = `https://${token}@github.com/${repo}.git`;
    await exec(`git push ${remoteUrl} HEAD:${process.env.GITHUB_REF_NAME || 'main'}`);
    console.log('Committed and pushed balances.json');
  } catch (e) {
    console.error('git commit/push failed:', e?.message || e);
  }
}

// --- Main ---
async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const previous = await readBalancesFile(); // { walletAddress: number, ... }
  const current = {};
  const diffs = [];

  for (const w of WATCH_WALLETS) {
    try {
      const amt = await getTokenBalanceForOwner(connection, w, WDOG_MINT);
      current[w.toBase58()] = amt;
      const prev = Number(previous[w.toBase58()] ?? 0);
      if (amt !== prev) {
        diffs.push({ wallet: w.toBase58(), before: prev, after: amt });
      }
    } catch (e) {
      console.error('Error checking wallet', w.toBase58(), e?.message || e);
      // keep previous value if available
      current[w.toBase58()] = Number(previous[w.toBase58()] ?? 0);
    }
  }

  if (diffs.length === 0) {
    console.log('No balance changes detected. Nothing to send.');
    // still update balances.json with current readings (optional) if file missing
    if (!Object.keys(previous).length) {
      await writeBalancesFile(current);
      console.log('balances.json created (initial).');
      // push if in CI
      await gitCommitAndPushIfNeeded('chore: add initial balances.json (wdog-watcher)');
    }
    return 0;
  }

  // build message
  const lines = ['🐶 *WDOG Watcher - balance changes detected*', ''];
  for (const d of diffs) {
    lines.push(`• Wallet: \`${d.wallet}\``);
    lines.push(`  - Avant : *${d.before.toLocaleString()}* WDOG`);
    lines.push(`  - Après : *${d.after.toLocaleString()}* WDOG`);
    lines.push('');
  }
  const message = lines.join('\n');

  const ok = await sendTelegramMessage(message);
  if (ok) {
    console.log('Alert sent to Telegram.');
    // write new balances and push
    await writeBalancesFile(current);
    await gitCommitAndPushIfNeeded('chore: update balances.json (wdog-watcher)');
  } else {
    console.error('Failed to send Telegram alert. Not updating balances.json.');
  }

  return 0;
}

// --- error handlers ---
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  process.exit(1);
});

// run
(async () => {
  try {
    const code = await main();
    process.exit(code ?? 0);
  } catch (e) {
    console.error('Fatal error:', e);
    process.exit(1);
  }
})();
