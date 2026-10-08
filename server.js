"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const INDEX = path.join(__dirname, "index.html");
const BUDGET = path.join(__dirname, "budget.html");
const MAX_BODY = 12 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{6,40}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const MAX_OUTPUT_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS) || 8192;

function parseReceiptText(content) {
  if (!content) return null;
  try { return JSON.parse(content); } catch (e) {}
  const m = content.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

async function deepseekScan(apiKey, userContent) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 90000);
  try {
    const r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: SCAN_SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS
      }),
      signal: controller.signal
    });
    if (!r.ok) {
      let detail = "";
      try {
        const j = await r.json();
        detail = j && j.error && j.error.message ? j.error.message : "";
      } catch (e) {}
      const err = new Error("DeepSeek-Fehler " + r.status + (detail ? ": " + detail : ""));
      err.status = r.status;
      throw err;
    }
    const j = await r.json();
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    return parseReceiptText(msg && msg.content) || parseReceiptText(msg && msg.reasoning_content);
  } finally {
    clearTimeout(timer);
  }
}


const SCAN_SYSTEM_PROMPT =
  "Du bist ein Kassenzettel-Scanner. Lies den Kassenbon (Bild und/oder Text) und " +
  "antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne Erklaerung, ohne Markdown. " +
  "Format: " +
  '{"merchant":"Ladenname","date":"YYYY-MM-DD","currency":"EUR","total":12.34,' +
  '"items":[{"name":"Artikel","qty":1,"price":1.23}]} ' +
  "Regeln: price ist der Gesamtpreis der Position. Sind Einzelpreis und Menge gegeben, " +
  "multipliziere sie. Fehlt total, summiere die Positionen. Gib alle Positionen aus. " +
  "Wenn nichts erkannt wird, verwende leere Strings/Arrays und total 0.";

const scanHits = new Map();

function allowScan(token) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const max = Number(process.env.SCAN_MAX_PER_HOUR) || 60;
  const hits = (scanHits.get(token) || []).filter(function (t) { return now - t < windowMs; });
  if (hits.length >= max) { scanHits.set(token, hits); return false; }
  hits.push(now);
  scanHits.set(token, hits);
  return true;
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function rid() {
  return crypto.randomBytes(4).toString("hex");
}

function seed() {
  const p1 = rid();
  const p2 = rid();
  return {
    people: [
      { id: p1, name: "Anna", color: "#ef4444" },
      { id: p2, name: "Jonas", color: "#3b82f6" }
    ],
    tasks: [
      { id: rid(), name: "Geschirrsp\u00fcler", counts: { [p1]: 3, [p2]: 1 } },
      { id: rid(), name: "M\u00fcll rausbringen", counts: { [p1]: 0, [p2]: 2 } },
      { id: rid(), name: "Staubsaugen", counts: { [p1]: 1, [p2]: 0 } }
    ]
  };
}

function newToken() {
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function fileFor(token) {
  return path.join(DATA_DIR, token + ".json");
}

function readRoom(token) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(token), "utf8"));
  } catch (e) {
    return null;
  }
}

function writeRoom(token, room) {
  const target = fileFor(token);
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(room));
  fs.renameSync(tmp, target);
}

function sanitizeState(input) {
  const out = { people: [], tasks: [] };
  if (input && Array.isArray(input.people)) {
    out.people = input.people.slice(0, 200).map(function (p) {
      const person = {
        id: String(p && p.id || rid()),
        name: String(p && p.name || ""),
        color: String(p && p.color || "#9ca3af")
      };
      if (p && typeof p.photo === "string" && p.photo.length < 400000) person.photo = p.photo;
      return person;
    });
  }
  if (input && Array.isArray(input.tasks)) {
    out.tasks = input.tasks.slice(0, 500).map(function (t) {
      const counts = {};
      if (t && t.counts && typeof t.counts === "object") {
        Object.keys(t.counts).forEach(function (k) {
          counts[String(k)] = Math.max(0, Math.floor(Number(t.counts[k]) || 0));
        });
      }
      return { id: String(t && t.id || rid()), name: String(t && t.name || ""), counts: counts };
    });
  }
  return out;
}

function budgetFileFor(token) {
  return path.join(DATA_DIR, token + ".budget.json");
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sanitizeBook(input) {
  const out = { receipts: [] };
  if (input && Array.isArray(input.receipts)) {
    out.receipts = input.receipts.slice(0, 1000).map(function (r) {
      const items = Array.isArray(r && r.items) ? r.items.slice(0, 300).map(function (it) {
        return {
          id: String(it && it.id || rid()),
          name: String(it && it.name || ""),
          qty: Number(it && it.qty) || 1,
          price: round2(it && it.price)
        };
      }) : [];
      return {
        id: String(r && r.id || rid()),
        merchant: String(r && r.merchant || ""),
        date: String(r && r.date || ""),
        currency: String(r && r.currency || "EUR").slice(0, 8),
        total: round2(r && r.total),
        createdAt: Number(r && r.createdAt) || Date.now(),
        items: items
      };
    });
  }
  return out;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendFile(res, file) {
  fs.readFile(file, function (err, buf) {
    if (err) {
      sendJSON(res, 500, { error: "file missing" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (c) {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async function (req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (e) {
    sendJSON(res, 400, { error: "bad url" });
    return;
  }
  const method = req.method;

  if (pathname === "/api/ping") {
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/new" && method === "POST") {
    let token = newToken();
    while (fs.existsSync(fileFor(token))) token = newToken();
    writeRoom(token, { rev: 1, updatedAt: Date.now(), state: seed() });
    sendJSON(res, 200, { token: token });
    return;
  }

  const budgetMatch = pathname.match(/^\/api\/budget\/([A-Za-z0-9_-]{6,40})$/);
  if (budgetMatch) {
    const token = budgetMatch[1];
    if (!fs.existsSync(fileFor(token))) {
      sendJSON(res, 404, { error: "not found" });
      return;
    }
    const bfile = budgetFileFor(token);
    if (method === "GET") {
      let book = null;
      try { book = JSON.parse(fs.readFileSync(bfile, "utf8")); } catch (e) { book = null; }
      sendJSON(res, 200, { rev: book && book.rev || 0, book: (book && book.book) || { receipts: [] } });
      return;
    }
    if (method === "PUT") {
      try {
        const body = await readBody(req);
        let book = null;
        try { book = JSON.parse(fs.readFileSync(bfile, "utf8")); } catch (e) { book = null; }
        book = book || { rev: 0 };
        book.rev = (book.rev || 0) + 1;
        book.updatedAt = Date.now();
        book.book = sanitizeBook(body);
        const tmp = bfile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(book));
        fs.renameSync(tmp, bfile);
        sendJSON(res, 200, { rev: book.rev });
      } catch (e) {
        sendJSON(res, 400, { error: "bad request" });
      }
      return;
    }
    sendJSON(res, 405, { error: "method not allowed" });
    return;
  }

  const match = pathname.match(/^\/api\/state\/([A-Za-z0-9_-]{6,40})$/);
  if (match) {
    const token = match[1];
    if (method === "GET") {
      const room = readRoom(token);
      if (!room) {
        sendJSON(res, 404, { error: "not found" });
        return;
      }
      sendJSON(res, 200, { rev: room.rev || 0, state: room.state || seed() });
      return;
    }
    if (method === "PUT") {
      try {
        const body = await readBody(req);
        const room = readRoom(token) || { rev: 0 };
        room.rev = (room.rev || 0) + 1;
        room.updatedAt = Date.now();
        room.state = sanitizeState(body);
        writeRoom(token, room);
        sendJSON(res, 200, { rev: room.rev });
      } catch (e) {
        sendJSON(res, 400, { error: "bad request" });
      }
      return;
    }
    sendJSON(res, 405, { error: "method not allowed" });
    return;
  }

  if (pathname === "/api/scan" && method === "POST") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      sendJSON(res, 503, { error: "Scan ist nicht konfiguriert (DEEPSEEK_API_KEY fehlt)." });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      sendJSON(res, 413, { error: "Anfrage zu groß" });
      return;
    }
    const token = String((body && body.token) || "");
    if (!TOKEN_RE.test(token) || !fs.existsSync(fileFor(token))) {
      sendJSON(res, 403, { error: "Unbekanntes Token" });
      return;
    }
    const image = typeof (body && body.image) === "string" ? body.image : "";
    const text = typeof (body && body.text) === "string" ? body.text.slice(0, 8000) : "";
    if (!image && !text) {
      sendJSON(res, 400, { error: "Kein Bild oder Text übermittelt" });
      return;
    }
    if (image.length > 8 * 1024 * 1024) {
      sendJSON(res, 413, { error: "Bild zu groß" });
      return;
    }
    if (!allowScan(token)) {
      sendJSON(res, 429, { error: "Zu viele Anfragen. Bitte kurz warten." });
      return;
    }

    const userContent = [
      { type: "text", text: text ? ("Kassenbon-Text:\n" + text) : "Lies diesen Kassenbon." }
    ];
    if (image) {
      const url = /^data:/i.test(image) ? image : ("data:image/jpeg;base64," + image);
      userContent.push({ type: "image_url", image_url: { url: url } });
    }

    let receipt = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !receipt; attempt++) {
      try {
        receipt = await deepseekScan(apiKey, userContent);
      } catch (e) {
        lastErr = e;
        if (e && e.status && e.status < 500) break;
      }
    }
    if (!receipt) {
      if (lastErr && lastErr.name === "AbortError") {
        sendJSON(res, 504, { error: "Zeitüberschreitung" });
      } else if (lastErr) {
        sendJSON(res, 502, { error: lastErr.message });
      } else {
        sendJSON(res, 502, { error: "Leere Antwort vom Modell" });
      }
      return;
    }
    sendJSON(res, 200, { receipt: receipt });
    return;
  }

  if (method === "GET") {
    if (/^\/(?:[A-Za-z0-9_-]{6,40}\/)?budget(?:\.html)?$/.test(pathname)) {
      sendFile(res, BUDGET);
      return;
    }
    const bare = pathname.replace(/^\/+|\/+$/g, "");
    if (pathname === "/" || pathname === "/index.html" || TOKEN_RE.test(bare)) {
      sendFile(res, INDEX);
      return;
    }
  }

  sendJSON(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", function () {
  console.log("haushaltsgame listening on " + PORT + " (data: " + DATA_DIR + ")");
});
