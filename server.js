import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import multer from "multer";
import { WebSocketServer } from "ws";
import { createZip, readZip } from "./zip.js";
import {
  allowLogin,
  allowUpload,
  authEnabled,
  clientIp,
  createSession,
  destroySession,
  persistSessions,
  requireAuth,
  securityHeaders,
  verifyCredentials,
  wsAuthorized,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || PORT);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILES_DIR = path.join(DATA_DIR, "files");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const MAX_ARCHIVES = Number(process.env.MAX_ARCHIVES || 50);
const MAX_IMPORT_MB = Number(process.env.MAX_IMPORT_MB || 256);
const MAX_IMPORT_BYTES = MAX_IMPORT_MB * 1024 * 1024;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 32);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_CLIPS = Number(process.env.MAX_CLIPS || 200);
const MAX_TEXT = Number(process.env.MAX_TEXT || 200000);
const MAX_PEERS = Number(process.env.MAX_PEERS || 50);
const MAX_TAGS = 6;
const MAX_TAG_LEN = 16;
const MAX_CATALOG = 40;
const DEFAULT_TAGS = ["待办", "重要", "代码", "配置", "链接", "备忘"];

await fsp.mkdir(FILES_DIR, { recursive: true });

/** @typedef {{ id: string, seq: number, type: 'text' | 'image' | 'file', text?: string, file?: { id: string, name: string, mime: string, size: number, url: string }, deviceId: string, deviceName: string, createdAt: number, editedAt?: number, tags?: string[], replyTo?: string, threadId?: string, quote?: { id: string, deviceName: string, type: string, preview: string } }} Clip */
/** @typedef {{ id: string, deviceId: string, deviceName: string, joinedAt: number }} Peer */
/** @typedef {{ id: string, title: string, createdAt: number, createdBy: string, clipCount: number, clips: Clip[] }} Archive */
/** @typedef {{ clips: Clip[], peers: Map<import('ws').WebSocket, Peer>, nextSeq: number, tags: string[], archives: Archive[] }} Room */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, { code: string, expiresAt: number, archiveId: string }>} */
const deleteChallenges = new Map();

function sanitizeRoom(input) {
  const cleaned = String(input || "lan")
    .trim()
    .slice(0, 48)
    .replace(/[<>/"'\\`\s]/g, "");
  return cleaned || "lan";
}

function sanitizeName(input) {
  const cleaned = String(input || "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 40);
  return cleaned || "Anonymous";
}

function extnameSafe(name) {
  const ext = path.extname(String(name || "")).slice(0, 16);
  return /^\.[A-Za-z0-9.]+$/.test(ext) ? ext.toLowerCase() : "";
}

function decodeFilename(name) {
  const raw = String(name || "file");
  let decoded = raw;
  try {
    const fromLatin1 = Buffer.from(raw, "latin1").toString("utf8");
    if (fromLatin1 !== raw && !fromLatin1.includes("\uFFFD")) decoded = fromLatin1;
  } catch {
    decoded = raw;
  }
  return decoded.replace(/[/\\]/g, "_").slice(0, 180) || "file";
}

function getRoom(name) {
  const key = sanitizeRoom(name);
  let room = rooms.get(key);
  if (!room) {
    room = { clips: [], peers: new Map(), nextSeq: 1, tags: [...DEFAULT_TAGS], archives: [] };
    rooms.set(key, room);
  }
  return { key, room };
}

function fileOnDisk(url) {
  if (!url) return false;
  const filename = path.basename(url);
  if (!filename || filename !== url.replace(/^\/files\//, "")) return false;
  return fs.existsSync(path.join(FILES_DIR, filename));
}

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const stored = parsed?.rooms && typeof parsed.rooms === "object" ? parsed.rooms : {};
    for (const [name, data] of Object.entries(stored)) {
      const incoming = Array.isArray(data?.clips) ? data.clips : [];
      const kept = incoming.filter((clip) => {
        if (!clip || typeof clip !== "object" || !clip.id) return false;
        if (clip.file?.url && !fileOnDisk(clip.file.url)) return false;
        return true;
      });
      const clips = kept.slice(-MAX_CLIPS);
      let maxSeq = 0;
      for (const clip of clips) {
        clip.tags = sanitizeTags(clip.tags);
        if (Number.isInteger(clip.seq) && clip.seq > maxSeq) maxSeq = clip.seq;
      }
      for (const clip of clips) {
        if (!Number.isInteger(clip.seq) || clip.seq <= 0) {
          maxSeq += 1;
          clip.seq = maxSeq;
        }
      }
      const storedSeq = Number(data?.nextSeq);
      const used = [];
      for (const clip of clips) used.push(...(clip.tags || []));
      const archives = Array.isArray(data?.archives)
        ? data.archives
            .filter((item) => item && item.id && Array.isArray(item.clips))
            .map((item) => ({
              id: String(item.id).slice(0, 80),
              title: String(item.title || "归档").slice(0, 80),
              createdAt: Number(item.createdAt) || Date.now(),
              createdBy: String(item.createdBy || "").slice(0, 40),
              clipCount: Number(item.clipCount) || item.clips.length,
              clips: item.clips,
            }))
            .slice(-MAX_ARCHIVES)
        : [];
      rooms.set(sanitizeRoom(name), {
        clips,
        peers: new Map(),
        nextSeq: Math.max(maxSeq + 1, Number.isFinite(storedSeq) ? storedSeq : 1),
        tags: sanitizeCatalog([
          ...(Array.isArray(data?.tags) && data.tags.length ? data.tags : DEFAULT_TAGS),
          ...used,
        ]),
        archives,
      });
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") console.error("failed to load state", err);
  }
}

let persistTimer = null;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persist().catch((err) => console.error("persist failed", err));
  }, 250);
}

async function persist() {
  const snapshot = { rooms: {} };
  for (const [name, room] of rooms) {
    snapshot.rooms[name] = {
      clips: room.clips,
      nextSeq: room.nextSeq,
      tags: room.tags || [...DEFAULT_TAGS],
      archives: room.archives || [],
    };
  }
  const tmp = `${STATE_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(snapshot));
  await fsp.rename(tmp, STATE_PATH);
}

async function unlinkClipFile(clip) {
  if (!clip?.file?.url) return;
  const filename = path.basename(clip.file.url);
  try {
    await fsp.unlink(path.join(FILES_DIR, filename));
  } catch (err) {
    if (err && err.code !== "ENOENT") console.error("unlink failed", err);
  }
}

async function pruneRoom(room) {
  while (room.clips.length > MAX_CLIPS) {
    const dropped = room.clips.shift();
    await unlinkClipFile(dropped);
  }
}

function sanitizeTag(input) {
  return String(input || "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, MAX_TAG_LEN);
}

function sanitizeCatalog(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const tag = sanitizeTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_CATALOG) break;
  }
  return out;
}

function sanitizeTags(list, catalog) {
  const allowed = Array.isArray(catalog) && catalog.length ? new Set(catalog) : null;
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const tag = sanitizeTag(raw);
    if (!tag || seen.has(tag)) continue;
    if (allowed && !allowed.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function retargetQuotes(room, clip) {
  for (const other of room.clips) {
    if (other.quote?.id === clip.id) {
      other.quote.preview = clipPreview(clip);
      other.quote.deviceName = clip.deviceName;
      other.quote.type = clip.type;
    }
  }
}

function renameTagInRoom(room, from, to) {
  const src = sanitizeTag(from);
  const dst = sanitizeTag(to);
  if (!src || !dst || src === dst) return false;
  const catalog = room.tags || [];
  const srcIndex = catalog.indexOf(src);
  if (srcIndex === -1) return false;
  if (catalog.includes(dst)) {
    catalog.splice(srcIndex, 1);
  } else {
    catalog[srcIndex] = dst;
  }
  room.tags = sanitizeCatalog(catalog);
  for (const clip of room.clips) {
    if (!Array.isArray(clip.tags) || !clip.tags.includes(src)) continue;
    clip.tags = sanitizeTags(clip.tags.map((tag) => (tag === src ? dst : tag)), room.tags);
  }
  return true;
}

function deleteTagInRoom(room, name) {
  const tag = sanitizeTag(name);
  if (!tag) return false;
  room.tags = sanitizeCatalog((room.tags || []).filter((item) => item !== tag));
  for (const clip of room.clips) {
    if (!Array.isArray(clip.tags)) continue;
    clip.tags = clip.tags.filter((item) => item !== tag);
  }
  return true;
}

function sanitizeTitle(input) {
  const cleaned = String(input || "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || "归档";
}

function zipDownloadName(title) {
  const base = sanitizeTitle(title)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 40);
  return `${base || "archive"}.zip`;
}

function findArchive(room, id) {
  return (room.archives || []).find((item) => item.id === String(id || ""));
}

function collectClipFiles(clips) {
  const files = [];
  const seen = new Set();
  for (const clip of clips || []) {
    const filename = clip?.file?.url ? path.basename(clip.file.url) : "";
    if (!filename || seen.has(filename)) continue;
    seen.add(filename);
    const disk = path.join(FILES_DIR, filename);
    if (fs.existsSync(disk)) files.push({ filename, disk, name: clip.file.name || filename });
  }
  return files;
}

function timelineMarkdown(archive) {
  const lines = [
    `# ${archive.title}`,
    "",
    `- 归档时间：${new Date(archive.createdAt).toISOString()}`,
    `- 创建者：${archive.createdBy || ""}`,
    `- 消息数：${(archive.clips || []).length}`,
    "",
  ];
  for (const clip of archive.clips || []) {
    lines.push(`## #${clip.seq ?? "—"} · ${new Date(clip.createdAt).toISOString()} · ${clip.deviceName || ""}`);
    if (clip.tags?.length) lines.push(`标签：${clip.tags.join("、")}`);
    if (clip.quote?.preview) lines.push(`回复：${clip.quote.preview}`);
    if (clip.text) lines.push("", clip.text);
    if (clip.file?.url) lines.push("", `附件：[${clip.file.name}](files/${path.basename(clip.file.url)})`);
    lines.push("");
  }
  return lines.join("\n");
}

async function buildArchiveZip(archive) {
  const files = [
    {
      name: "clipmesh.json",
      data: JSON.stringify(
        {
          format: "clipmesh-archive",
          version: 1,
          archive: {
            title: archive.title,
            createdAt: archive.createdAt,
            createdBy: archive.createdBy,
            clipCount: archive.clipCount ?? archive.clips.length,
            clips: archive.clips,
          },
        },
        null,
        2,
      ),
    },
    { name: "timeline.md", data: timelineMarkdown(archive) },
  ];
  for (const file of collectClipFiles(archive.clips)) {
    files.push({ name: `files/${file.filename}`, data: await fsp.readFile(file.disk) });
  }
  return createZip(files);
}

async function importArchiveFromZip(room, zipBuf, createdBy) {
  const entries = readZip(zipBuf);
  const raw =
    entries.get("clipmesh.json") ||
    entries.get("archive.json") ||
    [...entries.keys()].filter((name) => name.endsWith(".json")).map((name) => entries.get(name))[0];
  if (!raw) throw new Error("zip 中缺少 clipmesh.json");
  const parsed = JSON.parse(raw.toString("utf8"));
  const source = parsed.archive || parsed;
  const clipsIn = Array.isArray(source.clips) ? source.clips : [];
  if (!clipsIn.length) throw new Error("归档里没有消息");

  const idMap = new Map();
  for (const clip of clipsIn) {
    if (clip?.id) idMap.set(clip.id, crypto.randomUUID());
  }
  const clips = [];
  for (const clip of clipsIn) {
    if (!clip || typeof clip !== "object") continue;
    const next = { ...clip, id: idMap.get(clip.id) || crypto.randomUUID() };
    if (clip.replyTo && idMap.has(clip.replyTo)) next.replyTo = idMap.get(clip.replyTo);
    if (clip.threadId && idMap.has(clip.threadId)) next.threadId = idMap.get(clip.threadId);
    if (clip.quote?.id && idMap.has(clip.quote.id)) {
      next.quote = { ...clip.quote, id: idMap.get(clip.quote.id) };
    }
    if (clip.file?.url) {
      const oldName = path.basename(clip.file.url);
      const packed = entries.get(`files/${oldName}`) || entries.get(oldName);
      if (packed) {
        const stored = `${crypto.randomUUID()}${extnameSafe(oldName)}`;
        await fsp.writeFile(path.join(FILES_DIR, stored), packed);
        next.file = {
          ...clip.file,
          id: path.parse(stored).name,
          url: `/files/${stored}`,
          name: decodeFilename(clip.file.name || oldName),
        };
      } else {
        delete next.file;
      }
    }
    clips.push(next);
  }
  if (!clips.length) throw new Error("没有可导入的消息");
  const importedTags = [];
  for (const clip of clips) importedTags.push(...(clip.tags || []));
  room.tags = sanitizeCatalog([...(room.tags || []), ...importedTags]);
  for (const clip of clips) clip.tags = sanitizeTags(clip.tags, room.tags);

  if (!room.archives) room.archives = [];
  const archive = {
    id: crypto.randomUUID(),
    title: sanitizeTitle(source.title || "导入归档"),
    createdAt: Number(source.createdAt) || Date.now(),
    createdBy: createdBy || String(source.createdBy || "import").slice(0, 40),
    clipCount: clips.length,
    clips,
  };
  room.archives.push(archive);
  while (room.archives.length > MAX_ARCHIVES) {
    const dropped = room.archives.shift();
    await Promise.all((dropped?.clips || []).map(unlinkClipFile));
  }
  return archive;
}

function archiveSummary(archive) {
  return {
    id: archive.id,
    title: archive.title,
    createdAt: archive.createdAt,
    createdBy: archive.createdBy,
    clipCount: archive.clipCount ?? archive.clips.length,
  };
}

function makeChallengeCode() {
  return String(100000 + crypto.randomInt(900000));
}

function nextSeq(room) {
  const seq = Number.isInteger(room.nextSeq) && room.nextSeq > 0 ? room.nextSeq : 1;
  room.nextSeq = seq + 1;
  return seq;
}

function clipPreview(clip) {
  if (clip?.text && String(clip.text).trim()) {
    return String(clip.text).replace(/\s+/g, " ").trim().slice(0, 120);
  }
  if (clip?.file?.name) return String(clip.file.name).slice(0, 120);
  if (clip?.type === "image") return "图片";
  if (clip?.type === "file") return "附件";
  return "消息";
}

function attachReply(room, clip, replyToId) {
  const parentId = String(replyToId || "").slice(0, 80);
  if (!parentId) return;
  const parent = room.clips.find((item) => item.id === parentId);
  if (!parent) return;
  clip.replyTo = parent.id;
  clip.threadId = parent.threadId || parent.id;
  clip.quote = {
    id: parent.id,
    deviceName: parent.deviceName,
    type: parent.type,
    preview: clipPreview(parent),
  };
}

function peerList(room, selfId) {
  return [...room.peers.values()].map((peer) => ({
    id: peer.id,
    deviceId: peer.deviceId,
    deviceName: peer.deviceName,
    joinedAt: peer.joinedAt,
    you: peer.id === selfId,
  }));
}

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload, except) {
  const raw = JSON.stringify(payload);
  for (const client of room.peers.keys()) {
    if (client !== except && client.readyState === 1) client.send(raw);
  }
}

function lastActivity(room) {
  let ts = 0;
  for (const clip of room.clips || []) {
    ts = Math.max(ts, Number(clip.editedAt) || 0, Number(clip.createdAt) || 0);
  }
  for (const archive of room.archives || []) {
    ts = Math.max(ts, Number(archive.createdAt) || 0);
    for (const clip of archive.clips || []) {
      ts = Math.max(ts, Number(clip.editedAt) || 0, Number(clip.createdAt) || 0);
    }
  }
  return ts || null;
}

function roomOverview(name, room) {
  const peers = [...(room.peers?.values?.() || [])].map((peer) => peer.deviceName);
  const archives = room.archives || [];
  const liveFiles = (room.clips || []).filter((clip) => clip.file?.url).length;
  const archiveFiles = archives.reduce(
    (n, item) => n + (item.clips || []).filter((clip) => clip.file?.url).length,
    0,
  );
  const orphan = peers.length === 0 && ((room.clips || []).length > 0 || archives.length > 0);
  return {
    name,
    peers: peers.length,
    peerNames: peers,
    clips: (room.clips || []).length,
    archives: archives.length,
    files: liveFiles + archiveFiles,
    tags: (room.tags || []).length,
    lastActivity: lastActivity(room),
    orphan,
  };
}

function lanHints() {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const addrs of Object.values(nets || {})) {
    for (const addr of addrs || []) {
      const family = addr.family === "IPv4" || addr.family === 4;
      if (family && !addr.internal) urls.push(`http://${addr.address}:${PUBLIC_PORT}`);
    }
  }
  return urls;
}

await loadState();

const app = express();
app.disable("x-powered-by");
if (String(process.env.TRUST_PROXY || "").toLowerCase() === "true") app.set("trust proxy", 1);
express.static.mime.define({ "application/javascript": ["js", "mjs"] });
app.use(securityHeaders);
app.use(express.json({ limit: "32kb" }));

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/login", (req, res) => {
  if (!authEnabled) return res.json({ ok: true, auth: false });
  const ip = clientIp(req);
  if (!allowLogin(ip)) return res.status(429).json({ error: "尝试过多，请稍后再试" });
  if (!verifyCredentials(req.body?.username, req.body?.password)) {
    return res.status(401).json({ error: "用户名或密码不正确" });
  }
  createSession(req, res, Boolean(req.body?.remember));
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({ auth: authEnabled });
});

app.use(requireAuth);

app.get("/api/health", (_req, res) => {
  let clips = 0;
  let peers = 0;
  for (const room of rooms.values()) {
    clips += room.clips.length;
    peers += room.peers.size;
  }
  res.json(
    authEnabled
      ? { ok: true, service: "clipmesh" }
      : {
          ok: true,
          service: "clipmesh",
          rooms: rooms.size,
          clips,
          peers,
          maxFileMb: MAX_FILE_MB,
        },
  );
});

app.get("/api/info", (_req, res) => {
  res.json({
    service: "clipmesh",
    maxFileMb: MAX_FILE_MB,
    maxClips: MAX_CLIPS,
    hints: lanHints(),
  });
});

app.get("/api/rooms", (_req, res) => {
  const list = [...rooms.entries()]
    .map(([name, room]) => roomOverview(name, room))
    .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0) || a.name.localeCompare(b.name));
  res.json({
    rooms: list,
    total: list.length,
    live: list.filter((item) => item.peers > 0).length,
    orphan: list.filter((item) => item.orphan).length,
  });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FILES_DIR),
  filename: (_req, file, cb) => {
    cb(null, `${crypto.randomUUID()}${extnameSafe(decodeFilename(file.originalname))}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
});

app.get("/api/archives/:id/export", async (req, res) => {
  const { room } = getRoom(req.query.room);
  const archive = findArchive(room, req.params.id);
  if (!archive) return res.status(404).json({ error: "归档不存在" });
  try {
    const zip = await buildArchiveZip(archive);
    const filename = zipDownloadName(archive.title);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(zip);
  } catch (err) {
    console.error("export failed", err);
    res.status(500).json({ error: "导出失败" });
  }
});

app.post("/api/archives/import", (req, res) => {
  if (!allowUpload(clientIp(req))) return res.status(429).json({ error: "上传过于频繁" });
  zipUpload.single("file")(req, res, async (err) => {
    if (err) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `zip 超过 ${MAX_IMPORT_MB} MB` : err.message || "upload failed",
      });
    }
    if (!req.file) return res.status(400).json({ error: "zip 文件必填" });
    const { room } = getRoom(req.query.room || req.body?.room);
    try {
      const archive = await importArchiveFromZip(room, req.file.buffer, req.query.deviceName || req.body?.deviceName);
      schedulePersist();
      const event = { type: "archives", archives: room.archives.map(archiveSummary) };
      broadcast(room, event);
      res.json({ ok: true, archive: archiveSummary(archive), archives: event.archives });
    } catch (error) {
      res.status(400).json({ error: error.message || "导入失败" });
    }
  });
});

app.post("/api/upload", (req, res) => {
  if (!allowUpload(clientIp(req))) return res.status(429).json({ error: "上传过于频繁" });
  upload.single("file")(req, res, (err) => {
    if (err) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `file exceeds ${MAX_FILE_MB} MB` : err.message || "upload failed",
      });
    }
    if (!req.file) return res.status(400).json({ error: "file required" });
    const name = decodeFilename(req.file.originalname);
    const mime = req.file.mimetype || "application/octet-stream";
    res.json({
      id: path.parse(req.file.filename).name,
      name,
      mime,
      size: req.file.size,
      url: `/files/${req.file.filename}`,
    });
  });
});

app.get("/settings", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "settings.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use("/files", (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const ext = path.extname(req.path).toLowerCase();
  const inline = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]);
  if (!inline.has(ext)) res.setHeader("Content-Disposition", "attachment");
  next();
}, express.static(FILES_DIR, { fallthrough: false, maxAge: "1h", index: false }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: 0, etag: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 1024 * 1024,
  verifyClient: (info) => wsAuthorized(info.req),
});

wss.on("connection", (ws, req) => {
  if (!wsAuthorized(req)) {
    ws.close(4401, "unauthorized");
    return;
  }
  const url = new URL(req.url || "/ws", "http://localhost");
  const { key, room } = getRoom(url.searchParams.get("room"));
  if (room.peers.size >= MAX_PEERS) {
    ws.close(4000, "room full");
    return;
  }

  const peer = {
    id: crypto.randomUUID(),
    deviceId: String(url.searchParams.get("deviceId") || crypto.randomUUID()).slice(0, 80),
    deviceName: sanitizeName(url.searchParams.get("deviceName")),
    joinedAt: Date.now(),
  };

  ws.isAlive = true;
  ws.roomKey = key;
  ws.peerId = peer.id;
  room.peers.set(ws, peer);

  send(ws, {
    type: "init",
    room: key,
    you: peer,
    clips: room.clips,
    peers: peerList(room, peer.id),
    tags: room.tags || [...DEFAULT_TAGS],
    archives: (room.archives || []).map(archiveSummary),
  });
  broadcast(room, { type: "peers", peers: peerList(room, null) }, ws);

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "rename") {
      peer.deviceName = sanitizeName(msg.deviceName);
      broadcast(room, { type: "peers", peers: peerList(room, null) });
      send(ws, { type: "peers", peers: peerList(room, peer.id) });
      return;
    }

    if (msg.type === "push") {
      const type = msg.payload?.type;
      if (type !== "text" && type !== "image" && type !== "file") return;

      /** @type {Clip} */
      const clip = {
        id: crypto.randomUUID(),
        type,
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        createdAt: Date.now(),
        seq: nextSeq(room),
        tags: sanitizeTags(msg.payload?.tags, room.tags),
      };

      if (type === "text") {
        const text = String(msg.payload.text || "");
        if (!text.trim()) return;
        if (text.length > MAX_TEXT) {
          send(ws, { type: "error", error: `text exceeds ${MAX_TEXT} chars` });
          return;
        }
        clip.text = text;
      } else {
        const file = msg.payload.file;
        if (!file?.url || !fileOnDisk(file.url)) {
          send(ws, { type: "error", error: "file missing" });
          return;
        }
        const mime = String(file.mime || "application/octet-stream").slice(0, 120);
        clip.type = mime.startsWith("image/") ? "image" : "file";
        clip.file = {
          id: String(file.id || path.parse(file.url).name).slice(0, 80),
          name: decodeFilename(file.name || "file"),
          mime,
          size: Number(file.size) || 0,
          url: `/files/${path.basename(file.url)}`,
        };
        if (typeof msg.payload.text === "string" && msg.payload.text.trim()) {
          clip.text = String(msg.payload.text).slice(0, 2000);
        }
      }

      attachReply(room, clip, msg.payload.replyTo);
      room.clips.push(clip);
      await pruneRoom(room);
      schedulePersist();
      const event = { type: "clip", clip };
      send(ws, event);
      broadcast(room, event, ws);
      return;
    }

    if (msg.type === "edit") {
      const id = String(msg.id || "");
      const clip = room.clips.find((item) => item.id === id);
      if (!clip) return;
      if (typeof msg.text !== "string") return;
      const text = String(msg.text);
      if (text.length > MAX_TEXT) {
        send(ws, { type: "error", error: `text exceeds ${MAX_TEXT} chars` });
        return;
      }
      if (clip.type === "text" && !text.trim()) {
        send(ws, { type: "error", error: "text required" });
        return;
      }
      if (clip.type === "text") clip.text = text;
      else if (text.trim()) clip.text = text.slice(0, 2000);
      else delete clip.text;
      if (msg.tags) clip.tags = sanitizeTags(msg.tags, room.tags);
      clip.editedAt = Date.now();
      retargetQuotes(room, clip);
      schedulePersist();
      const event = { type: "edited", clip };
      send(ws, event);
      broadcast(room, event, ws);
      return;
    }

    if (msg.type === "tag") {
      const id = String(msg.id || "");
      const clip = room.clips.find((item) => item.id === id);
      if (!clip) return;
      clip.tags = sanitizeTags(msg.tags, room.tags);
      schedulePersist();
      const event = { type: "tagged", id: clip.id, tags: clip.tags };
      send(ws, event);
      broadcast(room, event, ws);
      return;
    }

    if (msg.type === "tags.create") {
      const tag = sanitizeTag(msg.name);
      if (!tag) return;
      const catalog = room.tags || [...DEFAULT_TAGS];
      if (catalog.includes(tag)) {
        send(ws, { type: "error", error: "标签已存在" });
        return;
      }
      if (catalog.length >= MAX_CATALOG) {
        send(ws, { type: "error", error: `最多 ${MAX_CATALOG} 个标签` });
        return;
      }
      catalog.push(tag);
      room.tags = sanitizeCatalog(catalog);
      schedulePersist();
      const event = { type: "catalog", tags: room.tags };
      send(ws, event);
      broadcast(room, event, ws);
      return;
    }

    if (msg.type === "tags.rename") {
      if (!renameTagInRoom(room, msg.from, msg.to)) {
        send(ws, { type: "error", error: "无法重命名该标签" });
        return;
      }
      schedulePersist();
      const event = {
        type: "catalog",
        tags: room.tags,
        clips: room.clips.map((item) => ({ id: item.id, tags: item.tags || [] })),
      };
      send(ws, event);
      broadcast(room, event, ws);
      return;
    }

    if (msg.type === "tags.delete") {
      deleteTagInRoom(room, msg.name);
      schedulePersist();
      const event = {
        type: "catalog",
        tags: room.tags,
        clips: room.clips.map((item) => ({ id: item.id, tags: item.tags || [] })),
      };
      send(ws, event);
      broadcast(room, event, ws);
      return;
    }

    if (msg.type === "delete") {
      const id = String(msg.id || "");
      const index = room.clips.findIndex((c) => c.id === id);
      if (index === -1) return;
      const [removed] = room.clips.splice(index, 1);
      await unlinkClipFile(removed);
      schedulePersist();
      const event = { type: "deleted", id };
      send(ws, event);
      broadcast(room, event, ws);
      return;
    }

    if (msg.type === "archive") {
      if (!room.clips.length) {
        send(ws, { type: "error", error: "当前没有可归档的消息" });
        return;
      }
      if (!room.archives) room.archives = [];
      const snapshot = room.clips.splice(0, room.clips.length);
      const archive = {
        id: crypto.randomUUID(),
        title: sanitizeTitle(msg.title || `归档 ${new Date().toLocaleString("zh-CN")}`),
        createdAt: Date.now(),
        createdBy: peer.deviceName,
        clipCount: snapshot.length,
        clips: snapshot,
      };
      room.archives.push(archive);
      while (room.archives.length > MAX_ARCHIVES) {
        const dropped = room.archives.shift();
        await Promise.all((dropped?.clips || []).map(unlinkClipFile));
      }
      schedulePersist();
      const event = {
        type: "archived",
        archive: archiveSummary(archive),
        archives: room.archives.map(archiveSummary),
      };
      send(ws, event);
      broadcast(room, event, ws);
      return;
    }

    if (msg.type === "archive.rename") {
      const archive = findArchive(room, msg.id);
      if (!archive) {
        send(ws, { type: "error", error: "归档不存在" });
        return;
      }
      archive.title = sanitizeTitle(msg.title);
      schedulePersist();
      const event = { type: "archives", archives: room.archives.map(archiveSummary) };
      send(ws, event);
      broadcast(room, event, ws);
      return;
    }

    if (msg.type === "archive.open") {
      const archive = (room.archives || []).find((item) => item.id === String(msg.id || ""));
      if (!archive) {
        send(ws, { type: "error", error: "归档不存在" });
        return;
      }
      send(ws, { type: "archive", archive });
      return;
    }

    if (msg.type === "archive.delete.challenge") {
      const archive = (room.archives || []).find((item) => item.id === String(msg.id || ""));
      if (!archive) {
        send(ws, { type: "error", error: "归档不存在" });
        return;
      }
      const code = makeChallengeCode();
      deleteChallenges.set(ws.peerId, {
        code,
        archiveId: archive.id,
        expiresAt: Date.now() + 2 * 60 * 1000,
      });
      send(ws, { type: "archive.challenge", id: archive.id, code, ttl: 120 });
      return;
    }

    if (msg.type === "archive.delete") {
      const challenge = deleteChallenges.get(ws.peerId);
      const id = String(msg.id || "");
      const code = String(msg.code || "").trim();
      if (!challenge || challenge.archiveId !== id || challenge.expiresAt < Date.now()) {
        send(ws, { type: "error", error: "验证码已失效，请重新获取" });
        return;
      }
      if (code !== challenge.code) {
        send(ws, { type: "error", error: "验证码不正确" });
        return;
      }
      deleteChallenges.delete(ws.peerId);
      const index = (room.archives || []).findIndex((item) => item.id === id);
      if (index === -1) {
        send(ws, { type: "error", error: "归档不存在" });
        return;
      }
      const [removed] = room.archives.splice(index, 1);
      const stillUsed = new Set();
      for (const clip of room.clips) {
        if (clip.file?.url) stillUsed.add(clip.file.url);
      }
      for (const other of room.archives) {
        for (const clip of other.clips || []) {
          if (clip.file?.url) stillUsed.add(clip.file.url);
        }
      }
      await Promise.all(
        (removed.clips || [])
          .filter((clip) => clip.file?.url && !stillUsed.has(clip.file.url))
          .map(unlinkClipFile),
      );
      schedulePersist();
      const event = { type: "archive.deleted", id, archives: room.archives.map(archiveSummary) };
      send(ws, event);
      broadcast(room, event, ws);
    }
  });

  ws.on("close", () => {
    room.peers.delete(ws);
    broadcast(room, { type: "peers", peers: peerList(room, null) });
    deleteChallenges.delete(ws.peerId);
    if (room.peers.size === 0 && room.clips.length === 0 && !(room.archives || []).length) {
      const untouched = JSON.stringify(room.tags || []) === JSON.stringify(DEFAULT_TAGS);
      if (untouched) rooms.delete(key);
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

async function shutdown() {
  clearInterval(heartbeat);
  clearTimeout(persistTimer);
  persistSessions();
  try {
    await persist();
  } catch (err) {
    console.error("shutdown persist failed", err);
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`ClipMesh listening on http://${HOST}:${PORT}`);
  console.log(authEnabled ? "  Auth: username/password enabled" : "  Auth: disabled (set AUTH_USERNAME / AUTH_PASSWORD before public exposure)");
  for (const url of lanHints()) console.log(`  LAN: ${url}`);
});
