// Snipe-Wdog/watch-wdog.js — version finale sans batch (compatible Helius Free)
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";

const RPC = process.env.SOLANA_RPC;                  // Helius (obligatoire)
const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
const WDOG_MINT = process.env.WDOG_MINT;             // mint WDOG
const TARGET = process.env.TARGET_ADDRESS;           // wallet à surveiller

const LOOKBACK_TX = Number(process.env.LOOKBACK_TX || 6);
const WDOG_ALERT_MIN = BigInt(process.env.WDOG_ALERT_MIN || "1000000"); // seuil en unités

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendTelegram(text){
  if(!TELEGRAM_BOT || !TELEGRAM_CHAT) return;
  try{
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`,{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text })
    });
    if(!r.ok) console.error("Telegram error:", await r.text());
  }catch(e){ console.error("Telegram send failed:", e.message); }
}

function assertEnv(name, val){
  if(!val || String(val).trim()===""){
    throw new Error(`Missing env ${name}. Set it in GitHub Secrets.`);
  }
}

async function main(){
  console.log("🐶 WDOG watcher started...");
  assertEnv("SOLANA_RPC", RPC);
  assertEnv("TARGET_ADDRESS", TARGET);
  assertEnv("WDOG_MINT", WDOG_MINT);

  const conn = new Connection(RPC, { commitment: "confirmed" });
  console.log("✅ Using RPC:", RPC.includes("helius") ? "Helius" : RPC);

  const targetPk = new PublicKey(TARGET);

  // 1) Récupère les signatures (OK plan gratuit)
  const sigs = await conn.getSignaturesForAddress(targetPk, { limit: LOOKBACK_TX });
  if(!sigs.length){ console.log("No recent tx for target. Done."); return; }

  // 2) PARSE **SANS BATCH** : getParsedTransaction(signature) (singulier)
  for(const s of sigs){
    let tx;
    try{
      tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    }catch(e){
      console.error("getParsedTransaction error:", e?.message || e);
      await sleep(500);
      continue;
    }
    if(!tx){ await sleep(300); continue; }

    const post = tx.meta?.postTokenBalances || [];
    for(const p of post){
      if(p.mint === WDOG_MINT){
        const amt = BigInt(p.uiTokenAmount?.amount || "0");
        if (amt >= WDOG_ALERT_MIN){
          await sendTelegram(`🚀 Mouvement WDOG détecté\nTx: https://solscan.io/tx/${s.signature}`);
        }
      }
    }
    await sleep(400); // douceur RPC
  }

  console.log("✅ WDOG scan complete.");
}

main().catch(async (e)=>{
  console.error("❌ WDOG Watch error:", e?.message || e);
  await sendTelegram(`❌ Erreur WDOG bot : ${e?.message || e}`);
  process.exit(1);
});
