import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";
import hljs from "./vendor/hljs-languages.js";

const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"),
  peerCount: $("peer-count"),
  peerHint: $("peer-hint"),
  peers: $("peers"),
  room: $("room"),
  deviceName: $("device-name"),
  join: $("join"),
  draft: $("draft"),
  draftCount: $("draft-count"),
  formatHint: $("format-hint"),
  send: $("send"),
  copyOs: $("copy-os"),
  composerBox: $("composer-box"),
  fileInput: $("file-input"),
  pickFile: $("pick-file"),
  attachPreview: $("attach-preview"),
  timeline: $("timeline"),
  archiveRoom: $("archive-room"),
  archiveDrawer: $("archive-drawer"),
  archiveClose: $("archive-close"),
  archiveList: $("archive-list"),
  archiveView: $("archive-view"),
  archivesLink: $("archives-link"),
  confirmModal: $("confirm-modal"),
  confirmCode: $("confirm-code"),
  confirmInput: $("confirm-input"),
  confirmCancel: $("confirm-cancel"),
  confirmOk: $("confirm-ok"),
  toast: $("toast"),
  limitHint: $("limit-hint"),
  replyBar: $("reply-bar"),
  replyName: $("reply-name"),
  replyPreview: $("reply-preview"),
  replyCancel: $("reply-cancel"),
  composeMode: $("compose-mode"),
  draftTags: $("draft-tags"),
  tagFilters: $("tag-filters"),
  fromTime: $("from-time"),
  toTime: $("to-time"),
  resetFilters: $("reset-filters"),
  filterCount: $("filter-count"),
};

const DEVICE_KEY = "clipmesh.deviceId";
const NAME_KEY = "clipmesh.deviceName";
const ROOM_KEY = "clipmesh.room";
const state = {
  ws: null,
  clips: [],
  peers: [],
  you: null,
  reconnect: 800,
  maxFileMb: 32,
  replyTo: null,
  draftTags: [],
  filterTags: [],
  catalog: [],
  editingId: null,
  pendingFile: null,
  archives: [],
  openArchive: null,
  pendingDeleteId: null,
};

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = String(lang || "")
        .trim()
        .split(/\s+/)[0];
      return wrapCode(text, language);
    },
    link({ href, title, text }) {
      const safe = isSafeUrl(href);
      const url = safe ? href : "#";
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(url)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function defaultName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Win/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Browser";
}

function roomFromUrl() {
  const params = new URLSearchParams(location.search);
  return params.get("room") || localStorage.getItem(ROOM_KEY) || "lan";
}

function setStatus(kind, label) {
  els.status.dataset.state = kind;
  els.status.querySelector("span").textContent = label;
}

function toast(message) {
  els.toast.hidden = false;
  els.toast.textContent = message;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.hidden = true;
  }, 2200);
}

async function copyText(text) {
  const value = String(text ?? "");
  try {
    await navigator.clipboard.writeText(value);
    toast("已复制");
    return;
  } catch {
    /* fallback */
  }
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    toast("已复制");
  } catch {
    toast("复制失败");
  }
  ta.remove();
}

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatSeq(n) {
  const seq = Number(n);
  if (!Number.isInteger(seq) || seq <= 0) return "#—";
  return `#${String(seq).padStart(3, "0")}`;
}

function sanitizeTag(input) {
  return String(input || "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, 16);
}

function toggleList(list, value) {
  const tag = sanitizeTag(value);
  if (!tag) return list;
  if (list.includes(tag)) return list.filter((item) => item !== tag);
  if (list.length >= 6) {
    toast("最多 6 个标签");
    return list;
  }
  return [...list, tag];
}

function usedTags() {
  const set = new Set(state.catalog);
  for (const clip of state.clips) {
    for (const tag of clip.tags || []) set.add(tag);
  }
  return [...set];
}

function settingsHref() {
  const room = els.room?.value.trim() || localStorage.getItem(ROOM_KEY) || "lan";
  return `/settings?room=${encodeURIComponent(room)}`;
}

function syncSettingsLink() {
  const link = document.getElementById("settings-link");
  if (link) link.href = settingsHref();
  for (const a of document.querySelectorAll('a[href="/settings"], a[href^="/settings?"]')) {
    if (a.id === "settings-link" || a.getAttribute("href")?.startsWith("/settings")) {
      if (a.id === "settings-link" || a.textContent.includes("配置")) a.href = settingsHref();
    }
  }
}

function parseLocalTime(value, end) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return null;
  return end ? t + 60 * 1000 - 1 : t;
}

function clipMatchesFilters(clip) {
  if (state.filterTags.length) {
    const tags = clip.tags || [];
    if (!state.filterTags.some((tag) => tags.includes(tag))) return false;
  }
  const from = parseLocalTime(els.fromTime?.value, false);
  const to = parseLocalTime(els.toTime?.value, true);
  const ts = Number(clip.createdAt) || 0;
  if (from != null && ts < from) return false;
  if (to != null && ts > to) return false;
  return true;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isSafeUrl(href) {
  if (!href) return false;
  return /^(https?:|mailto:|\/files\/)/i.test(href);
}

function detectKind(text) {
  const t = String(text || "").trim();
  if (!t) return { kind: "plain", lang: null, label: "文本" };

  const fence = /```[\s\S]*?```/.test(t) || /^~~~/m.test(t);
  const heading = /^#{1,6}\s+\S/m.test(t);
  const mdLink = /\[[^\]]+\]\([^)]+\)/.test(t);
  const mdList = /^(?:\s{0,3}[-*+]\s+\S|\s{0,3}\d+\.\s+\S)/m.test(t);
  const mdQuote = /^>\s+\S/m.test(t);
  const mdTable = /^\|.+\|\s*$/m.test(t) && /^\s*\|?\s*:?-{3,}/m.test(t);
  const mdScore = [fence, heading, mdLink, mdList, mdQuote, mdTable].filter(Boolean).length;

  const jsonish = (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
  if (jsonish) {
    try {
      JSON.parse(t);
      return { kind: "code", lang: "json", label: "JSON" };
    } catch {
      if (!fence && !heading) return { kind: "code", lang: "json", label: "JSON" };
    }
  }

  if (mdScore >= 1 && (fence || heading || mdTable || mdScore >= 2)) {
    return { kind: "markdown", lang: "markdown", label: "Markdown" };
  }

  if (looksLikeYaml(t) && mdScore === 0) {
    return { kind: "code", lang: "yaml", label: "YAML" };
  }

  if (mdScore >= 1) return { kind: "markdown", lang: "markdown", label: "Markdown" };
  return { kind: "plain", lang: null, label: "文本" };
}

function looksLikeYaml(t) {
  if (!t || t.startsWith("{") || t.startsWith("[")) return false;
  const lines = t.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (!lines.length) return false;
  const keyish = lines.filter((line) => {
    const s = line.replace(/\t/g, "  ");
    return /^[\w./-]+(?::\s+\S.*|:\s*)$/.test(s.trim()) || /^\s*-\s+\S/.test(s);
  });
  if (/^---\s*$/m.test(t) && keyish.length) return true;
  if (lines.length === 1) return /^[\w./-]+:\s+\S+$/.test(lines[0]);
  return keyish.length >= Math.max(2, Math.ceil(lines.length * 0.45));
}

function highlightCode(text, lang) {
  const source = String(text ?? "");
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
    }
  } catch {
    /* fall through */
  }
  return escapeHtml(source);
}

function wrapCode(text, lang, { copyClipId } = {}) {
  const source = String(text ?? "");
  const language = String(lang || "").trim();
  const label = language ? language.toUpperCase() : "CODE";
  const copyBtn = copyClipId
    ? `<button class="btn btn-ghost btn-mini" type="button" data-act="copy" data-id="${copyClipId}">复制</button>`
    : `<button class="btn btn-ghost btn-mini" type="button" data-act="copy-code">复制</button>`;
  return `<div class="code-block">
    <div class="code-bar"><span class="mono">${escapeHtml(label)}</span>${copyBtn}</div>
    <pre class="clip-code"><code class="hljs">${highlightCode(source, language)}</code></pre>
    <textarea class="copy-source" hidden readonly>${escapeHtml(source)}</textarea>
  </div>`;
}

function renderMarkdown(text) {
  let html = "";
  try {
    html = marked.parse(text, { async: false });
  } catch {
    html = `<pre class="clip-code"><code>${escapeHtml(text)}</code></pre>`;
  }
  return `<div class="md-body">${DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["button", "textarea"],
    ADD_ATTR: ["class", "data-act", "hidden", "readonly", "target", "rel", "disabled", "checked", "type", "start"],
  })}</div>`;
}

function renderRichText(text, clipId) {
  const detected = detectKind(text);
  if (detected.kind === "markdown") return renderMarkdown(text);
  if (detected.kind === "code") return wrapCode(text, detected.lang, { copyClipId: clipId });
  return `<p class="clip-text">${escapeHtml(text || "")}</p>`;
}

function formatBadge(text) {
  if (!text) return "";
  const detected = detectKind(text);
  const cls = detected.lang || detected.kind;
  return `<span class="kind ${escapeHtml(cls)}">${escapeHtml(detected.label)}</span>`;
}

function kindLabel(type) {
  if (type === "image") return "图片";
  if (type === "file") return "附件";
  return "文本";
}

function previewOf(clip) {
  if (clip?.text && String(clip.text).trim()) {
    return String(clip.text).replace(/\s+/g, " ").trim().slice(0, 120);
  }
  if (clip?.file?.name) return clip.file.name;
  if (clip?.type === "image") return "图片";
  if (clip?.type === "file") return "附件";
  return "消息";
}

function setReply(clip) {
  if (!clip) return;
  state.editingId = null;
  state.replyTo = clip;
  updateReplyBar();
  els.draft.focus();
}

function clearReply() {
  cancelComposeMode();
}

function updateReplyBar() {
  if (!els.replyBar) return;
  const editing = currentEdit();
  if (editing) {
    els.replyBar.hidden = false;
    if (els.composeMode) els.composeMode.textContent = "编辑";
    els.replyName.textContent = formatSeq(editing.seq);
    els.replyPreview.textContent = previewOf(editing);
    els.send.textContent = "保存修改";
    return;
  }
  const target = state.replyTo;
  if (!target) {
    els.replyBar.hidden = true;
    if (els.composeMode) els.composeMode.textContent = "回复";
    els.send.textContent = "发送";
    return;
  }
  els.replyBar.hidden = false;
  if (els.composeMode) els.composeMode.textContent = "回复";
  els.replyName.textContent = target.deviceName || "匿名";
  els.replyPreview.textContent = previewOf(target);
  els.send.textContent = "发送回复";
}

function currentEdit() {
  return state.editingId ? state.clips.find((clip) => clip.id === state.editingId) : null;
}

function beginEdit(clip) {
  if (!clip) return;
  state.editingId = clip.id;
  state.replyTo = null;
  els.draft.value = clip.text || "";
  els.draftCount.textContent = String(els.draft.value.length);
  state.draftTags = [...(clip.tags || [])];
  updateFormatHint();
  renderDraftTags();
  updateReplyBar();
  els.draft.focus();
}

function cancelComposeMode() {
  state.editingId = null;
  state.replyTo = null;
  updateReplyBar();
}

function threadTree(clips) {
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const children = new Map();
  for (const clip of clips) {
    if (!clip.replyTo || !byId.has(clip.replyTo)) continue;
    const list = children.get(clip.replyTo) || [];
    list.push(clip);
    children.set(clip.replyTo, list);
  }
  const nest = (clip) => ({
    clip,
    replies: (children.get(clip.id) || [])
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(nest),
  });
  return clips
    .filter((clip) => !clip.replyTo || !byId.has(clip.replyTo))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(nest);
}

function renderClip(clip, { isReply = false, readOnly = false } = {}) {
  const canCopy = Boolean(clip.text);
  const tags = clip.tags || [];
  const actions = readOnly
    ? [
        canCopy ? `<button class="btn btn-ghost" data-act="copy" data-id="${clip.id}">复制</button>` : "",
        clip.file ? `<a class="btn btn-ghost" href="${clip.file.url}" download="${escapeHtml(clip.file.name)}">下载</a>` : "",
      ].filter(Boolean).join("")
    : [
        `<button class="btn btn-ghost" data-act="reply" data-id="${clip.id}">回复</button>`,
        `<button class="btn btn-ghost" data-act="edit" data-id="${clip.id}">编辑</button>`,
        canCopy ? `<button class="btn btn-ghost" data-act="copy" data-id="${clip.id}">复制</button>` : "",
        clip.file ? `<a class="btn btn-ghost" href="${clip.file.url}" download="${escapeHtml(clip.file.name)}">下载</a>` : "",
        `<button class="btn btn-ghost btn-danger" data-act="delete" data-id="${clip.id}">删除</button>`,
      ]
        .filter(Boolean)
        .join("");

  let body = "";
  if (clip.type === "image" && clip.file) {
    body = `<img class="clip-image" src="${clip.file.url}" alt="${escapeHtml(clip.file.name)}" />`;
    if (clip.text) body += `<div style="margin-top:10px">${renderRichText(clip.text, clip.id)}</div>`;
  } else if (clip.type === "file" && clip.file) {
    body = `<div class="clip-file"><div><a href="${clip.file.url}" download="${escapeHtml(clip.file.name)}">${escapeHtml(clip.file.name)}</a><div class="hint">${formatBytes(clip.file.size)} · ${escapeHtml(clip.file.mime)}</div></div></div>`;
  } else {
    body = renderRichText(clip.text || "", clip.id);
  }

  const extra = clip.type === "text" && clip.text ? formatBadge(clip.text) : `<span class="kind ${clip.type}">${kindLabel(clip.type)}</span>`;
  const quote = clip.quote
    ? `<button type="button" class="clip-quote" data-act="jump" data-id="${escapeHtml(clip.quote.id)}"><span>回复 <b>${escapeHtml(clip.quote.deviceName || "")}</b></span><p>${escapeHtml(clip.quote.preview || "")}</p></button>`
    : "";
  const tagChips = tags
    .map((tag) => `<button type="button" class="chip active" data-act="filter-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`)
    .join("");
  const edited = clip.editedAt
    ? `<span class="edited-mark">已编辑 ${formatTime(clip.editedAt)}</span>`
    : "";

  return `<article class="clip${isReply ? " is-reply" : ""}" data-id="${clip.id}">
    <div class="clip-head">
      <div class="clip-head-main">
        <span class="seq mono">${formatSeq(clip.seq)}</span>
        <span class="stamp mono">${formatTime(clip.createdAt)}</span>
        ${extra}
        <b>${escapeHtml(clip.deviceName)}</b>
        ${edited}
      </div>
      ${canCopy ? `<button class="btn btn-ghost btn-mini" type="button" data-act="copy" data-id="${clip.id}">复制</button>` : ""}
    </div>
    ${quote}
    ${body}
    ${tagChips ? `<div class="clip-tags">${tagChips}</div>` : ""}
    <div class="clip-actions">${actions}</div>
  </article>`;
}

function renderThread(node, isReply = false, readOnly = false) {
  const replies = node.replies.map((child) => renderThread(child, true, readOnly)).join("");
  return `<div class="thread">
    ${renderClip(node.clip, { isReply, readOnly })}
    ${replies ? `<div class="thread-replies">${replies}</div>` : ""}
  </div>`;
}

function flashClip(id) {
  const el = els.timeline.querySelector(`article.clip[data-id="${CSS.escape(id)}"]`);
  if (!el) {
    toast("原消息不在时间线里");
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("clip-flash");
  clearTimeout(flashClip._t);
  flashClip._t = setTimeout(() => el.classList.remove("clip-flash"), 1400);
}

function renderPeers() {
  els.peerCount.textContent = `${state.peers.length} 台在线`;
  els.peerHint.textContent = state.peers.length ? "实时同步中" : "等待加入";
  els.peers.innerHTML = state.peers
    .map((peer) => {
      const you = peer.you || (state.you && peer.id === state.you.id);
      return `<li><span>${escapeHtml(peer.deviceName)}</span>${you ? '<span class="you">YOU</span>' : ""}</li>`;
    })
    .join("");
}

function renderDraftTags() {
  if (!els.draftTags) return;
  const all = state.catalog.length ? state.catalog : [];
  if (!all.length) {
    els.draftTags.innerHTML = `<span class="hint">还没有标签，去<a href="${settingsHref()}">标签配置</a>添加。</span>`;
    return;
  }
  els.draftTags.innerHTML = all
    .map((tag) => {
      const active = state.draftTags.includes(tag);
      return `<button type="button" class="chip${active ? " active" : ""}" data-act="draft-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
    })
    .join("");
}

function renderTagFilters() {
  if (!els.tagFilters) return;
  const tags = usedTags();
  if (!tags.length) {
    els.tagFilters.innerHTML = `<span class="hint">暂无标签</span>`;
    return;
  }
  els.tagFilters.innerHTML = [
    `<button type="button" class="chip${state.filterTags.length ? "" : " active"}" data-act="filter-tag" data-tag="">全部</button>`,
    ...tags.map(
      (tag) =>
        `<button type="button" class="chip${state.filterTags.includes(tag) ? " active" : ""}" data-act="filter-tag" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`,
    ),
  ].join("");
}

function visibleClips() {
  const matched = new Set(state.clips.filter(clipMatchesFilters).map((clip) => clip.id));
  const byId = new Map(state.clips.map((clip) => [clip.id, clip]));
  const extra = new Set();
  for (const id of matched) {
    let current = byId.get(id);
    while (current?.replyTo && byId.has(current.replyTo)) {
      extra.add(current.replyTo);
      current = byId.get(current.replyTo);
    }
  }
  return state.clips.filter((clip) => matched.has(clip.id) || extra.has(clip.id));
}

function renderAttachPreview() {
  if (!els.attachPreview) return;
  if (!state.pendingFile) {
    els.attachPreview.hidden = true;
    els.attachPreview.innerHTML = "";
    return;
  }
  els.attachPreview.hidden = false;
  els.attachPreview.innerHTML = `<span>${escapeHtml(state.pendingFile.name)} · ${formatBytes(state.pendingFile.size)}</span><button class="btn btn-ghost btn-mini" type="button" id="detach-file">移除</button>`;
  els.attachPreview.querySelector("#detach-file")?.addEventListener("click", () => {
    state.pendingFile = null;
    if (els.fileInput) els.fileInput.value = "";
    renderAttachPreview();
  });
}

function queueFile(file) {
  if (!file) return;
  if (file.size > state.maxFileMb * 1024 * 1024) {
    toast(`超过 ${state.maxFileMb} MB 上限`);
    return;
  }
  if (state.editingId) {
    toast("编辑模式只改文本和标签，请先保存或取消");
    return;
  }
  state.pendingFile = file;
  renderAttachPreview();
}

function renderArchives() {
  if (!els.archiveList) return;
  if (!state.archives.length) {
    els.archiveList.innerHTML = `<div class="empty">还没有归档。点「归档房间」会把当前时间线收进历史，房间变空但可随时回看。</div>`;
    return;
  }
  els.archiveList.innerHTML = [...state.archives]
    .reverse()
    .map(
      (item) => `<div class="archive-item" data-id="${item.id}">
        <div>
          <b>${escapeHtml(item.title)}</b>
          <div class="hint">${formatTime(item.createdAt)} · ${item.clipCount} 条 · ${escapeHtml(item.createdBy || "")}</div>
        </div>
        <div class="composer-actions">
          <button class="btn btn-ghost btn-mini" type="button" data-act="open-archive" data-id="${item.id}">查看</button>
          <button class="btn btn-ghost btn-mini btn-danger" type="button" data-act="delete-archive" data-id="${item.id}">删除</button>
        </div>
      </div>`,
    )
    .join("");
}

function openArchiveDrawer() {
  if (!els.archiveDrawer) return;
  els.archiveDrawer.hidden = false;
  if (els.archiveView) els.archiveView.hidden = true;
  renderArchives();
}

function closeArchiveDrawer() {
  if (els.archiveDrawer) els.archiveDrawer.hidden = true;
  state.openArchive = null;
}

function renderArchiveView(archive) {
  if (!els.archiveView) return;
  state.openArchive = archive;
  els.archiveView.hidden = false;
  const clips = archive.clips || [];
  els.archiveView.innerHTML = `<div class="panel-head"><h2>${escapeHtml(archive.title)}</h2><span class="hint">${clips.length} 条 · 只读</span></div>${
    clips.length ? threadTree(clips).map((node) => renderThread(node, false, true)).join("") : `<div class="empty">空归档</div>`
  }`;
}

function closeConfirm() {
  state.pendingDeleteId = null;
  if (els.confirmModal) els.confirmModal.hidden = true;
  if (els.confirmInput) els.confirmInput.value = "";
}

function renderTimeline() {
  renderDraftTags();
  renderTagFilters();
  const total = state.clips.length;
  if (!total) {
    if (els.filterCount) els.filterCount.textContent = "";
    els.timeline.innerHTML = `<div class="empty">还没有内容。发送 Markdown / JSON / YAML，或把图片 / 文件拖进来。</div>`;
    return;
  }

  const shown = visibleClips();
  const matchedCount = state.clips.filter(clipMatchesFilters).length;
  if (els.filterCount) {
    els.filterCount.textContent = matchedCount === total ? `${total} 条` : `${matchedCount} / ${total} 条`;
  }
  if (!shown.length) {
    els.timeline.innerHTML = `<div class="empty">没有符合筛选条件的消息。</div>`;
    return;
  }
  els.timeline.innerHTML = threadTree(shown).map((node) => renderThread(node)).join("");
}

function send(payload) {
  if (!state.ws || state.ws.readyState !== 1) {
    toast("尚未连上房间");
    return false;
  }
  state.ws.send(JSON.stringify(payload));
  return true;
}

function connect() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }

  const room = els.room.value.trim() || "lan";
  const deviceName = els.deviceName.value.trim() || defaultName();
  localStorage.setItem(ROOM_KEY, room);
  localStorage.setItem(NAME_KEY, deviceName);
  syncSettingsLink();

  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", room);
  url.searchParams.set("deviceId", deviceId());
  url.searchParams.set("deviceName", deviceName);

  setStatus("connecting", "连接中");
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    state.reconnect = 800;
    setStatus("live", "已连接");
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "init") {
      state.you = msg.you;
      state.clips = msg.clips || [];
      state.peers = msg.peers || [];
      state.catalog = msg.tags || [];
      state.archives = msg.archives || [];
      renderPeers();
      renderTimeline();
      renderArchives();
    } else if (msg.type === "peers") {
      state.peers = msg.peers || [];
      renderPeers();
    } else if (msg.type === "clip") {
      state.clips.push(msg.clip);
      renderTimeline();
    } else if (msg.type === "edited") {
      const index = state.clips.findIndex((item) => item.id === msg.clip?.id);
      if (index !== -1) state.clips[index] = msg.clip;
      if (state.replyTo?.id === msg.clip?.id) state.replyTo = msg.clip;
      renderTimeline();
      if (state.editingId === msg.clip?.id) updateReplyBar();
    } else if (msg.type === "tagged") {
      const clip = state.clips.find((item) => item.id === msg.id);
      if (clip) clip.tags = Array.isArray(msg.tags) ? msg.tags : [];
      renderTimeline();
    } else if (msg.type === "catalog") {
      state.catalog = msg.tags || [];
      if (Array.isArray(msg.clips)) {
        const byId = new Map(msg.clips.map((item) => [item.id, item.tags || []]));
        for (const clip of state.clips) {
          if (byId.has(clip.id)) clip.tags = byId.get(clip.id);
        }
        state.draftTags = state.draftTags.filter((tag) => state.catalog.includes(tag));
        state.filterTags = state.filterTags.filter((tag) => usedTags().includes(tag));
      }
      renderTimeline();
    } else if (msg.type === "deleted") {
      state.clips = state.clips.filter((c) => c.id !== msg.id);
      if (state.replyTo?.id === msg.id) state.replyTo = null;
      if (state.editingId === msg.id) {
        state.editingId = null;
        updateReplyBar();
      }
      renderTimeline();
    } else if (msg.type === "archived") {
      state.clips = [];
      state.archives = msg.archives || [];
      cancelComposeMode();
      renderTimeline();
      renderArchives();
      toast("已归档当前房间");
    } else if (msg.type === "archive") {
      renderArchiveView(msg.archive);
      if (els.archiveDrawer) els.archiveDrawer.hidden = false;
    } else if (msg.type === "archive.challenge") {
      state.pendingDeleteId = msg.id;
      if (els.confirmCode) els.confirmCode.textContent = msg.code;
      if (els.confirmInput) els.confirmInput.value = "";
      if (els.confirmModal) els.confirmModal.hidden = false;
      els.confirmInput?.focus();
    } else if (msg.type === "archive.deleted") {
      state.archives = msg.archives || [];
      if (state.openArchive?.id === msg.id) {
        state.openArchive = null;
        if (els.archiveView) els.archiveView.hidden = true;
      }
      closeConfirm();
      renderArchives();
      toast("归档已删除");
    } else if (msg.type === "error") {
      toast(msg.error || "出错了");
    }
  };

  ws.onclose = () => {
    setStatus("offline", "已断开");
    setTimeout(connect, state.reconnect);
    state.reconnect = Math.min(state.reconnect * 1.6, 8000);
  };
}

async function uploadAndPush(file, extraText) {
  const body = new FormData();
  body.append("file", file, file.name);
  const res = await fetch("/api/upload", { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error || "上传失败");
    return false;
  }
  const payload = {
    type: file.type.startsWith("image/") ? "image" : "file",
    file: data,
  };
  if (extraText?.trim()) payload.text = extraText.trim().slice(0, 2000);
  if (state.replyTo?.id) payload.replyTo = state.replyTo.id;
  if (state.draftTags.length) payload.tags = state.draftTags;
  return send({ type: "push", payload });
}

function resetComposer() {
  els.draft.value = "";
  els.draftCount.textContent = "0";
  state.pendingFile = null;
  if (els.fileInput) els.fileInput.value = "";
  renderAttachPreview();
  state.draftTags = [];
  renderDraftTags();
  updateFormatHint();
  cancelComposeMode();
}

async function sendComposer() {
  const text = els.draft.value;
  if (state.editingId) {
    const clip = currentEdit();
    if (clip?.type === "text" && !text.trim()) return;
    if (send({ type: "edit", id: state.editingId, text, tags: state.draftTags })) resetComposer();
    return;
  }
  if (state.pendingFile) {
    if (await uploadAndPush(state.pendingFile, text)) resetComposer();
    return;
  }
  if (!text.trim()) return;
  const payload = { type: "text", text };
  if (state.replyTo?.id) payload.replyTo = state.replyTo.id;
  if (state.draftTags.length) payload.tags = state.draftTags;
  if (send({ type: "push", payload })) resetComposer();
}

function updateFormatHint() {
  if (!els.formatHint) return;
  const detected = detectKind(els.draft.value);
  els.formatHint.textContent = detected.label;
}

els.draft.addEventListener("input", () => {
  els.draftCount.textContent = String(els.draft.value.length);
  updateFormatHint();
});

els.draft.addEventListener("keydown", (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
    ev.preventDefault();
    sendComposer();
  }
});

els.send.addEventListener("click", sendComposer);
els.join.addEventListener("click", connect);
els.replyCancel?.addEventListener("click", clearReply);

els.draftTags?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-act='draft-tag']");
  if (!btn) return;
  state.draftTags = toggleList(state.draftTags, btn.dataset.tag);
  renderDraftTags();
});

els.tagFilters?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-act='filter-tag']");
  if (!btn) return;
  const tag = btn.dataset.tag;
  state.filterTags = tag ? toggleList(state.filterTags, tag) : [];
  renderTimeline();
});

els.fromTime?.addEventListener("change", () => renderTimeline());
els.toTime?.addEventListener("change", () => renderTimeline());
els.resetFilters?.addEventListener("click", () => {
  state.filterTags = [];
  if (els.fromTime) els.fromTime.value = "";
  if (els.toTime) els.toTime.value = "";
  renderTimeline();
});

els.archiveRoom?.addEventListener("click", () => {
  if (!state.clips.length) {
    toast("当前没有可归档的消息");
    return;
  }
  if (confirm(`把当前 ${state.clips.length} 条消息归档？时间线会清空，归档里仍可查看。`)) {
    send({ type: "archive", title: `归档 ${formatTime(Date.now())}` });
  }
});
els.archivesLink?.addEventListener("click", (ev) => {
  ev.preventDefault();
  openArchiveDrawer();
});
els.archiveClose?.addEventListener("click", closeArchiveDrawer);
els.archiveDrawer?.addEventListener("click", (ev) => {
  if (ev.target === els.archiveDrawer) closeArchiveDrawer();
});

els.archiveList?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "open-archive") {
    send({ type: "archive.open", id: btn.dataset.id });
    return;
  }
  if (btn.dataset.act === "delete-archive") {
    send({ type: "archive.delete.challenge", id: btn.dataset.id });
  }
});

els.confirmCancel?.addEventListener("click", closeConfirm);
els.confirmModal?.addEventListener("click", (ev) => {
  if (ev.target === els.confirmModal) closeConfirm();
});
els.confirmOk?.addEventListener("click", () => {
  if (!state.pendingDeleteId) return;
  send({ type: "archive.delete", id: state.pendingDeleteId, code: els.confirmInput?.value.trim() });
});
els.confirmInput?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    els.confirmOk?.click();
  }
});

els.pickFile.addEventListener("click", (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  els.fileInput.click();
});

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files?.[0];
  if (file) queueFile(file);
  els.fileInput.value = "";
});

["dragenter", "dragover"].forEach((type) => {
  els.composerBox?.addEventListener(type, (ev) => {
    ev.preventDefault();
    els.composerBox.classList.add("drag");
  });
});

["dragleave", "drop"].forEach((type) => {
  els.composerBox?.addEventListener(type, (ev) => {
    ev.preventDefault();
    els.composerBox.classList.remove("drag");
  });
});

els.composerBox?.addEventListener("drop", (ev) => {
  const file = ev.dataTransfer?.files?.[0];
  if (file) queueFile(file);
});

document.addEventListener("paste", (ev) => {
  const items = [...(ev.clipboardData?.items || [])];
  const fileItem = items.find((item) => item.kind === "file");
  if (fileItem) {
    const file = fileItem.getAsFile();
    if (file) queueFile(file);
    return;
  }
  if (document.activeElement !== els.draft) {
    const text = ev.clipboardData?.getData("text");
    if (text) els.draft.value = (els.draft.value ? `${els.draft.value}\n` : "") + text;
    els.draftCount.textContent = String(els.draft.value.length);
    updateFormatHint();
  }
});

els.copyOs.addEventListener("click", async () => {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const ext = imageType.split("/")[1] || "png";
          queueFile(new File([blob], `clipboard.${ext}`, { type: imageType }));
          return;
        }
        if (item.types.includes("text/plain")) {
          const blob = await item.getType("text/plain");
          els.draft.value = await blob.text();
          els.draftCount.textContent = String(els.draft.value.length);
          updateFormatHint();
          return;
        }
      }
    }
    const text = await navigator.clipboard.readText();
    els.draft.value = text;
    els.draftCount.textContent = String(els.draft.value.length);
    updateFormatHint();
  } catch {
    toast("浏览器拒绝读取系统剪贴板，直接粘贴即可");
  }
});

els.timeline.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const clip =
    (id ? state.clips.find((c) => c.id === id) : null) ||
    (id ? state.openArchive?.clips?.find((c) => c.id === id) : null);
  if (btn.dataset.act === "delete") {
    send({ type: "delete", id });
    return;
  }
  if (btn.dataset.act === "reply") {
    if (clip) setReply(clip);
    return;
  }
  if (btn.dataset.act === "edit") {
    if (clip) beginEdit(clip);
    return;
  }
  if (btn.dataset.act === "jump") {
    flashClip(id);
    return;
  }
  if (btn.dataset.act === "filter-tag") {
    const tag = btn.dataset.tag;
    state.filterTags = tag ? toggleList(state.filterTags, tag) : [];
    renderTimeline();
    return;
  }
  if (btn.dataset.act === "copy-code") {
    const source = btn.closest(".code-block")?.querySelector(".copy-source")?.value ?? "";
    await copyText(source);
    return;
  }
  if (btn.dataset.act === "copy" && clip?.text) {
    await copyText(clip.text);
  }
});

els.archiveView?.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act='copy'], [data-act='copy-code']");
  if (!btn) return;
  if (btn.dataset.act === "copy-code") {
    const source = btn.closest(".code-block")?.querySelector(".copy-source")?.value ?? "";
    await copyText(source);
    return;
  }
  const clip = state.openArchive?.clips?.find((item) => item.id === btn.dataset.id);
  if (clip?.text) await copyText(clip.text);
});

els.room.value = roomFromUrl();
els.deviceName.value = localStorage.getItem(NAME_KEY) || defaultName();
syncSettingsLink();
updateFormatHint();
updateReplyBar();
if (location.hash === "#archives") openArchiveDrawer();
window.addEventListener("hashchange", () => {
  if (location.hash === "#archives") openArchiveDrawer();
});

fetch("/api/info")
  .then((r) => r.json())
  .then((info) => {
    if (info.maxFileMb) {
      state.maxFileMb = info.maxFileMb;
      els.limitHint.textContent = `附件上限 ${info.maxFileMb} MB`;
    }
    const lan = document.getElementById("lan-url");
    const hints = (info.hints || []).filter((url) => !url.includes("127.0.0.1"));
    if (lan && hints.length) {
      lan.hidden = false;
      lan.textContent = `局域网 ${hints[0]}`;
    }
  })
  .catch(() => {});

connect();
