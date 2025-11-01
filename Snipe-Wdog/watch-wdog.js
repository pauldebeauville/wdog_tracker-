// --- Imports ---
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// --- Environnement ---
const SOLANA_RPC = process.env.SOLANA_RPC;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WDOG_MINT = process.env.WDOG_MINT;
const LOOKBACK_TX = process.env.LOOKBACK_TX || 40;
const WDOG_ALERT_MIN = process.env.WDOG_ALERT_MIN || 1000000;
const SOL_ALERT_MIN = process.env.SOL_ALERT_MIN || 200;

// --- Connexion RPC ---
const conn = new Connection(SOLANA_RPC, "confirmed");

// --- Fonctions utilitaires ---
async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" };
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) console.error("❌ Telegram error:", await res.text());
  } catch (e) {
    console.error("❌ Telegram send failed:", e);
  }
}

function short(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
}
function fmtLamports(l) {
  return Number(l) / 1e9;
}
function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(n);
}

// --- 🔍 Récupération & parsing des transactions ---
async function fetchParsed(address) {
  // ✅ Conversion string → PublicKey
  const pubkey = new PublicKey(address);

  const sigs = await conn.getSignaturesForAddress(pubkey, { limit: Number(LOOKBACK_TX) });
  if (sigs.length === 0) return [];

  const txs = await conn.getParsedTransactions(
    sigs.map(s => s.signature),
    { maxSupportedTransactionVersion: 0 }
  );

  return txs
    .map((t, i) => ({
      signature: sigs[i].signature,
      slot: sigs[i].slot,
      err: sigs[i].err,
      tx: t,
    }))
    .filter(x => x.tx);
}

// --- 🧮 Analyse des transferts WDOG / SOL ---
function scanForSplTransfers(parsedTx, address) {
  let wdogIn = 0n,
    wdogOut = 0n,
    solIn = 0n,
    solOut = 0n,
    hitBridge = false;

  const mintWDOG = WDOG_MINT;

  try {
    const tokenTransfers = parsedTx.tx.meta?.preTokenBalances || [];
    const postTokenTransfers = parsedTx.tx.meta?.postTokenBalances || [];

    for (const balance of postTokenTransfers) {
      if (balance.mint === mintWDOG) {
        if (balance.owner === address) wdogIn += BigInt(balance.uiTokenAmount.amount);
        else wdogOut += BigInt(balance.uiTokenAmount.amount);
      }
    }

    const preBalances = parsedTx.tx.meta?.preBalances || [];
    const postBalances = parsedTx.tx.meta?.postBalances || [];

    for (let i = 0; i < preBalances.length; i++) {
      const delta = BigInt(postBalances[i]) - BigInt(preBalances[i]);
      if (delta > 0) solIn += delta;
      if (delta < 0) solOut += -delta;
    }
  } catch (err) {
    console.error("scanForSplTransfers error:", err);
  }

  return { wdogIn, wdogOut, solIn, solOut, hitBridge };
}

// --- 🚨 Main watcher ---
async function main() {
  console.log("🚀 WDOG Watcher started...");

  const targetAddress = process.env.TARGET_ADDRESS || "ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn";
  const txs = await fetchParsed(targetAddress);

  for (const tx of txs) {
    const { wdogIn, wdogOut, solIn, solOut } = scanForSplTransfers(tx, targetAddress);

    if (wdogOut > BigInt(WDOG_ALERT_MIN)) {
      const msg = `🐕 *WDOG Outflow Alert*\n\nAddress: [${short(targetAddress)}](https://solscan.io/account/${targetAddress})\nSent: *${fmtInt(Number(wdogOut))} WDOG* 🚨\n\nTx: https://solscan.io/tx/${tx.signature}`;
      await sendTelegram(msg);
    }

    if (wdogIn > BigInt(WDOG_ALERT_MIN)) {
      const msg = `🐕 *WDOG Inflow Alert*\n\nAddress: [${short(targetAddress)}](https://solscan.io/account/${targetAddress})\nReceived: *${fmtInt(Number(wdogIn))} WDOG* 💰\n\nTx: https://solscan.io/tx/${tx.signature}`;
      await sendTelegram(msg);
    }

    if (solOut > BigInt(SOL_ALERT_MIN * 1e9)) {
      const msg = `💸 *SOL Outflow Alert*\n\nAddress: [${short(targetAddress)}](https://solscan.io/account/${targetAddress})\nSent: *${fmtInt(fmtLamports(solOut))} SOL*\n\nTx: https://solscan.io/tx/${tx.signature}`;
      await sendTelegram(msg);
    }
  }

  console.log("✅ WDOG scan complete.");
}

// --- Run ---
main().catch(e => console.error("❌ WDOG Watch error:", e));
