import { toast } from "./toast.js?v=remember1";

const params = new URLSearchParams(location.search);
const next = params.get("next") || "/";
const form = document.getElementById("login-form");
const error = document.getElementById("login-error");

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  error.hidden = true;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: document.getElementById("username").value,
      password: document.getElementById("password").value,
      remember: document.getElementById("remember")?.checked !== false,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    error.hidden = false;
    error.textContent = data.error || "用户名或密码不正确";
    toast(error.textContent, "error");
    return;
  }
  toast("登录成功");
  const target = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  location.replace(target);
});
