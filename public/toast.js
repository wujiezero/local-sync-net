let hideTimer = 0;
let lastAt = 0;

function ensureToast() {
  let el = document.getElementById("toast");
  if (el) return el;
  el = document.createElement("div");
  el.id = "toast";
  el.className = "toast";
  el.hidden = true;
  el.setAttribute("role", "status");
  document.body.appendChild(el);
  return el;
}

export function toast(message, kind = "ok") {
  const el = ensureToast();
  lastAt = Date.now();
  el.hidden = false;
  el.dataset.kind = kind === "error" ? "error" : "ok";
  el.innerHTML = `<span class="toast-mark" aria-hidden="true">${kind === "error" ? "!" : "✓"}</span><span class="toast-text"></span>`;
  el.querySelector(".toast-text").textContent = String(message || "");
  el.classList.remove("toast-in");
  void el.offsetWidth;
  el.classList.add("toast-in");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove("toast-in");
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
      if (btn.dataset.toast === "off") return;
      const stamp = lastAt;
      const label = (btn.dataset.toast || btn.getAttribute("aria-label") || btn.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!label || label.length > 24) return;
      setTimeout(() => {
        if (lastAt !== stamp) return;
        toast(label, btn.classList.contains("btn-danger") ? "error" : "ok");
      }, 40);
    },
    true,
  );
}

bindButtonFeedback();
