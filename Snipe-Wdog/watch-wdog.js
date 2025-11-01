// watch-wdog.js — version anti-429
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const SOLANA_RPC      = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const TELEGRAM_BOT    = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID;
const WDOG_MINT       = process.env.WDOG_MINT;
const LOOKBACK_TX     = Number(process.env.LOOKBACK_TX || 20);      // ↓ 20 pour limiter la charge
const WDOG_ALERT_MIN  = BigInt(process.env.WDOG_ALERT_MIN || "1000000");
const SOL_ALERT_MIN   = BigInt(Math.floor(Number(process.env.SOL_ALERT_MIN || 200) * 1e9));
const TARGET_ADDRESS  = process.env.TARGET_ADDRESS || "ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn";

const conn = new Connection(SOLANA_RPC, { commitment: "confirmed" });

// ---------- utils ----------
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

// ---------- anti-429 wrapper ----------
async function withRetry(fn, {retries=6, base=500} = {}){
  let attempt = 0;
  while(true){
    try { return await fn(); }
    catch(e){
      const msg = String(e?.message || e);
      if (msg.includes("429") || msg.includes("Too many requests")) {
        const delay = base * Math.pow(2, attempt); // 0.5s,1s,2s,4s,8s,16s
        attempt++;
        if (attempt > retries) throw e;
        console.log(`Server responded 429. Retrying after ${delay}ms...`);
        await sleep(delay + Math.floor(Math.random()*150)); // petit jitter
      } else {
        throw e;
      }
    }
  }
}

// ---------- fetch + parse ----------
async function getSigs(addrPk, limit){
  return withRetry(() => conn.getSignaturesForAddress(addrPk, { limit }));
}

async function getParsedTxs(signatures){
  // batch de 10 + petite pause entre batchs pour éviter 429
  const out = [];
  for (let i=0; i<signatures.length; i+=10){
    const chunk = signatures.slice(i, i+10);
    const txs = await withRetry(() =>
      conn.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 })
    );
    out.push(...txs);
    if (i + 10 < signatures.length) await sleep(350); // pause 350ms entre batchs
  }
  return out;
}

async function fetchParsed(address){
  const pubkey = new PublicKey(address);
  const sigs = await getSigs(pubkey, LOOKBACK_TX);
  if(!sigs.length) return [];
  const txs = await getParsedTxs(sigs.map(s => s.signature));
  return txs.map((t,i)=>({ signature: sigs[i].signature, tx: t })).filter(x=>x.tx);
}

// ---------- analyze ----------
function scanForTransfers(parsedTx, watchAddr){
  // deltas WDOG & SOL pour l’adresse surveillée (approx. côté client)
  let wdogIn = 0n, wdogOut = 0n, solIn = 0n, solOut = 0n;

  const preB  = parsedTx.tx.meta?.preBalances  || [];
  const postB = parsedTx.tx.meta?.postBalances || [];
  for(let i=0;i<preB.length;i++){
    const d = BigInt(postB[i]) - BigInt(preB[i]);
    if(d>0) solIn += d;
    if(d<0) solOut += -d;
  }

  const preTB  = parsedTx.tx.meta?.preTokenBalances  || [];
  const postTB = parsedTx.tx.meta?.postTokenBalances || [];
  // on essaye de repérer la même owner (quand dispo) et le mint WDOG
  for(const p of postTB){
    if(p.mint === WDOG_MINT && p.owner === watchAddr){
      // valeur absolue car l’API ne donne pas le delta direct par owner
      wdogIn += BigInt(p.uiTokenAmount?.amount || "0");
    }
  }
  for(const p of preTB){
    if(p.mint === WDOG_MINT && p.owner === watchAddr){
      wdogOut += BigInt(p.uiTokenAmount?.amount || "0");
    }
  }

  return { wdogIn, wdogOut, solIn, solOut };
}

// ---------- main ----------
async function main(){
  console.log("⚡ WDOG Watcher started…");
  const addr = TARGET_ADDRESS;

  // petite pause initiale au cas où plusieurs jobs tournent
  await sleep(200);

  const parsed = await fetchParsed(addr);
  for(const t of parsed){
    const { wdogIn, wdogOut, solIn, solOut } = scanForTransfers(t, addr);

    if (wdogIn >= WDOG_ALERT_MIN) {
      await sendTelegram(
        `🐶 *WDOG IN* on [${short(addr)}](https://solscan.io/account/${addr})\n` +
        `• Amount ≥ *${fmt(Number(wdogIn))}* WDOG\n` +
        `• Tx: https://solscan.io/tx/${t.signature}`
      );
    }
    if (wdogOut >= WDOG_ALERT_MIN) {
      await sendTelegram(
        `🐶 *WDOG OUT* on [${short(addr)}](https://solscan.io/account/${addr})\n` +
        `• Amount ≥ *${fmt(Number(wdogOut))}* WDOG\n` +
        `• Tx: https://solscan.io/tx/${t.signature}`
      );
    }
    if (solIn >= SOL_ALERT_MIN || solOut >= SOL_ALERT_MIN) {
      const amt = solIn >= SOL_ALERT_MIN ? solIn : solOut;
      const dir = solIn >= SOL_ALERT_MIN ? "IN" : "OUT";
      await sendTelegram(
        `🟡 *SOL ${dir}* on [${short(addr)}](https://solscan.io/account/${addr})\n` +
        `• Amount ≥ *${fmt(lam(amt))}* SOL\n` +
        `• Tx: https://solscan.io/tx/${t.signature}`
      );
    }
  }

  console.log("✅ WDOG scan complete.");
}

main().catch(async (e)=>{
  console.error("❌ WDOG Watch error:", e);
  await sendTelegram(`❌ WDOG Watch error: \`${String(e.message||e)}\``);
  process.exit(1);
});
