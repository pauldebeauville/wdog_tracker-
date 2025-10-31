{
  "name": "wdog-watcher",
  "version": "1.0.0",
  "description": "Watcher WDOG Solana avec alertes Telegram",
  "main": "watch-wdog.js",
  "type": "commonjs",
  "scripts": {
    "start": "node watch-wdog.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@solana/web3.js": "^1.95.3",
    "dotenv": "^16.4.5",
    "node-fetch": "^3.3.2"
  }
}

// =========================
// 🐶 WDOG WATCHER - v1.0
// =========================

import('dotenv').then(({ default: dotenv }) => {
  if (process.env.CI !== 'true') {
    const res = dotenv.config();
    if (res.parsed) console.log(`[dotenv] loaded ${Object.keys(res.parsed).length} keys locally`);
  }
});

import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';

// --- Vérification des variables d'environnement ---
const required = [
  'SOLANA_RPC_URL',
  'WDOG_TOP_WALLET',
  'WDOG_MINT',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID'
];

for (const k of required) {
  const v = process.env[k];
  if (!v || !String(v).trim()) {
    console.error(`[CONFIG] Missing environment variable: ${k}`);
    process.exit(1);
  }
}

const isBase58 = (s) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
['WDOG_TOP_WALLET', 'WDOG_MINT'].forEach((k) => {
  const v = process.env[k].trim();
  if (!isBase58(v)) {
    console.error(`[CONFIG] ${k} must be base58. Got: "${v}"`);
    process.exit(1);
  }
});

const RPC_URL = process.env.SOLANA_RPC_URL;
const TOP_WALLET = new PublicKey(process.env.WDOG_TOP_WALLET.trim());
const WDOG_MINT = new PublicKey(process.env.WDOG_MINT.trim());
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID.trim();

// --- Fonction principale ---
async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`🔍 Surveillance du wallet ${TOP_WALLET.toBase58()}...`);

  const balance = await connection.getTokenAccountBalance(
    (await connection.getTokenLargestAccounts(WDOG_MINT)).value[0].address
  );

  const amount = balance?.value?.uiAmount ?? 0;
  console.log(`💰 Solde actuel du top wallet : ${amount.toLocaleString()} WDOG`);

  // Envoi sur Telegram
  const msg = `🐶 WDOG Watcher\n\nTop wallet balance:\n${amount.toLocaleString()} WDOG`;
  await sendTelegramMessage(msg);

  console.log("✅ Watch terminé sans erreur.");
  process.exit(0);
}

// --- Envoi d'un message Telegram ---
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown"
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(JSON.stringify(data));
    console.log("📨 Message envoyé sur Telegram !");
  } catch (err) {
    console.error("❌ Erreur Telegram:", err.message);
  }
}

// --- Gestion d’erreurs globales ---
process.on("unhandledRejection", (err) => {
  console.error("💥 unhandledRejection:", err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("💥 uncaughtException:", err);
  process.exit(1);
});

// --- Lancement ---
main();
