// watch-wdog-multi.js — surveille plusieurs wallets (simple)
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";

const RPC = process.env.SOLANA_RPC;
const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
const WDOG_MINT = process.env.WDOG_MINT;
const LOOKBACK_TX = Number(process.env.LOOKBACK_TX || 6);
const WDOG_ALERT_MIN = BigInt(process.env.WDOG_ALERT_MIN || "1000000");

// <-- liste à adapter / copier-coller les adresses que tu veux monitorer
const WATCH = [
  { label: "Top_holder", addr: "BFFPkReNnS5hayiVu1iwkaQgCYxoK7sCtZ17J6V4uUpH" },
  { label: "Swap_wallet", addr: "6akCMEAUGD6ZjC2kaMZzhAwNMw46iQA4S5TvDPTHQAG2" },
  { label: "Router", addr: "ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn" },
  { label: "Raydium_V4", addr: "ARu4n5mFdZr..." }, // remplace par l'adresse exacte si besoin
  { label: "Hub_CEX", addr: "BfP2dBiHbiYvsmESsgHEL8wQt2z55bDNKnwmNRB34G" },
  { label: "Buffer_SOL", addr: "4WJpib4Ruf6EYw4PTxCeozjYN..." }
];

async function sendTelegram(text){
  if(!TELEGRAM_BOT||!TELEGRAM_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:TELEGRAM_CHAT, text})
  }).catch(()=>{});
}

const conn = new Connection(RPC, { commitment: "confirmed" });

async function checkAddress(entry){
  const pk = new PublicKey(entry.addr);
  const sigs = await conn.getSignaturesForAddress(pk, { limit: LOOKBACK_TX });
  for(const s of sigs){
    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if(!tx) continue;
    const post = tx.meta?.postTokenBalances || [];
    for(const p of post){
      if(p.mint === WDOG_MINT){
        const amt = BigInt(p.uiTokenAmount?.amount || "0");
        if(amt >= WDOG_ALERT_MIN){
          await sendTelegram(`🚨 ${entry.label} (${entry.addr.slice(0,6)}…${entry.addr.slice(-6)})\n${amt} WDOG\nTx: https://solscan.io/tx/${s.signature}`);
        }
      }
    }
  }
}

(async function(){
  for(const w of WATCH){
    try{ await checkAddress(w); }catch(e){ console.error("err", w.label, e.message); }
    await new Promise(r=>setTimeout(r, 400)); // gentle pause
  }
  console.log("Scan done.");
})();
