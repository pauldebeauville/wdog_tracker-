import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";

const RPC = process.env.SOLANA_RPC;                  // <-- DOIT être défini (Helius)
const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
const WDOG_MINT = process.env.WDOG_MINT;
const TARGET = process.env.TARGET_ADDRESS;
const LOOKBACK_TX = Number(process.env.LOOKBACK_TX || 6);
const WDOG_ALERT_MIN = BigInt(process.env.WDOG_ALERT_MIN || "1000000"); // 1e6 = 0.001 WDOG si decimals 9

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function sendTelegram(text){
  if(!TELEGRAM_BOT || !TELEGRAM_CHAT) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`;
  try {
    const res = await fetch(url,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text })
    });
    if(!res.ok) console.error("Telegram error:", await res.text());
  } catch(e){ console.error("Telegram send failed:", e.message); }
}

function assertEnv(name, val){
  if(!val || String(val).trim()===""){
    throw new Error(`Missing env ${name}. Set it in GitHub Secrets (Settings > Secrets > Actions).`);
  }
}

async function main(){
  console.log("🐶 WDOG watcher started...");

  // Vérifs explicites (pour éviter l’erreur '_bn' incompréhensible)
  assertEnv("SOLANA_RPC", RPC);
  assertEnv("TARGET_ADDRESS", TARGET);
  assertEnv("WDOG_MINT", WDOG_MINT);

  const conn = new Connection(RPC, { commitment: "confirmed" });
  console.log("✅ Using RPC:", RPC.includes("helius") ? "Helius" : RPC);

  const targetPk = new PublicKey(TARGET); // si TARGET vide → message clair grâce à assertEnv
  const sigs = await conn.getSignaturesForAddress(targetPk, { limit: LOOKBACK_TX });
  if (!sigs.length){
    console.log("No recent tx for target. Done.");
    return;
  }

  // Parse 1 par 1 avec petite pause (robuste et gentil avec l’API)
  for (const s of sigs){
    const [tx] = await conn.getParsedTransactions([s.signature], { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;

    // Token balances diff
    const pre = tx.meta?.preTokenBalances || [];
    const post = tx.meta?.postTokenBalances || [];
    for (const pb of post){
      if (pb.mint === WDOG_MINT){
        const amt = BigInt(pb.uiTokenAmount?.amount || "0");
        if (amt >= WDOG_ALERT_MIN){
          await sendTelegram(`🚀 Mouvement WDOG détecté\nTx: https://solscan.io/tx/${s.signature}`);
        }
      }
    }
    await sleep(600);
  }

  console.log("✅ WDOG scan complete.");
}

main().catch(async (e)=>{
  console.error("❌ WDOG Watch error:", e.message);
  await sendTelegram(`❌ Erreur WDOG bot : ${e.message}`);
  process.exit(1);
});
