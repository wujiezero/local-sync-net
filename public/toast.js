let hideTimer = 0;
let lastAt = 0;
let host = null;

function ensureToast() {
  if (host && document.body.contains(host)) return host;
  host = document.createElement("div");
  host.id = "clipmesh-toast";
  host.className = "toast-banner";
  host.hidden = true;
  host.setAttribute("role", "status");
  document.body.appendChild(host);
  return host;
}

export function toast(message, kind = "ok") {
  const el = ensureToast();
  lastAt = Date.now();
  el.hidden = false;
  el.dataset.kind = kind === "error" ? "error" : "ok";
  el.innerHTML = `<span class="toast-banner-mark" aria-hidden="true">${kind === "error" ? "!" : "✓"}</span><span class="toast-banner-text"></span>`;
  el.querySelector(".toast-banner-text").textContent = String(message || "");
  el.classList.remove("is-in");
  void el.offsetWidth;
  el.classList.add("is-in");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove("is-in");
  }, 3200);
}

export function bindButtonFeedback() {
  document.addEventListener(
    "click",
    (ev) => {
      const btn = ev.target.closest("button, a.btn, .chip");
      if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return;
      btn.classList.add("is-pressed");
      setTimeout(() => btn.classList.remove("is-pressed"), 260);
    },
    true,
  );
}

bindButtonFeedback();
