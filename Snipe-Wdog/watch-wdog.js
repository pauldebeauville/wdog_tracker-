// WDOG Watcher — v6 (multi-tokens + SOL native tracking + improved alerts)
// Node 18+ (fetch natif). Dépendances: dotenv, express, @solana/web3.js

const fs = require("fs");
const path = require("path");

// ✅ Charge le .env local s’il existe (Replit/local), sinon utilise les secrets GitHub
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath, override: true });
  console.log("[DEBUG] Using local .env:", envPath);
} else {
  console.log("[INFO] No local .env file (CI mode). Using GitHub Secrets.");
}

// Debug optionnel
console.log("[DEBUG] Telegram token suffix =", (process.env.TELEGRAM_TOKEN || "").slice(-6));

const express = require("express");
const { Connection, PublicKey } = require("@solana/web3.js");

// --- DEBUG .ENV CHEMIN ET CONTENU ---
console.log("[DEBUG] Loaded .env from:", require("path").resolve(".env"));

try {
  const content = require("fs").readFileSync(require("path").resolve(".env"), "utf8");
  console.log("\n========== .ENV CONTENT DETECTED ==========\n");
  console.log(content);
  console.log("===========================================\n");
} catch (err) {
  console.log("❌ No .env file found at expected path:", err.message);
}

// --- DEBUG TELEGRAM ENV ---
console.log("[DEBUG] Telegram token suffix =", (process.env.TELEGRAM_TOKEN || "").slice(-6));
console.log("[DEBUG] .env path =", require("path").resolve(".env"));


// =============== CONFIG ===================
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
const TRACK_MINTS = (process.env.TRACK_MINTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TRACK_SOL = process.env.TRACK_SOL === "1";

const MIN_WDOG = Number(process.env.MIN_WDOG || 10000);
const MIN_SPL = Number(process.env.MIN_SPL || 50);
const MIN_SOL = Number(process.env.MIN_SOL || 0.25);

const TELEGRAM_TOKEN = (process.env.TELEGRAM_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const PING_URL = (process.env.PING_URL || "").trim();

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

// ================== CEX connus ==================
const KNOWN_EXCHANGES = {
  Kraken: [
    // "ExempleAdresseKraken1",
  ],
  Bybit: [
    // "ExempleAdresseBybit1",
  ],
  OKX: [
    // "ExempleAdresseOKX1",
  ],
  Binance: [],
  Coinbase: [],
};

// Fonction utilitaire pour vérifier si une adresse appartient à un CEX connu
function isCexAddress(addr) {
  return Object.values(KNOWN_EXCHANGES).some((list) => list.includes(addr));
}

// Scope de filtrage des alertes SOL : "top_only" | "top_or_cex" | "all"
const SOL_SCOPE = (process.env.SOL_SCOPE || "top_or_cex").trim();

// Sécurité / robustesse
process.on("uncaughtException", (e) => console.error("Uncaught:", e));
process.on("unhandledRejection", (e) => console.error("Unhandled:", e));

// =============== UTILS =====================
let rpcIndex = 0;
let conn = new Connection(RPC_POOL[rpcIndex], "confirmed");

function rotateRPC() {
  rpcIndex = (rpcIndex + 1) % RPC_POOL.length;
  conn = new Connection(RPC_POOL[rpcIndex], "confirmed");
  console.log(`[RPC] switch → ${RPC_POOL[rpcIndex]}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 400);
}

async function telegramSend(text) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const threadId = process.env.TELEGRAM_THREAD_ID; // optionnel (topic)

  if (!token || !chatId) {
    console.log("[TG] missing token or chat id");
    return;
  }

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (threadId) payload.message_thread_id = Number(threadId);

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const bodyText = await res.text();
    if (!res.ok) {
      console.log("[TG] HTTP error:", res.status, bodyText);
      return;
    }

    let body;
    try { body = JSON.parse(bodyText); } catch { body = { ok: false, raw: bodyText }; }
    if (!body.ok) {
      console.log("[TG] API error:", body);
    } else {
      console.log("[TG] sent ✔");
    }
  } catch (e) {
    console.log("[TG] send error:", e.message);
  }
}


// =============== STATE =====================
const STATE_FILE = path.join(__dirname, "processed_signatures.json");
let processed = [];
try {
  processed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
} catch {
  processed = [];
}
function rememberSig(sig) {
  processed.push(sig);
  if (processed.length > 50000) processed = processed.slice(-50000);
  fs.writeFileSync(STATE_FILE, JSON.stringify(processed));
}
function alreadySeen(sig) {
  return processed.includes(sig);
}

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

async function safeGetSignatures(pubkey, opts) {
  let back = 500;
  for (let i = 0; i < 4; i++) {
    try {
      return await conn.getSignaturesForAddress(pubkey, opts);
    } catch (e) {
      if (String(e).includes("429")) {
        await sleep(jitter(back));
        back *= 2;
        rotateRPC();
      } else {
        throw e;
      }
    }
  }
  return [];
}

async function safeGetTransaction(sig) {
  let back = 500;
  for (let i = 0; i < 4; i++) {
    try {
      return await conn.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (e) {
      if (String(e).includes("429")) {
        await sleep(jitter(back));
        back *= 2;
        rotateRPC();
      } else {
        throw e;
      }
    }
  }
  return null;
}

// =============== CORE ======================
function parseTokenDeltas(meta) {
  const pre = meta?.preTokenBalances || [];
  const post = meta?.postTokenBalances || [];
  const map = new Map();

  function key(mint, owner) {
    return `${mint}:${owner}`;
  }

  for (const b of pre) {
    map.set(key(b.mint, b.owner), {
      mint: b.mint,
      owner: b.owner,
      pre: BigInt(b.uiTokenAmount?.amount || "0"),
      post: 0n,
      dec: b.uiTokenAmount?.decimals || 0,
    });
  }

  for (const b of post) {
    const k = key(b.mint, b.owner);
    const v =
      map.get(k) || {
        mint: b.mint,
        owner: b.owner,
        pre: 0n,
        post: 0n,
        dec: b.uiTokenAmount?.decimals || 0,
      };
    v.post = BigInt(b.uiTokenAmount?.amount || "0");
    map.set(k, v);
  }

  const out = [];
  for (const v of map.values()) {
    const diff = v.post - v.pre;
    if (diff !== 0n) out.push({ mint: v.mint, owner: v.owner, diff, decimals: v.dec });
  }
  return out;
}

function toUi(diff, dec) {
  return Number(diff) / 10 ** dec;
}

function isAddrOfInterest(addr) {
  return addr === TOP_WALLET || WATCH_WALLETS.includes(addr);
}

async function getWDOGUsd() {
  try {
    const res = await fetch(
      "https://api.dexscreener.com/latest/dex/tokens/GYKmdfcUmZVrqfcH1g579BGjuzSRijj3LBuwv79rpump"
    );
    const j = await res.json();
    return Number(j?.pairs?.[0]?.priceUsd || 0.00125);
  } catch {
    return 0.00125;
  }
}

async function processSignature(sig, notify = true) {
  if (alreadySeen(sig)) return;

  const tx = await safeGetTransaction(sig);
  if (!tx || !tx.meta) {
    rememberSig(sig);
    return;
  }
  const meta = tx.meta;

  // ---- SOL tracking ----
  if (TRACK_SOL && meta.preBalances && meta.postBalances) {
    const pre  = meta.preBalances || [];
    const post = meta.postBalances || [];
    const accs = (tx.transaction?.message?.accountKeys) || [];

    const len = Math.min(pre.length, post.length, accs.length);
    const SOL_SCOPE = (process.env.SOL_SCOPE || "top_or_cex").trim();

    for (let i = 0; i < len; i++) {
      const preVal = pre[i];
      const postVal = post[i];
      const acc = accs[i];

      // garde-fous
      if (typeof preVal !== "number" || typeof postVal !== "number" || !acc) continue;

      const diff = BigInt(postVal) - BigInt(preVal);
      if (diff === 0n) continue;

      const sol = Number(diff) / 1e9;
      if (Math.abs(sol) < MIN_SOL) continue;

      const owner = (typeof acc.toBase58 === "function") ? acc.toBase58() : String(acc);

      // --------- FILTRE BRUIT SOL ICI ----------
      const isTop = owner === TOP_WALLET;

      // Renseigne les CEX au fur et à mesure :
      const KNOWN_EXCHANGES = {
        Kraken:  [ /* "addr1", ... */ ],
        Bybit:   [ /* "addr1", ... */ ],
        OKX:     [ /* "addr1", ... */ ],
        Binance: [],
        Coinbase:[]
      };
      const isCex = Object.values(KNOWN_EXCHANGES).some(list => list.includes(owner));

      if (SOL_SCOPE === "top_only" && !isTop) continue;
      if (SOL_SCOPE === "top_or_cex" && !isTop && !isCex) continue;
      // (si "all" -> pas de filtre)

      // -----------------------------------------

      const dir = sol > 0 ? "IN" : "OUT";
      const emoji = sol > 0 ? "🟢" : "🔴";
      const msg =
        `${emoji} <b>[SOL]</b> ${dir}\n` +
        `<code>${owner}</code>\n` +
        `Δ ${sol.toFixed(3)} SOL\n` +
        `🔗 https://solscan.io/tx/${sig}`;
      console.log("[SOL]", dir, owner, sol.toFixed(3));
      if (notify) await telegramSend(msg);
    }
  }


  // ---- SPL tracking (WDOG + TRACK_MINTS) ----
  const deltas = parseTokenDeltas(meta);
  if (!deltas.length) {
    rememberSig(sig);
    return;
  }

  const priceWDOG = await getWDOGUsd();

  for (const d of deltas) {
    const mint = d.mint;
    const ui = toUi(d.diff, d.decimals);
    const absUi = Math.abs(ui);

    if (!isAddrOfInterest(d.owner)) continue;

    // WDOG
    if (mint === WDOG_MINT && absUi >= MIN_WDOG) {
      const dir = ui > 0 ? "IN" : "OUT";
      const emoji = ui > 0 ? "🟢" : "🔴";
      const usd = (absUi * priceWDOG).toFixed(2);
      const msg =
        `${emoji} 🐶 <b>[WDOG]</b> ${dir}\n` +
        `${d.owner}\n` +
        `Δ ${ui.toFixed(0)} WDOG (~$${usd})\n` +
        `🔗 https://solscan.io/tx/${sig}`;

      console.log("[ALERT - WDOG]", msg);
      if (notify) await telegramSend(msg);
    }

    // Autres tokens SPL (USDC / USDT / WSOL)
    else if (TRACK_MINTS.includes(mint) && absUi >= MIN_SPL) {
      const dir = ui > 0 ? "IN" : "OUT";
      const emoji = ui > 0 ? "🟢" : "🔴";
      const msg =
        `${emoji} 💵 <b>[SPL]</b> ${dir}\n` +
        `Token: ${mint}\n` +
        `${d.owner}\n` +
        `Δ ${ui.toFixed(2)}\n` +
        `🔗 https://solscan.io/tx/${sig}`;

      console.log("[ALERT - SPL]", msg);
      if (notify) await telegramSend(msg);
    }
  }

  rememberSig(sig);
}

async function fetchNewSigsForAddress(addr) {
  const pub = new PublicKey(addr);
  const pages = [];
  let before = cursors[addr];

  for (let p = 0; p < MAX_PAGES; p++) {
    const sigs = await safeGetSignatures(pub, { limit: PAGE_LIMIT, before });
    if (!sigs.length) break;
    pages.push(...sigs);
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < PAGE_LIMIT) break;
  }

  if (pages[0]?.signature) {
    cursors[addr] = pages[0].signature;
    saveCursors();
  }

  return pages
    .map((s) => s.signature)
    .reverse()
    .filter((s) => !alreadySeen(s));
}

async function mainLoop() {
  console.log(`🔍 Monitoring ${WATCH_WALLETS.length + 1} wallets (including top holder)`);
  while (true) {
    const start = Date.now();

    for (const addr of [TOP_WALLET, ...WATCH_WALLETS]) {
      try {
        const sigs = await fetchNewSigsForAddress(addr);
        for (const sig of sigs) {
          await processSignature(sig, true);
        }
      } catch (e) {
        console.log("Error on", addr, e.message);
      }
      await sleep(jitter(PER_ADDR_DELAY_MS));
    }

    const took = Date.now() - start;
    await sleep(Math.max(0, jitter(POLL_INTERVAL_MS) - took));
  }
}

// --- Web server (ping & monitoring) ---
const app = express();

app.get("/", (req, res) => res.send("✅ WDOG multi-tracker is alive"));

app.get("/health", (req, res) =>
  res.json({
    ok: true,
    rpc: RPC_POOL[rpcIndex],
    processed: processed.length,
    cursors: Object.keys(cursors).length,
    uptime: Math.round(process.uptime()),
  })
);

app.get("/test-tg", async (req, res) => {
  try {
    await telegramSend("✅ Test WDOG multi-tracker");
    res.send("✅ Test Telegram sent");
  } catch (e) {
    res.status(500).send(e.message);
  }
});

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log("🌐 Server running on", PORT));

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
    // un ping immédiat au démarrage, puis toutes les 5 min
    doPing();
    setInterval(doPing, 5 * 60 * 1000);
  }

// --- Run one pass over all addresses (ONE_SHOT mode) ---
async function runOnce() {
  const ADDRS = [TOP_WALLET, ...WATCH_WALLETS];
  for (const addr of ADDRS) {
    try {
      const newSigs = await fetchNewSigsForAddress(addr);
      for (const sig of newSigs) {
        await processSignature(sig, true);
        await sleep(150);
      }
    } catch (e) {
      log("Error on address", addr, e.message);
    }
    await sleep(150);
  }
}

// --- Lancement conditionnel: boucle infinie (serveur) ou one-shot (CI) ---
if (process.env.ONE_SHOT === "1") {
  runOnce()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("Fatal:", e);
      process.exit(1);
    });
} else {
  mainLoop().catch((e) => console.error("Fatal:", e));
}
