// watch-wdog-alerts.js
// Alerte Telegram sur mouvements WDOG/SOL des wallets clés (Solana)

import 'dotenv/config';
import { Connection, clusterApiUrl } from '@solana/web3.js';

const {
  SOLANA_RPC,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  WDOG_MINT, // ⚠️ à renseigner (mint WDOG depuis Solscan)
  LOOKBACK_TX = '40', // nb de tx à scanner par wallet à chaque run
  WDOG_ALERT_MIN = '1000000', // seuil WDOG (tokens) pour alerte
  SOL_ALERT_MIN = '200', // seuil SOL pour alerte
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant dans .env');
  process.exit(1);
}
if (!WDOG_MINT) {
  console.error('❌ WDOG_MINT manquant dans .env (copie l’adresse mint WDOG depuis Solscan)');
  process.exit(1);
}

const conn = new Connection(SOLANA_RPC || clusterApiUrl('mainnet-beta'), 'confirmed');

// —— Adresses à surveiller (tu peux en ajouter) ——
const WATCH = {
  // Historiques / Kraken
  TOP_HOLDER: 'BFFPkReNnS5hayiVu1iwkaQgCYxoK7sCtZ17J6V4uUpH',
  SWAP_WALLET: '6akCMEAUGD6ZjC2kaMZzhAwNMw46iQA4S5TvDPTHQAG2',

  // Router Raydium/Orca (actif faible mais critique si > 1M WDOG)
  ROUTER: 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn',

  // Hub CEX / MM
  HUB: 'BfP2dBiHbiYvsmESsgHEL8wQt2z55bDNKnwmNRB34G',

  // Compte tampon SOL
  BUFFER_SOL: '4WJpib4Ruf6EYw4PTxCeoziYNUA3GAdFSJ9xWx76JnFj',
};

// (Optionnel) adresses bridge connues à compléter (ex: deBridge source sur Solana)
const BRIDGE_ADDRESSES = [
  // 'deBridgeSourcePubkeyIci'
];

const wd = BigInt(WDOG_ALERT_MIN);
const solMin = BigInt(Math.floor(Number(SOL_ALERT_MIN) * 1e9)); // lamports

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    console.error('❌ Telegram error', await res.text());
  }
}

function short(addr) { return `${addr.slice(0,6)}…${addr.slice(-6)}`; }
function fmtLamports(l) { return Number(l) / 1e9; }
function fmtInt(n) { return new Intl.NumberFormat('en-US').format(n); }

async function fetchParsed(address) {
  // On prend les dernières signatures et on parse
  const sigs = await conn.getSignaturesForAddress(address, { limit: Number(LOOKBACK_TX) });
  if (sigs.length === 0) return [];
  const txs = await conn.getParsedTransactions(sigs.map(s => s.signature), { maxSupportedTransactionVersion: 0 });
  // on reconstruit (signature + parsed)
  return txs.map((t, i) => ({ signature: sigs[i].signature, slot: sigs[i].slot, err: sigs[i].err, tx: t })).filter(x => x.tx);
}

function scanForSplTransfers(parsedTx, address) {
  // Retourne deltas WDOG (en unités) et SOL (lamports) pour l'adresse
  let wdogIn = 0n, wdogOut = 0n;
  let solIn = 0n, solOut = 0n;
  let hitBridge = false;

  const mintWDOG = WDOG_MINT;

  // 1) Instructions (top + inner)
  const allInstr = [];
  if (parsedTx.tx.transaction.message.instructions) allInstr.push(...parsedTx.tx.transaction.message.instructions);
  if (parsedTx.tx.meta?.innerInstructions) {
    parsedTx.tx.meta.innerInstructions.forEach(ii => allInstr.push(...ii.instructions));
  }

  for (const ix of allInstr) {
    const program = ix.program || ix.programId || ix.programIdIndex;
    const parsed = ix.parsed;

    // Native SOL transfer (SystemProgram)
    if (parsed?.type === 'transfer' && parsed?.info?.lamports) {
      const src = parsed.info.source;
      const dst = parsed.info.destination;
      const lamports = BigInt(parsed.info.lamports);
      if (src === address) solOut += lamports;
      if (dst === address) solIn += lamports;
    }

    // SPL Token transfers
    if (parsed?.type === 'transferChecked' || parsed?.type === 'transfer') {
      const info = parsed.info || {};
      const mint = info.mint;
      const src = info.source;
      const dst = info.destination;
      // amount: string, déjà en unités (pas en décimales)
      let amt = 0n;
      if (info.amount !== undefined) {
        // amount peut parfois être string/number
        amt = BigInt(String(info.amount));
      } else if (info.tokenAmount?.amount) {
        amt = BigInt(String(info.tokenAmount.amount));
      }

      if (mint === mintWDOG) {
        if (src === address) wdogOut += amt;
        if (dst === address) wdogIn += amt;
      }
    }

    // Détection simple bridge: si instruction touche une adresse de bridge connue
    if (!hitBridge && ix.accounts && BRIDGE_ADDRESSES.length) {
      const accs = ix.accounts.map(a => (typeof a === 'string' ? a : a.toBase58?.() || ''));
      if (accs.some(a => BRIDGE_ADDRESSES.includes(a))) {
        hitBridge = true;
      }
    }
  }

  return { wdogIn, wdogOut, solIn, solOut, hitBridge };
}

async function run() {
  const watched = Object.entries(WATCH);
  let alerts = [];

  for (const [label, addr] of watched) {
    const list = await fetchParsed(addr);
    for (const p of list) {
      const { signature } = p;
      const { wdogIn, wdogOut, solIn, solOut, hitBridge } = scanForSplTransfers(p, addr);

      // Règles d’alerte
      if (wdogIn >= wd || wdogOut >= wd) {
        const direction = wdogIn >= wd ? 'IN' : 'OUT';
        alerts.push(
          `🐶 <b>WDOG ${direction}</b> on <code>${label}</code> (${short(addr)})\n` +
          `• Amount: <b>${fmtInt((wdogIn >= wd ? wdogIn : wdogOut).toString())}</b> WDOG\n` +
          `• Tx: <a href="https://solscan.io/tx/${signature}">${signature.slice(0,12)}…</a>`
        );
      }

      if (solIn >= solMin || solOut >= solMin) {
        const direction = solIn >= solMin ? 'IN' : 'OUT';
        alerts.push(
          `🟡 <b>SOL ${direction}</b> on <code>${label}</code> (${short(addr)})\n` +
          `• Amount: <b>${fmtLamports(solIn >= solMin ? solIn : solOut).toFixed(2)}</b> SOL\n` +
          `• Tx: <a href="https://solscan.io/tx/${signature}">${signature.slice(0,12)}…</a>`
        );
      }

      if (hitBridge) {
        alerts.push(
          `🌉 <b>Bridge interaction</b> on <code>${label}</code> (${short(addr)})\n` +
          `• Tx: <a href="https://solscan.io/tx/${signature}">${signature.slice(0,12)}…</a>`
        );
      }
    }
  }

  if (alerts.length === 0) {
    console.log('No alerts this run.');
    return;
  }

  // Dédupli simple & envoi
  const msg = alerts.slice(0, 15).join('\n\n');
  await sendTelegram(`🔔 <b>WDOG Watch</b>\n${msg}`);
}

run().catch(async (e) => {
  console.error(e);
  await sendTelegram(`❌ WDOG Watch error: ${e.message || e.toString()}`);
  process.exit(1);
});
