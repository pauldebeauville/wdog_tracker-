// ================================================
// 🔔 WDOG TOP-WALLET ALERT (solde change → alerte)
// ================================================

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';

// Charger .env en local seulement
if (process.env.CI !== 'true') {
  try {
    const r = dotenv.config();
    if (r.parsed) console.log(`[dotenv] loaded ${Object.keys(r.parsed).length} keys locally`);
  } catch {}
}

const req = (k) => {
  const v = (process.env[k] || '').trim();
  if (!v) throw new Error(`[CONFIG] Missing ${k}`);
  return v;
};

// Vérif base58
const isBase58 = (s) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
const mustBase58 = (name, v) => {
  if (!isBase58(v)) throw new Error(`[CONFIG] ${name} must be base58. Got: "${v}"`);
  return v;
};

// Secrets requis
const RPC_URL = req('SOLANA_RPC_URL');
const TELEGRAM_BOT_TOKEN = req('TELEGRAM_BOT_TOKEN');
const TELEGRAM_CHAT_ID = req('TELEGRAM_CHAT_ID');
const WDOG_MINT_STR = mustBase58('WDOG_MINT', req('WDOG_MINT'));
const TOP_STR = mustBase58('WDOG_TOP_WALLET', req('WDOG_TOP_WALLET'));

const WDOG_MINT = new PublicKey(WDOG_MINT_STR);
const TOP = new PublicKey(TOP_STR);

const STATE_FILE = path.resolve(process.cwd(), 'balances_top.json');

// Telegram
async function sendTG(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data);
  } catch (e) {
    console.error('Telegram send failed:', e?.message || e);
  }
}

async function readState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch { return { last: null }; }
}
async function writeState(obj) {
  await fs.writeFile(STATE_FILE, JSON.stringify(obj, null, 2) + os.EOL, 'utf8');
}

// Somme le solde WDOG du wallet (additionne tous les token accounts WDOG)
async function getWDOGBalance(connection, owner, mint) {
  const tas = await connection.getTokenAccountsByOwner(owner, { mint });
  if (!tas.value?.length) return 0;
  let sum = 0;
  for (const it of tas.value) {
    try {
      const bal = await connection.getTokenAccountBalance(it.pubkey);
      sum += bal?.value?.uiAmount ?? 0;
    } catch (e) {
      console.warn('Warn getTokenAccountBalance', it.pubkey.toBase58(), e?.message || e);
    }
  }
  return sum;
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const state = await readState(); // { last: number|null }
  const prev = typeof state.last === 'number' ? state.last : null;

  const now = await getWDOGBalance(connection, TOP, WDOG_MINT);
  console.log(`💰 TOP WDOG balance: ${now.toLocaleString()}`);

  if (prev === null) {
    // première exécution : pas d’alerte, on initialise seulement
    await writeState({ last: now });
    console.log('Initialized balances_top.json');
    return 0;
  }

  const delta = now - prev;
  if (delta === 0) {
    console.log('✅ Aucun changement WDOG sur TOP wallet.');
    return 0;
  }

  const direction = delta > 0 ? '⬆️ Entrée' : '⬇️ Sortie';
  const msg =
`🐶 *WDOG Top Wallet Movement*
Wallet: \`${TOP.toBase58()}\`
Mint: \`${WDOG_MINT.toBase58()}\`

${direction} de *${Math.abs(delta).toLocaleString()} WDOG*
Avant: *${prev.toLocaleString()}* → Après: *${now.toLocaleString()}*`;

  await sendTG(msg);
  await writeState({ last: now });
  console.log('📨 Alerte envoyée & état mis à jour.');
  return 0;
}

process.on('unhandledRejection', (e) => { console.error('unhandledRejection', e); process.exit(1); });
process.on('uncaughtException',  (e) => { console.error('uncaughtException',  e); process.exit(1); });

main().then((c) => process.exit(c ?? 0)).catch((e) => { console.error('Fatal', e); process.exit(1); });
