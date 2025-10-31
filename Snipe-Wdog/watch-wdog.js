// WDOG Multi-Tracker — full JS (Node 18+)
// Déps: @solana/web3.js
// Envs: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, RPC_ENDPOINT, WDOG_MINT, TOP_WALLET, WATCH_WALLETS

// ---------- Imports & setup ----------
const { Connection, PublicKey } = require("@solana/web3.js");

// Chargement .env en local (ne gêne pas GitHub Actions)
try { require("dotenv").config(); } catch (_) {}

// ---------- Environnement ----------
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const RPC_ENDPOINT     = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

const WDOG_MINT_STR    = process.env.WDOG_MINT || "GYKmdfCumZvrqcfh1Gg57B9juzSRij3LBluwv79rpump"; // ajuste si besoin
const WDOG_MINT        = new PublicKey(WDOG_MINT_STR);

const TOP_WALLET_STR   = process.env.TOP_WALLET || "BFFPkReNnS5hayiVu1iwkaQgCYxoK7sCtZ17J6V4uUpH";
const TOP_WALLET       = new PublicKey(TOP_WALLET_STR);

const WATCH_WALLETS_STR = (process.env.WATCH_WALLETS || "").trim();
const WATCH_WALLETS     = WATCH_WALLETS_STR
  ? WATCH_WALLETS_STR.split(",").map(s => s.trim()).filter(Boolean)
  : [];

// Liste des adresses à surveiller (string base58)
const MONITORED = Array.from(new Set([TOP_WALLET_STR, ...WATCH_WALLETS]));

const connection = new Connection(RPC_ENDPOINT, "confirmed");

// Curseurs : dernière signature vue par adresse (limite la redite)
const cursors = {}; // { addrBase58: signature }

// ---------- Utils ----------
function log(...a) { console.log(new Date().toISOString(), ...a); }

async function telegramSend(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log("[TELEGRAM] non-configuré, message ignoré:", text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = new URLSearchParams({
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown"
  });

  const r = await fetch(url, { method: "POST", body });
  if (!r.ok) {
    const t = await r.text().catch(()=>"?");
    log("[TELEGRAM] FAIL", r.status, t);
  }
}

// convertit amount+decimals (string) en nombre "UI" (Number)
function toUi(amountStr, decimals) {
  try {
    return Number(BigInt(amountStr)) / 10 ** decimals;
  } catch {
    return 0;
  }
}

// ---------- Signatures: fetch par adresse ----------
async function fetchNewSigsForAddress(addrBase58, limit = 20) {
  const addr = new PublicKey(addrBase58);
  const before = cursors[addrBase58];
  const opts = before ? { before, limit } : { limit };

  const sigInfos = await connection.getSignaturesForAddress(addr, opts);
  if (sigInfos.length > 0) {
    cursors[addrBase58] = sigInfos[0].signature; // le plus récent
  }
  return sigInfos.map(s => s.signature); // on retourne la liste de signatures (strings)
}

// ---------- Solde WDOG du top holder ----------
async function getTopHolderWdogBalance() {
  const resp = await connection.getTokenAccountsByOwner(
    TOP_WALLET,
    { mint: WDOG_MINT },
    "confirmed"
  );

  let raw = 0n;
  let decimals = 6; // défaut si manquant
  for (const { account } of resp.value) {
    const info = account.data.parsed.info;
    raw      += BigInt(info.tokenAmount.amount);
    decimals  = info.tokenAmount.decimals ?? decimals;
  }
  return { raw, decimals, ui: Number(raw) / 10 ** decimals };
}

// ---------- Parsing d'une transaction pour WDOG ----------
async function processSignature(sig) {
  const signature = typeof sig === "string" ? sig : sig?.signature;
  if (!signature) return;

  // On récupère la TX parsée
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0
  });

  if (!tx || !tx.meta) return;

  const pre  = tx.meta.preTokenBalances  || [];
  const post = tx.meta.postTokenBalances || [];

  // on filtre les lignes sur la mint WDOG uniquement
  const preWDOG  = pre.filter(b => b.mint === WDOG_MINT_STR);
  const postWDOG = post.filter(b => b.mint === WDOG_MINT_STR);

  if (preWDOG.length === 0 && postWDOG.length === 0) return; // pas de WDOG ici

  // Construire un map "owner => {deltaUi, decimals}" pour détecter les variations par propriétaire
  const byOwner = new Map(); // ownerBase58 -> { pre: {amount,decimals}, post: {amount,decimals} }

  function index(mapArr, side) {
    for (const b of mapArr) {
      const owner = b.owner || b.ownerProgram || b.account || b.wallet || ""; // champs varient selon RPC
      const key   = owner || b.owner || ""; // best effort
      if (!key) continue;
      const entry = byOwner.get(key) || { pre: null, post: null };
      entry[side] = {
        amount: b.tokenAmount?.amount ?? "0",
        decimals: b.tokenAmount?.decimals ?? 6
      };
      byOwner.set(key, entry);
    }
  }

  index(preWDOG,  "pre");
  index(postWDOG, "post");

  // Calcule deltas
  const deltas = []; // { owner, deltaUi, decimals }
  for (const [owner, rec] of byOwner.entries()) {
    const preAmt  = rec.pre  ? rec.pre.amount  : "0";
    const postAmt = rec.post ? rec.post.amount : "0";
    const decimals = (rec.post?.decimals) ?? (rec.pre?.decimals) ?? 6;

    const d = Number(BigInt(postAmt) - BigInt(preAmt)) / 10 ** decimals;
    if (Math.abs(d) > 0) {
      deltas.push({ owner, deltaUi: d, decimals });
    }
  }

  if (deltas.length === 0) return; // pas de mouvement WDOG détecté

  // On ne spamme que si au moins un owner fait partie des adresses surveillées
  const interesting = deltas.filter(d => MONITORED.includes(d.owner));
  if (interesting.length === 0) return;

  // Prépare un résumé par owner surveillé
  const lines = interesting
    .map(d => {
      const emoji = d.deltaUi > 0 ? "🟢 +" : "🔴 ";
      return `${emoji}${Math.abs(d.deltaUi).toLocaleString(undefined, { maximumFractionDigits: 6 })} WDOG — \`${d.owner}\``;
    })
    .join("\n");

  // Si le top holder est dedans, ajoute son solde actuel
  let extra = "";
  if (interesting.some(d => d.owner === TOP_WALLET_STR)) {
    try {
      const bal = await getTopHolderWdogBalance();
      extra = `\n🧮 Top holder balance: ${bal.ui.toLocaleString(undefined, { maximumFractionDigits: 6 })} WDOG`;
    } catch (e) {
      extra = `\n🧮 Top holder balance: (erreur: ${e.message})`;
    }
  }

  const msg =
    `🐶 *WDOG movement detected*\n` +
    `${lines}\n` +
    `🔗 https://solscan.io/tx/${signature}` +
    extra;

  await telegramSend(msg);
}

// ---------- Un passage sur toutes les adresses ----------
async function runOnce() {
  log("🚀 WDOG watcher started. Current RPC:", RPC_ENDPOINT);
  for (const addr of MONITORED) {
    try {
      const newSigs = await fetchNewSigsForAddress(addr, 20);
      for (const s of newSigs) {
        try {
          await processSignature(s);
          await new Promise(r => setTimeout(r, 120)); // petit throttle
        } catch (e) {
          log("Error processing sig", s, e.message);
        }
      }
    } catch (e) {
      log("Error on address", addr, e.message);
    }
    await new Promise(r => setTimeout(r, 120));
  }
}

// ---------- Main ----------
(async () => {
  try {
    await runOnce();

    // Sur GitHub Actions (cron), un seul passage suffit : le job s'arrête ici.
    // En local, si tu veux boucler toutes X minutes, décommente ci-dessous:
    //
    // setInterval(runOnce, 2 * 60 * 1000); // ex: toutes les 2 minutes

  } catch (e) {
    log("Fatal:", e.message);
    process.exitCode = 1;
  }
})();
