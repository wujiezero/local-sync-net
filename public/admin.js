import { toast } from "./toast.js";

const $ = (id) => document.getElementById(id);

const els = {
  total: $("stat-total"),
  live: $("stat-live"),
  orphan: $("stat-orphan"),
  list: $("room-list"),
  refresh: $("refresh"),
  toast: $("toast"),
  filterAll: $("filter-all"),
  filterLive: $("filter-live"),
  filterOrphan: $("filter-orphan"),
};

const state = {
  rooms: [],
  filter: "all",
};



function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(ts) {
  if (!ts) return "—";
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

function setFilter(kind) {
  state.filter = kind;
  for (const [id, value] of [
    ["filterAll", "all"],
    ["filterLive", "live"],
    ["filterOrphan", "orphan"],
  ]) {
    els[id].classList.toggle("active", state.filter === value);
  }
  render();
}

function visible() {
  if (state.filter === "live") return state.rooms.filter((room) => room.peers > 0);
  if (state.filter === "orphan") return state.rooms.filter((room) => room.orphan);
  return state.rooms;
}

function render() {
  els.total.textContent = String(state.rooms.length);
  els.live.textContent = String(state.rooms.filter((room) => room.peers > 0).length);
  els.orphan.textContent = String(state.rooms.filter((room) => room.orphan).length);
  const rows = visible();
  if (!rows.length) {
    els.list.innerHTML = `<div class="empty">${state.filter === "orphan" ? "没有孤儿房间。" : "还没有房间数据。"}</div>`;
    return;
  }
  els.list.innerHTML = rows
    .map((room) => {
      const badge = room.orphan
        ? `<span class="kind file">孤儿</span>`
        : room.peers > 0
          ? `<span class="kind">在线</span>`
          : `<span class="kind file">空闲</span>`;
      const people = room.peerNames?.length ? escapeHtml(room.peerNames.join("、")) : "无人";
      return `<article class="admin-room">
        <div class="clip-head">
          <div class="clip-head-main">
            <b class="mono">${escapeHtml(room.name)}</b>
            ${badge}
          </div>
          <span class="hint mono">${formatTime(room.lastActivity)}</span>
        </div>
        <p class="howto">${room.clips} 条消息 · ${room.archives} 个归档 · ${room.files} 个附件 · ${room.tags} 个标签 · ${room.peers} 人在线（${people}）</p>
        <div class="clip-actions">
          <a class="btn btn-ghost" href="/?room=${encodeURIComponent(room.name)}">进入房间</a>
          <a class="btn btn-ghost" href="/?room=${encodeURIComponent(room.name)}#archives">查看归档</a>
          <a class="btn btn-ghost" href="/settings?room=${encodeURIComponent(room.name)}">标签配置</a>
        </div>
      </article>`;
    })
    .join("");
}

async function load() {
  try {
    const res = await fetch("/api/rooms");
    const data = await res.json();
    state.rooms = data.rooms || [];
    render();
  } catch {
    toast("无法读取房间列表", "error");
  }
}

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

els.refresh.addEventListener("click", load);
els.filterAll.addEventListener("click", () => setFilter("all"));
els.filterLive.addEventListener("click", () => setFilter("live"));
els.filterOrphan.addEventListener("click", () => setFilter("orphan"));
load();
setInterval(load, 8000);
