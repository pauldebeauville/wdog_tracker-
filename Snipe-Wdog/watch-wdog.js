// =========================
// 🐶 WDOG WATCHER - multi-wallet (Top Holder + Top Inflows)
// =========================

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';

if (process.env.CI !== 'true') {
  const res = dotenv.config();
  if (res.parsed) console.log(`[dotenv] loaded ${Object.keys(res.parsed).length} keys locally`);
}

// --- CONFIG REQUISE ---
const RPC_URL = (process.env.SOLANA_RPC_URL || '').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const WDOG_MINT_STR = (process.env.WDOG_MINT || '').trim();

function must(name, val) {
  if (!val) throw new Error(`[CONFIG] Missing ${name}`);
  return val;
}
const isBase58 = (s) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);

// Vérifs strictes des secrets indispensables
must('SOLANA_RPC_URL', RPC_URL);
must('TELEGRAM_BOT_TOKEN', TELEGRAM_BOT_TOKEN);
must('TELEGRAM_CHAT_ID', TELEGRAM_CHAT_ID);
must('WDOG_MINT', WDOG_MINT_STR);
if (!isBase58(WDOG_MINT_STR)) {
  throw new Error(`[CONFIG] WDOG_MINT is not base58: "${WDOG_MINT_STR}"`);
}
const WDOG_MINT = new PublicKey(WDOG_MINT_STR);

// 🔹 LISTE DES WALLETS À SURVEILLER 🔹
// (HTX label retiré — remets l’ADRESSE réelle quand tu l’as)
const WATCH_WALLETS_STRINGS = [
  // Top Holder Kraken-funded
  "BFFPkReNnS5hayiVu1iwkaQgCYxoK7sCtZ17J6V4uUpH",
  // Top inflows
  "2Hm2PRZ2kN7ab2XyF9QmY9EG5E1yCjYQ8C3ji2s8Zp5C",
  "DQ5JWbKjzvPRLh9JPUX8cdRQ1dB6gQeh1bRmsR7fEo4Y",
  "AaZkwh9WprXqVN32f36mt7dhgA2RuBAE4k5hjyKxazsM",
  "6akCMEayNjYUZ5AjHZmrscN8tVYr59kFThQAG2ceVSmF",
  "GhPCVjvZo5Fq4vLqAGktPrcgG7n8sQfFUPYJnyd9cW6q",
  // "HTX: Hot Wallet"  <-- label supprimé : mets l'ADRESSE base58 quand tu l'auras
  "2iDCtgEYhcnRfbF9Pq1jQk4vP1EqTiAL7RyJgDsDpRmg",
  "EPyhiYkKqAXUBEmG4qkufcvNqdm4wC3AP4WxgHRF7Umh",
  "joDb79rTVsyxEZJhAVr8X7awTe2mtZtwx3WoXk4YeY9Z",
  "7WenWCTvSBxW7ye2TfqLqp8F9DeJebhso3KjmG2Qy45A"
];

// Valide chaque adresse et affiche laquelle pose problème si c’est le cas
for (const s of WATCH_WALLETS_STRINGS) {
  if (!isBase58(s)) {
    throw new Error(`[CONFIG] Invalid wallet (not base58): "${s}"`);
  }
}
const WATCH_WALLETS = WATCH_WALLETS_STRINGS.map((x) => new PublicKey(x));

const BALANCES_FILE = path.resolve(process.cwd(), 'balances.json');

// --- FONCTIONS UTILES ---
async function getTokenBalanceForOwner(connection, ownerPubkey, mintPubkey) {
  const res = await connection.getTokenAccountsByOwner(ownerPubkey, { mint: mintPubkey });
  if (!res.value?.length) return 0;
  let total = 0;
  for (const acc of res.value) {
    const bal = await connection.getTokenAccountBalance(acc.pubkey);
    total += bal?.value?.uiAmount ?? 0;
  }
  return total;
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data);
  } catch (e) {
    console.error('Telegram send failed:', e.message);
  }
}

async function readBalancesFile() {
  try { return JSON.parse(await fs.readFile(BALANCES_FILE, 'utf8')); }
  catch { return {}; }
}
async function writeBalancesFile(obj) {
  await fs.writeFile(BALANCES_FILE, JSON.stringify(obj, null, 2) + os.EOL);
}

// --- MAIN ---
async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const previous = await readBalancesFile();
  const current = {};
  const diffs = [];

  console.log(`🔍 Surveillance de ${WATCH_WALLETS.length} wallets...`);

  for (const w of WATCH_WALLETS) {
    const address = w.toBase58();
    try {
      const amt = await getTokenBalanceForOwner(connection, w, WDOG_MINT);
      current[address] = amt;
      const prev = previous[address] ?? 0;
      if (amt !== prev) diffs.push({ wallet: address, before: prev, after: amt });
    } catch (e) {
      console.error(`❌ Erreur pour ${address}:`, e.message);
    }
  }

  if (!diffs.length) {
    console.log("✅ Aucun changement détecté.");
    await writeBalancesFile(current);
    return;
  }

  // Message Telegram
  const msgLines = ["🐶 *WDOG Watcher — Mouvements détectés*", ""];
  for (const d of diffs) {
    msgLines.push(`• \`${d.wallet}\`\n   - Avant: *${d.before.toLocaleString()} WDOG*\n   - Après: *${d.after.toLocaleString()} WDOG*`);
  }
  await sendTelegramMessage(msgLines.join("\n"));
  console.log("📨 Alerte envoyée sur Telegram.");

  await writeBalancesFile(current);
}

process.on('unhandledRejection', err => { console.error(err); process.exit(1); });
process.on('uncaughtException', err => { console.error(err); process.exit(1); });

main().then(() => console.log("✅ Watch terminé"));
