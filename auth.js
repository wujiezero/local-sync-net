import crypto from "node:crypto";

const AUTH_USERNAME = String(process.env.AUTH_USERNAME || "").trim();
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || "");
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 168) * 3600 * 1000;
const COOKIE_NAME = "clipmesh_session";
const TRUST_PROXY = String(process.env.TRUST_PROXY || "").toLowerCase() === "true";
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const sessions = new Map();
const loginHits = new Map();
const uploadHits = new Map();

export const authEnabled = Boolean(AUTH_USERNAME && AUTH_PASSWORD);

export function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function isHttps(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https" || Boolean(req.socket?.encrypted);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function sweep(map, now = Date.now()) {
  for (const [key, value] of map) {
    if (value.expiresAt < now) map.delete(key);
  }
}

export function getSession(req) {
  sweep(sessions);
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function createSession(req, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { expiresAt, ip: clientIp(req), user: AUTH_USERNAME });
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps(req) || String(process.env.AUTH_COOKIE_SECURE || "").toLowerCase() === "true") {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
  return token;
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function secretEqual(left, right) {
  const a = sha256(left);
  const b = sha256(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyCredentials(username, password) {
  if (!authEnabled) return false;
  const userOk = secretEqual(String(username || "").trim(), AUTH_USERNAME);
  const passOk = secretEqual(String(password || ""), AUTH_PASSWORD);
  return userOk && passOk;
}

function hit(map, key, limit, windowMs) {
  const now = Date.now();
  sweep(map, now);
  const current = map.get(key);
  if (!current) {
    map.set(key, { count: 1, expiresAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

export function allowLogin(ip) {
  return hit(loginHits, ip, Number(process.env.LOGIN_RATE || 8), 10 * 60 * 1000);
}

export function allowUpload(ip) {
  return hit(uploadHits, ip, Number(process.env.UPLOAD_RATE || 40), 60 * 1000);
}

export function originAllowed(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "")
      .split(",")[0]
      .trim();
    if (host && new URL(origin).host === host) return true;
  } catch {
    /* ignore */
  }
  return ALLOWED_ORIGINS.length === 0;
}

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self'",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  if (isHttps(req)) res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
}

const PUBLIC_PATHS = new Set([
  "/login",
  "/login.html",
  "/api/login",
  "/api/health",
  "/styles.css",
  "/login.js",
  "/toast.js",
  "/favicon.svg",
  "/manifest.webmanifest",
]);

export function requireAuth(req, res, next) {
  if (!authEnabled) return next();
  if (req.method === "OPTIONS") return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!originAllowed(req)) return res.status(403).json({ error: "origin not allowed" });
  if (getSession(req)) return next();
  const wantsHtml = String(req.headers.accept || "").includes("text/html");
  if (wantsHtml && req.method === "GET") {
    const nextUrl = encodeURIComponent(req.originalUrl || "/");
    return res.redirect(`/login?next=${nextUrl}`);
  }
  res.status(401).json({ error: "unauthorized" });
}

export function wsAuthorized(req) {
  if (!authEnabled) return true;
  if (!originAllowed(req)) return false;
  return Boolean(getSession(req));
}
