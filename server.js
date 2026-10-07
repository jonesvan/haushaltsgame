"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const INDEX = path.join(__dirname, "index.html");
const MAX_BODY = 6 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{6,40}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

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

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendIndex(res) {
  fs.readFile(INDEX, function (err, buf) {
    if (err) {
      sendJSON(res, 500, { error: "index missing" });
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

  if (method === "GET") {
    const bare = pathname.replace(/^\/+|\/+$/g, "");
    if (pathname === "/" || pathname === "/index.html" || TOKEN_RE.test(bare)) {
      sendIndex(res);
      return;
    }
  }

  sendJSON(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", function () {
  console.log("haushaltsgame listening on " + PORT + " (data: " + DATA_DIR + ")");
});
