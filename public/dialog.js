let pending = null;

function els() {
  return {
    modal: document.getElementById("confirm-modal"),
    title: document.getElementById("dialog-title"),
    body: document.getElementById("dialog-body"),
    input: document.getElementById("dialog-input"),
    cancel: document.getElementById("dialog-cancel"),
    ok: document.getElementById("dialog-ok"),
  };
}

function closeDialog(value) {
  const ui = els();
  if (ui.modal) ui.modal.hidden = true;
  const done = pending;
  pending = null;
  if (done) done(value);
}

export function openDialog({ title, body, confirmText = "确定", danger = false, value, placeholder, inputMode } = {}) {
  const ui = els();
  if (!ui.modal) return Promise.resolve(null);
  ui.title.textContent = title || "确认";
  ui.body.innerHTML = "";
  ui.body.textContent = body || "";
  ui.ok.textContent = confirmText;
  ui.ok.classList.toggle("btn-danger", Boolean(danger));
  if (value != null || placeholder) {
    ui.input.hidden = false;
    ui.input.value = value || "";
    ui.input.placeholder = placeholder || "";
    ui.input.inputMode = inputMode || "text";
  } else {
    ui.input.hidden = true;
    ui.input.value = "";
  }
  ui.modal.hidden = false;
  setTimeout(() => (ui.input.hidden ? ui.ok : ui.input).focus(), 30);
  return new Promise((resolve) => {
    pending = resolve;
  });
}

export function bindDialog() {
  const ui = els();
  if (!ui.modal || ui.modal.dataset.bound) return;
  ui.modal.dataset.bound = "1";
  ui.cancel?.addEventListener("click", () => closeDialog(null));
  ui.ok?.addEventListener("click", () => {
    closeDialog(ui.input.hidden ? true : ui.input.value);
  });
  ui.modal.addEventListener("click", (ev) => {
    if (ev.target === ui.modal) closeDialog(null);
  });
  ui.input?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      closeDialog(ui.input.value);
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && ui.modal && !ui.modal.hidden) {
      ev.preventDefault();
      closeDialog(null);
    }
  });
}

bindDialog();
