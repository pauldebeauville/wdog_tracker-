import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-api.projectserum.com",
  "https://rpc.ankr.com/solana"
];

const TELEGRAM_BOT = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID;
const WDOG_MINT = process.env.WDOG_MINT;
const TARGET = process.env.TARGET_ADDRESS;
const LOOKBACK_TX = Number(process.env.LOOKBACK_TX || 5);
const WDOG_ALERT_MIN = BigInt(process.env.WDOG_ALERT_MIN || "1000000");

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function sendTelegram(msg){
  if(!TELEGRAM_BOT||!TELEGRAM_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`,{
    method:"POST",
    headers:{ "Content-Type":"application/json"},
    body:JSON.stringify({chat_id:TELEGRAM_CHAT,text:msg})
  }).catch(()=>{});
}

async function safeRpcCall(fn){
  for(const url of RPCS){
    try{
      const conn = new Connection(url,"confirmed");
      return await fn(conn);
    }catch(e){
      console.log(`❌ ${url} failed (${e.message})`);
      await sleep(1000);
    }
  }
  throw new Error("All RPCs failed");
}

async function main(){
  console.log("🐶 WDOG watcher started...");
  try{
    const txs = await safeRpcCall(async(conn)=>{
      const pub = new PublicKey(TARGET);
      const sigs = await conn.getSignaturesForAddress(pub,{limit:LOOKBACK_TX});
      const parsed = await conn.getParsedTransactions(sigs.map(s=>s.signature),{maxSupportedTransactionVersion:0});
      return parsed.filter(x=>x);
    });

    for(const t of txs){
      const pre = t.meta?.preTokenBalances||[];
      const post = t.meta?.postTokenBalances||[];
      for(const p of post){
        if(p.mint===WDOG_MINT){
          const amt = BigInt(p.uiTokenAmount.amount||"0");
          if(amt>WDOG_ALERT_MIN){
            await sendTelegram(`🚀 Mouvement WDOG détecté\nTx: https://solscan.io/tx/${t.transaction.signatures[0]}`);
          }
        }
      }
    }

    console.log("✅ WDOG scan terminé sans erreur");
  }catch(e){
    console.error("❌ Watch error:",e.message);
    await sendTelegram(`❌ Erreur WDOG bot : ${e.message}`);
  }
}

main();
