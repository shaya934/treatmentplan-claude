"use strict";
const $ = (id) => document.getElementById(id);
const screens = ["login", "newpw", "setup", "mfa", "app"];
let challenge = "";
let files = []; // { file, el, state }
let job = null;

function show(id) {
  for (const s of screens) $(s).hidden = s !== id;
  $("signout").hidden = id !== "app";
  error("");
  const first = $(id).querySelector("input");
  if (first) first.focus();
}
function error(msg) {
  $("error").textContent = msg;
  $("error").hidden = !msg;
}

async function api(method, path, body, raw) {
  const res = await fetch(path, {
    method,
    headers: raw ? { "x-drop": "1" } : { "x-drop": "1", "content-type": "application/json" },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401 && !path.startsWith("/api/login") && screens.indexOf(currentScreen()) === 4) {
    show("login");
    throw new Error("You were signed out. Please sign in again.");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Something went wrong.");
  return res;
}
const currentScreen = () => screens.find((s) => !$(s).hidden);

function step(r) {
  challenge = r.challenge || "";
  if (r.step === "new_password") show("newpw");
  else if (r.step === "mfa") show("mfa");
  else if (r.step === "mfa_setup") {
    $("qr").src = r.qr;
    $("secret").textContent = r.secret;
    show("setup");
  } else if (r.step === "done") startApp();
}

function onSubmit(id, fn) {
  $(id).addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $(id).querySelector("button");
    btn.disabled = true;
    try {
      await fn(new FormData($(id)));
    } catch (err) {
      error(err.message);
    } finally {
      btn.disabled = false;
    }
  });
}
onSubmit("login", async (f) => step(await (await api("POST", "/api/login", { email: f.get("email"), password: f.get("password") })).json()));
onSubmit("newpw", async (f) => step(await (await api("POST", "/api/new-password", { challenge, password: f.get("password") })).json()));
onSubmit("setup", async (f) => step(await (await api("POST", "/api/mfa", { challenge, code: f.get("code") })).json()));
onSubmit("mfa", async (f) => step(await (await api("POST", "/api/mfa", { challenge, code: f.get("code") })).json()));

$("signout").addEventListener("click", async () => {
  await api("POST", "/api/logout").catch(() => {});
  location.reload();
});

// ---- the app ----
function startApp() {
  for (const id of ["login", "newpw", "setup", "mfa"]) $(id).reset();
  files = [];
  job = null;
  $("list").replaceChildren();
  $("create").hidden = false;
  $("drop").hidden = false;
  $("working").hidden = true;
  $("done").hidden = true;
  refresh();
  show("app");
}
function refresh() {
  $("create").disabled = !files.length || files.some((f) => f.state === "uploading");
}

async function ensureJob() {
  if (!job) job = (await (await api("POST", "/api/jobs")).json()).id;
  return job;
}

async function add(list) {
  error("");
  for (const file of list) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${file.name} — uploading…`;
    li.append(name);
    $("list").append(li);
    const entry = { file, el: li, state: "uploading" };
    files.push(entry);
    refresh();
    try {
      const id = await ensureJob();
      await api("PUT", `/api/jobs/${id}/files?name=${encodeURIComponent(file.name)}`, null, file);
      entry.state = "ok";
      name.textContent = file.name;
    } catch (err) {
      entry.state = "fail";
      li.classList.add("fail");
      name.textContent = `${file.name} — ${err.message}`;
      files = files.filter((f) => f !== entry);
    }
    refresh();
  }
}

const drop = $("drop");
$("files").addEventListener("change", () => {
  add([...$("files").files]);
  $("files").value = "";
});
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") $("files").click();
});
for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  add([...e.dataTransfer.files]);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

$("create").addEventListener("click", async () => {
  $("create").disabled = true;
  try {
    await api("POST", `/api/jobs/${job}/start`);
    $("create").hidden = true;
    $("drop").hidden = true;
    $("working").hidden = false;
    poll();
  } catch (err) {
    error(err.message);
    refresh();
  }
});

async function poll() {
  try {
    const s = await (await api("GET", `/api/jobs/${job}`)).json();
    if (s.state === "working") return setTimeout(poll, 4000);
    $("working").hidden = true;
    if (s.state === "done") $("done").hidden = false;
    else error(s.message || "Something went wrong. Please start over.");
  } catch (err) {
    $("working").hidden = true;
    error(err.message);
  }
}

$("download").addEventListener("click", () => {
  location.href = `/api/jobs/${job}/pdf`;
});
$("again").addEventListener("click", async () => {
  if (!confirm("Delete these documents and the filled form now?")) return;
  await api("DELETE", `/api/jobs/${job}`).catch((err) => error(err.message));
  startApp();
});

// Sign out on this screen after 15 minutes without activity (the server enforces it too).
let idle;
function resetIdle() {
  clearTimeout(idle);
  idle = setTimeout(() => location.reload(), 15 * 60 * 1000);
}
for (const ev of ["mousemove", "keydown", "click", "touchstart"]) window.addEventListener(ev, resetIdle, { passive: true });
resetIdle();

(async () => {
  const res = await fetch("/api/me");
  if (res.ok) startApp();
  else show("login");
})();
