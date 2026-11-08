"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { URL } = require("url");

function loadDotEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}
loadDotEnv();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORAGE_DIR = path.join(ROOT, "storage");
const STORAGE_FILE = path.join(STORAGE_DIR, "credentials.enc");
const APIS = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "apis.json"), "utf8")).entries;
const CATEGORIES = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "categories.json"), "utf8")).categories;
const API_BY_ID = new Map(APIS.map((api) => [apiId(api), api]));
const TYPES = new Set(["apiKey", "bearer", "password", "oauth", "custom"]);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

function apiId(api) { return crypto.createHash("sha256").update(`${api.name}\0${api.url}`).digest("hex").slice(0, 16); }
function key() {
  const value = process.env.API_KEY_MANAGER_ENCRYPTION_KEY || "";
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("API_KEY_MANAGER_ENCRYPTION_KEY must be 64 hexadecimal characters. Configure it in .env.");
  return Buffer.from(value, "hex");
}
function readStore() {
  if (!fs.existsSync(STORAGE_FILE)) return [];
  try {
    const packed = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(packed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(packed.tag, "base64"));
    const records = JSON.parse(Buffer.concat([decipher.update(Buffer.from(packed.data, "base64")), decipher.final()]).toString("utf8"));
    if (!Array.isArray(records)) throw new Error("invalid");
    return records;
  } catch (error) {
    if (error.message.includes("API_KEY_MANAGER_ENCRYPTION_KEY")) throw error;
    throw new Error("Unable to decrypt the credential store. Use the original encryption key, or remove storage/credentials.enc.");
  }
}
function writeStore(records) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(records)), cipher.final()]);
  fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
  const temp = `${STORAGE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
  fs.renameSync(temp, STORAGE_FILE);
}
function safeRecord(record) { return { id: record.id, apiId: record.apiId, label: record.label, type: record.type, fields: Object.keys(record.values), createdAt: record.createdAt, updatedAt: record.updatedAt }; }
function validateCredential(input, existing) {
  if (!input || typeof input !== "object" || !API_BY_ID.has(input.apiId)) throw new Error("Choose an API from the catalog.");
  if (!TYPES.has(input.type)) throw new Error("Choose a supported credential type.");
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || label.length > 80) throw new Error("A label between 1 and 80 characters is required.");
  if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) throw new Error("Credential fields are required.");
  const values = {};
  for (const [name, value] of Object.entries(input.values)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(name) || typeof value !== "string" || value.length > 4000) throw new Error("Credential fields are invalid.");
    if (value) values[name] = value;
  }
  if (!Object.keys(values).length) throw new Error("Enter at least one credential value.");
  return { apiId: input.apiId, label, type: input.type, values, ...(existing || {}) };
}
function allowed(req) { if (!req.headers.origin) return true; try { const host = new URL(req.headers.origin).hostname; return host === HOST || host === "localhost"; } catch { return false; } }
function mutate(req) { return allowed(req) && req.headers["x-requested-with"] === "api-key-manager"; }
function body(req) { return new Promise((resolve, reject) => { let text = ""; req.on("data", (part) => { text += part; if (Buffer.byteLength(text) > 65536) reject(new Error("Request is too large.")); }); req.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error("Request body must be valid JSON.")); } }); req.on("error", reject); }); }
function json(res, status, value) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
function staticFile(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: "Not found." });
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }); fs.createReadStream(file).pipe(res);
}
function isAppRoute(pathname) {
  return pathname === "/" || pathname === "/directory" || pathname === "/vault" || pathname === "/about" || /^\/directory\/[^/]+$/.test(pathname);
}
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (!allowed(req)) return json(res, 403, { error: "This browser origin is not allowed." });
  if (url.pathname === "/api/categories" && req.method === "GET") return json(res, 200, { categories: CATEGORIES });
  if (url.pathname === "/api/apis" && req.method === "GET") {
    const search = (url.searchParams.get("search") || "").toLowerCase(); const category = url.searchParams.get("category") || "";
    const records = readStore(); const entries = APIS.filter((api) => (!category || api.category === category) && (!search || `${api.name} ${api.description} ${api.category}`.toLowerCase().includes(search))).map((api) => ({ ...api, id: apiId(api), credentialCount: records.filter((record) => record.apiId === apiId(api)).length }));
    return json(res, 200, { entries });
  }
  if (url.pathname === "/api/credentials" && req.method === "GET") return json(res, 200, { credentials: readStore().map(safeRecord) });
  if (url.pathname === "/api/credentials" && ["POST", "PUT"].includes(req.method)) {
    if (!mutate(req)) return json(res, 403, { error: "Unsafe request rejected." });
    const input = await body(req); const records = readStore();
    if (req.method === "POST") { const now = new Date().toISOString(); const record = { ...validateCredential(input), id: crypto.randomUUID(), createdAt: now, updatedAt: now }; records.push(record); writeStore(records); return json(res, 201, { credential: safeRecord(record) }); }
    const index = records.findIndex((record) => record.id === input.id); if (index < 0) return json(res, 404, { error: "Credential not found." });
    records[index] = validateCredential(input, { id: input.id, createdAt: records[index].createdAt, updatedAt: new Date().toISOString() }); writeStore(records); return json(res, 200, { credential: safeRecord(records[index]) });
  }
  const reveal = url.pathname.match(/^\/api\/credentials\/([^/]+)\/reveal$/); if (reveal && req.method === "POST") { if (!mutate(req)) return json(res, 403, { error: "Unsafe request rejected." }); const record = readStore().find((item) => item.id === reveal[1]); return record ? json(res, 200, { values: record.values }) : json(res, 404, { error: "Credential not found." }); }
  const remove = url.pathname.match(/^\/api\/credentials\/([^/]+)$/); if (remove && req.method === "DELETE") { if (!mutate(req)) return json(res, 403, { error: "Unsafe request rejected." }); const records = readStore(); const next = records.filter((record) => record.id !== remove[1]); if (next.length === records.length) return json(res, 404, { error: "Credential not found." }); writeStore(next); return json(res, 204, {}); }
  if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found." }); if (req.method === "GET") return staticFile(res, isAppRoute(url.pathname) ? "/" : url.pathname); return json(res, 405, { error: "Method not allowed." });
}
const server = http.createServer((req, res) => handle(req, res).catch((error) => json(res, 500, { error: error.message || "Unexpected server error" })));
if (require.main === module) server.listen(PORT, HOST, () => console.log(`API key manager listening at http://${HOST}:${PORT}`));
module.exports = { server, apiId, validateCredential };