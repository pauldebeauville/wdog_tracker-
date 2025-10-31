// watch-wdog.js — v4.1 (WDOG balance display + multi-token tracking)
// Node 18+ (fetch natif). Dépendances: dotenv, express, @solana/web3.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");

// ===================== CONFIG =====================
const TOP_WALLET = "BFFPkReNnS5hayiVu1iwkaQgCYxoK7sCtZ17J6V4uUpH";
const WATCH_WALLETS = [
  "2Hm2PRSBARRDdz7FRuF9k4esLRjbhyjymD3KioC3ji2s",
  "DQ5JWbJyWdJeyBxZuuyu36sUBud6L6wo3aN1QC1bRmsR",
  "AaZkwhkiDStDcgrU37XAj9fpNLrD8Erz5PNkdm4k5hjy",
  "GhPCVjqHpX7xFwP4WYBzsdkqT4gnBFcVEcxi3oUPYJny",
  "BY4StcU9Y2BpgH8quZzorg31EGE4L1rjomN8FNsCBEcx",
  "6akCMEAUGD6ZjC2kaMZzhAwNMw46iQA4S5TvDPTHQAG2",
  "EPyhiYD5RpHsQJ5r9dbQet3i6WWMzTwZSVVHtfAP4Wxg",
  "joDb79syHkFU371sG7EzPp8nw6zFKWCmTuQ63wx3WoX",
  "7WenWCJHqkARsWALEK6bGmLZH7EGBVEVVNM2s4so3Kjm",
  "iGdFcQoyR2MwbXMHQskhmNsqddZ6rinsipHc4TNSdwu",
];

const WDOG_MINT = process.env.WDOG_MINT || "";
const ONLY_TOP_OUT = process.env.ONLY_TOP_OUT === "0" ? false : true;
const RECEIVER_SCOPE = process.env.RECEIVER_SCOPE || "watch_or_cex";
const MIN_WDOG = Number(process.env.MIN_WDOG || 10000);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const PING_URL = process.env.PING_URL || "";

const RPC_POOL = [
  process.env.RPC_ENDPOINT || "",
  "https://rpc.ankr.com/solana",
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
].filter(Boolean);

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 180000);
const PER_ADDR_DELAY_MS = Number(process.env.PER_ADDR_DELAY_MS || 5000);
const PAGE_LIMIT = 20;
const MAX_PAGES = 3;

const WDOG_USD_ENV = process.env.WDOG_USD
  ? Number(process.env.WDOG_USD)
  : null;

const KNOWN_EXCHANGES = {
  Kraken: [],
  Bybit: [],
  OKX: [],
  Binance: [],
  Coinbase: [],
};

// ================== INFRA & UTILS =================
let rpcIndex = 0;
let conn = new Connection(RPC_POOL[rpcIndex], "confirmed");

function rotateRPC() {
  rpcIndex = (rpcIndex + 1) % RPC_POOL.length;
  conn = new Connection(RPC_POOL[rpcIndex], "confirmed");
  log(`[RPC] Switch to ${RPC_POOL[rpcIndex]}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function jitter(ms) {
  return ms + Math.floor(Math.random() * 400);
}
function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// --- Helpers: lire le solde WDOG du top wallet ---
async function getMintBalanceUi(ownerAddr, mintAddr) {
  if (!ownerAddr || !mintAddr) return null;
  try {
    const resp = await conn.getParsedTokenAccountsByOwner(new PublicKey(ownerAddr), {
      mint: new PublicKey(mintAddr),
    });
    let sum = 0;
    for (const p of resp.value) {
      const amt = p.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
      sum += Number(amt);
    }
    return sum;
  } catch (e) {
    console.log("[RPC] getMintBalanceUi error:", e.message);
    return null;
  }
}

async function telegramSend(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log("[TG] not configured:", text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    log("[TG] send error:", e.message);
  }
}

// --- état signatures traitées ---
const STATE_FILE = path.join(__dirname, "processed_signatures.json");
let processed = [];
try {
  processed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (!Array.isArray(processed)) processed = [];
} catch {
  processed = [];
}
const PROCESSED_MAX = 50000;
function rememberSig(sig) {
  processed.push(sig);
  if (processed.length > PROCESSED_MAX) processed = processed.slice(-PROCESSED_MAX);
  fs.writeFileSync(STATE_FILE, JSON.stringify(processed));
}
function alreadySeen(sig) {
  return processed.includes(sig);
}

// --- curseurs par adresse ---
const CURSOR_FILE = path.join(__dirname, "cursors.json");
let cursors = {};
try {
  cursors = JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8"));
} catch {
  cursors = {};
}
function saveCursors() {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursors));
}

// --- fonctions de récupération RPC ---
async function safeGetSignatures(pubkey, opts) {
  let back = 500;
  for (let i = 0; i < 4; i++) {
    try {
      return await conn.getSignaturesForAddress(pubkey, opts);
    } catch (e) {
      const s = String(e);
      if (s.includes("429") || s.includes("rate")) {
        log("429 on getSignaturesForAddress. Backoff", back, "ms");
        await sleep(jitter(back));
        back *= 2;
        if (i >= 2) rotateRPC();
      } else throw e;
    }
  }
  return [];
}

async function safeGetTransaction(sig) {
  let back = 500;
  for (let i = 0; i < 4; i++) {
    try {
      return await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    } catch (e) {
      const s = String(e);
      if (s.includes("429") || s.includes("rate")) {
        log("429 on getTransaction. Backoff", back, "ms");
        await sleep(jitter(back));
        back *= 2;
        if (i >= 2) rotateRPC();
      } else throw e;
    }
  }
  return null;
}

function parseTokenDeltas(meta) {
  const pre = meta?.preTokenBalances || [];
  const post = meta?.postTokenBalances || [];
  const map = new Map();
  function k(mint, owner) {
    return `${mint}:${owner || ""}`;
  }
  function add(side, arr) {
    for (const b of arr) {
      const key = k(b.mint, b.owner || "");
      const prev = map.get(key) || {
        mint: b.mint,
        owner: b.owner || "",
        pre: 0n,
        post: 0n,
        decimals: b.uiTokenAmount?.decimals ?? 0,
      };
      const amount = BigInt(b.uiTokenAmount?.amount ?? "0");
      if (side === "pre") prev.pre = amount;
      else prev.post = amount;
      prev.decimals = b.uiTokenAmount?.decimals ?? prev.decimals ?? 0;
      map.set(key, prev);
    }
  }
  add("pre", pre);
  add("post", post);
  const deltas = [];
  for (const v of map.values()) {
    const diff = v.post - v.pre;
    if (diff !== 0n) {
      deltas.push({
        mint: v.mint,
        owner: v.owner,
        diff,
        decimals: v.decimals,
      });
    }
  }
  return deltas;
}

function toUi(diffBig, decimals) {
  const d = BigInt(10) ** BigInt(decimals || 0);
  return Number(diffBig) / Number(d);
}

// ===================== CORE =======================
async function processSignature(sig, notify = true) {
  if (alreadySeen(sig)) return;
  const tx = await safeGetTransaction(sig);
  if (!tx || !tx.transaction || !tx.transaction.message) {
    rememberSig(sig);
    return;
  }

  const meta = tx.meta;
  const deltasAll = parseTokenDeltas(meta);
  const deltas = WDOG_MINT
    ? deltasAll.filter((d) => d.mint === WDOG_MINT)
    : deltasAll;

  const sum = {};
  for (const d of deltas) {
    const ui = toUi(d.diff, d.decimals);
    sum[d.owner] = (sum[d.owner] || 0) + ui;
  }

  const topDelta = sum[TOP_WALLET] || 0;
  if (ONLY_TOP_OUT && !(topDelta < 0)) {
    rememberSig(sig);
    return;
  }
  if (MIN_WDOG && Math.abs(topDelta) < MIN_WDOG) {
    rememberSig(sig);
    return;
  }

  const receivers = Object.entries(sum)
    .filter(([o, v]) => v > 0 && o !== TOP_WALLET)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const url = `https://solscan.io/tx/${sig}`;
  const directionEmoji = topDelta < 0 ? "🔴" : "🟢";
  const directionLabel = topDelta < 0 ? "OUT" : "IN";

  const price = await getWDOGUsd();
  const absTop = Math.abs(topDelta);
  const usdTxt =
    price && absTop
      ? ` (~$${(absTop * price).toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })})`
      : "";

  const lines = [];
  lines.push(`${directionEmoji} <b>WDOG movement (${directionLabel})</b>`);
  lines.push(`Sig: <code>${sig}</code>`);
  lines.push(`🔗 ${url}`);
  if (WDOG_MINT) lines.push(`Mint: <code>${WDOG_MINT}</code>`);
  lines.push(
    `Top holder delta: <b>${topDelta.toLocaleString()}</b> WDOG${usdTxt}`
  );

  // --- afficher le solde restant du top wallet ---
  if (WDOG_MINT) {
    try {
      const remaining = await getMintBalanceUi(TOP_WALLET, WDOG_MINT);
      if (remaining !== null) {
        const remUsd =
          price && remaining
            ? ` (~$${(remaining * price).toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })})`
            : "";
        lines.push(
          `Top holder remaining: <b>${remaining.toLocaleString()}</b> WDOG${remUsd}`
        );
      }
    } catch (e) {
      console.log("[WARN] could not fetch top holder remaining:", e.message);
    }
  }

  if (receivers.length) {
    lines.push(`Receivers (top):`);
    for (const [recv, amt] of receivers) {
      lines.push(`→ <code>${recv}</code> +${Math.round(amt).toLocaleString()} WDOG`);
    }
  }

  const text = lines.join("\n");
  log("[ALERT]", text);
  if (notify) await telegramSend(text);
  rememberSig(sig);
}

// --- serveur express pour GitHub ping / uptime ---
const app = express();
app.get("/", (req, res) => res.send("✅ WDOG multi-tracker is alive"));
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    rpc: RPC_POOL[rpcIndex],
    processed: processed.length,
    cursors: Object.keys(cursors).length,
    uptime: Math.round(process.uptime()),
  });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🌐 Server running on port", PORT));

// --- Auto-ping pour garder Replit éveillé (toutes les 5 min) ---
if (PING_URL) {
  const doPing = async () => {
    try {
      const r = await fetch(PING_URL, { method: "GET" });
      console.log(
        r.ok ? "[PING OK ✅] WDOG bot self-ping" : `[PING ❌] HTTP ${r.status}`
      );
    } catch (e) {
      console.log("[PING ❌] error:", e.message);
    }
  };
  doPing();
  setInterval(doPing, 5 * 60 * 1000);
}

// --- Lancement principal ---
(async () => {
  log("🚀 WDOG watcher started. Current RPC:", RPC_POOL[rpcIndex]);
  const ADDRS = [TOP_WALLET, ...WATCH_WALLETS];

  while (true) {
    const start = Date.now();
    for (const addr of ADDRS) {
      try {
        const newSigs = await fetchNewSigsForAddress(addr);
        for (const sig of newSigs) {
          await processSignature(sig, true);
          await sleep(250);
        }
      } catch (e) {
        log("Error on address", addr, e.message);
      }
      await sleep(jitter(PER_ADDR_DELAY_MS));
    }
    const took = Date.now() - start;
    const wait = Math.max(0, jitter(POLL_INTERVAL_MS) - took);
    await sleep(wait);
  }
})();
