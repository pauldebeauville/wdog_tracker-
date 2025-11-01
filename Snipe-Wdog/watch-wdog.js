// watch-wdog.js — super-throttle anti-429
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const SOLANA_RPC     = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const TELEGRAM_BOT   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const WDOG_MINT      = process.env.WDOG_MINT;
const TARGET_ADDRESS = process.env.TARGET_ADDRESS || "ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn";

const LOOKBACK_TX    = Number(process.env.LOOKBACK_TX || 6);          // <<< très petit
const WDOG_ALERT_MIN = BigInt(process.env.WDOG_ALERT_MIN || "1000000");
const SOL_ALERT_MIN  = BigInt(Math.floor(Number(process.env.SOL_ALERT_MIN || 200) * 1e9));

const conn = new Connection(SOLANA_RPC, { commitment: "confirmed" });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function short(a){ return `${a.slice(0,6)}…${a.slice(-6)}`; }
function fmt(n){ return new Intl.NumberFormat("en-US").format(n); }
function lam(n){ return Number(n)/1e9; }

async function sendTelegram(text){
  if(!TELEGRAM_BOT || !TELEGRAM_CHAT) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT, text, parse_mode: "Markdown", disable_web_page_preview: true };
  try{
    const res = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    if(!res.ok) console.error("Telegram error:", await res.text());
  }catch(e){ console.error("Telegram send failed:", e); }
}

// ---- Retry helper (exponentiel + stop) ----
async function withRetry(fn, label="rpc"){
  let d = 600;                       // 0.6s
  for (let i=0;i<7;i++){             // <= 7 tentatives (~<1 min)
    try { return await fn(); }
    catch(e){
      const m = String(e?.message||e);
      if (m.includes("429") || m.includes("Too many requests")) {
        console.log(`429 on ${label}. retry in ${d}ms...`);
        await sleep(d + Math.floor(Math.random()*120));
        d = Math.min(d*2, 8000);     // cap 8s
      } else { throw e; }
    }
  }
  throw new Error(`Give up after retries on ${label}`);
}

// ---- Fetch signatures (petit nombre) ----
async function getSigs(pk){
  return await withRetry(
    () => conn.getSignaturesForAddress(pk, { limit: LOOKBACK_TX }),
    "getSignaturesForAddress"
  );
}

// ---- Parse transactions UNE PAR UNE (anti-429) ----
async function getParsedTxs(signatures){
  const out = [];
  for (const sig of signatures){
    const tx = await withRetry(
      () => conn.getParsedTransactions([sig], { maxSupportedTransactionVersion: 0 }),
      "getParsedTransactions"
    );
    if (tx && tx[0]) out.push(tx[0]);
    await sleep(700);                // pause entre chaque appel
  }
  return out;
}

async function fetchParsed(addrStr){
  const pk = new PublicKey(addrStr);
  const sigs = await getSigs(pk);
  if (!sigs.length) return [];
  const txs = await getParsedTxs(sigs.map(s=>s.signature));
  return txs.map((t,i)=>({ signature: sigs[i].signature, tx: t })).filter(x=>x.tx);
}

function scanForTransfers(parsedTx, watchAddr){
  let wdogIn=0n, wdogOut=0n, solIn=0n, solOut=0n;

  const preB  = parsedTx.tx.meta?.preBalances  || [];
  const postB = parsedTx.tx.meta?.postBalances || [];
  for(let i=0;i<preB.length;i++){
    const d = BigInt(postB[i]) - BigInt(preB[i]);
    if(d>0) solIn += d; if(d<0) solOut += -d;
  }

  const preTB  = parsedTx.tx.meta?.preTokenBalances  || [];
  const postTB = parsedTx.tx.meta?.postTokenBalances || [];
  for(const p of postTB){
    if(p.mint===WDOG_MINT && p.owner===watchAddr){
      wdogIn += BigInt(p.uiTokenAmount?.amount || "0");
    }
  }
  for(const p of preTB){
    if(p.mint===WDOG_MINT && p.owner===watchAddr){
      wdogOut += BigInt(p.uiTokenAmount?.amount || "0");
    }
  }
  return { wdogIn, wdogOut, solIn, solOut };
}

async function main(){
  console.log("⚡ WDOG Watcher started…");
  const addr = TARGET_ADDRESS;

  try{
    const parsed = await fetchParsed(addr);
    for(const t of parsed){
      const { wdogIn, wdogOut, solIn, solOut } = scanForTransfers(t, addr);

      if (wdogIn >= WDOG_ALERT_MIN)
        await sendTelegram(`🐶 *WDOG IN* on [${short(addr)}](https://solscan.io/account/${addr})\n• ≥ *${fmt(Number(wdogIn))}* WDOG\n• Tx: https://solscan.io/tx/${t.signature}`);
      if (wdogOut >= WDOG_ALERT_MIN)
        await sendTelegram(`🐶 *WDOG OUT* on [${short(addr)}](https://solscan.io/account/${addr})\n• ≥ *${fmt(Number(wdogOut))}* WDOG\n• Tx: https://solscan.io/tx/${t.signature}`);
      if (solIn >= SOL_ALERT_MIN || solOut >= SOL_ALERT_MIN){
        const amt = solIn>=SOL_ALERT_MIN?solIn:solOut, dir = solIn>=SOL_ALERT_MIN?"IN":"OUT";
        await sendTelegram(`🟡 *SOL ${dir}* on [${short(addr)}](https://solscan.io/account/${addr})\n• ≥ *${fmt(lam(amt))}* SOL\n• Tx: https://solscan.io/tx/${t.signature}`);
      }
    }
    console.log("✅ WDOG scan complete.");
  }catch(e){
    console.error("❌ WDOG Watch error:", e?.message || e);
    await sendTelegram(`❌ WDOG Watch error: \`${String(e?.message||e)}\``);
  }
}

main();
