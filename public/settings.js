import { toast } from "./toast.js";

const $ = (id) => document.getElementById(id);

const els = {
  status: $("status"),
  room: $("room"),
  deviceName: $("device-name"),
  join: $("join"),
  newTag: $("new-tag"),
  addTag: $("add-tag"),
  catalog: $("catalog"),
  tagCount: $("tag-count"),
  toast: $("toast"),
};

const DEVICE_KEY = "clipmesh.deviceId";
const NAME_KEY = "clipmesh.deviceName";
const ROOM_KEY = "clipmesh.room";

const state = {
  ws: null,
  tags: [],
  reconnect: 800,
};

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

function sanitizeTag(input) {
  return String(input || "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .trim()
    .slice(0, 16);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(kind, label) {
  els.status.dataset.state = kind;
  els.status.querySelector("span").textContent = label;
}



function send(payload) {
  if (!state.ws || state.ws.readyState !== 1) {
    toast("尚未连上房间", "error");
    return false;
  }
  state.ws.send(JSON.stringify(payload));
  return true;
}

function renderCatalog() {
  els.tagCount.textContent = `${state.tags.length} / 40`;
  if (!state.tags.length) {
    els.catalog.innerHTML = `<div class="empty">还没有标签。</div>`;
    return;
  }
  els.catalog.innerHTML = state.tags
    .map(
      (tag) => `<div class="catalog-item" data-tag="${escapeHtml(tag)}">
        <input class="catalog-name" type="text" maxlength="16" value="${escapeHtml(tag)}" />
        <div class="catalog-actions">
          <button class="btn btn-ghost btn-mini" type="button" data-act="rename">保存</button>
          <button class="btn btn-ghost btn-mini btn-danger" type="button" data-act="delete">删除</button>
        </div>
      </div>`,
    )
    .join("");
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
      state.tags = msg.tags || [];
      renderCatalog();
    } else if (msg.type === "catalog") {
      state.tags = msg.tags || [];
      renderCatalog();
    } else if (msg.type === "error") {
      toast(msg.error || "出错了", "error");
    }
  };

  ws.onclose = () => {
    setStatus("offline", "已断开");
    setTimeout(connect, state.reconnect);
    state.reconnect = Math.min(state.reconnect * 1.6, 8000);
  };
}

function addTag() {
  const name = sanitizeTag(els.newTag.value);
  if (!name) return;
  if (send({ type: "tags.create", name })) {
    els.newTag.value = "";
    toast("已添加标签");
  }
}

els.addTag.addEventListener("click", addTag);
els.newTag.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    addTag();
  }
});
els.join.addEventListener("click", connect);

els.catalog.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const row = btn.closest(".catalog-item");
  const from = row?.dataset.tag;
  if (!from) return;
  if (btn.dataset.act === "delete") {
    if (confirm(`删除标签「${from}」？已用该标签的消息会去掉它。`)) {
      send({ type: "tags.delete", name: from });
      toast("已删除标签");
    }
    return;
  }
  if (btn.dataset.act === "rename") {
    const to = sanitizeTag(row.querySelector(".catalog-name")?.value);
    if (!to || to === from) return;
    send({ type: "tags.rename", from, to });
    toast("已重命名标签");
  }
});

els.room.value = roomFromUrl();
els.deviceName.value = localStorage.getItem(NAME_KEY) || defaultName();
fetch("/api/session")
  .then((r) => r.json())
  .then((data) => {
    const btn = document.getElementById("logout");
    if (btn && data.auth) {
      btn.hidden = false;
      btn.addEventListener("click", async () => {
        await fetch("/api/logout", { method: "POST" });
        location.href = "/login";
      });
    }
  })
  .catch(() => {});
connect();
