const DEFAULTS = { server: "http://127.0.0.1:11437", target: "ja", mode: "replace", math: "mathml", size: "2b", autoStart: true, idleStopMin: 30 };
const ids = Object.keys(DEFAULTS);
const $ = (id) => document.getElementById(id);

function read(k) {
  const el = $(k);
  if (el.type === "checkbox") return el.checked;
  if (typeof DEFAULTS[k] === "number") {
    return el.value !== "" && Number.isFinite(Number(el.value)) ? Math.max(0, Number(el.value)) : DEFAULTS[k];
  }
  return el.value.trim() || DEFAULTS[k];
}

function write(k, v) {
  const el = $(k);
  if (el.type === "checkbox") el.checked = !!v;
  else el.value = String(v);
}

async function testServer() {
  const status = $("status");
  status.className = "";
  status.textContent = "確認しています…";
  if ((await chrome.runtime.sendMessage({ type: "engine-info" }))?.kind === "builtin") {
    status.textContent = "内蔵エンジンを使うので、サーバーは使いません";
    return;
  }
  const r = await chrome.runtime.sendMessage({ type: "health" });
  status.className = r?.ok ? "ok" : "ng";
  status.textContent = r?.ok
    ? "接続できました: " + (r.model || "").replace(/\.gguf$/, "")
    : "接続できません（サーバーが止まっているか、URL が違います）";
}

let savedTimer = null;
function showSaved() {
  $("saved").textContent = "保存しました";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $("saved").textContent = ""; }, 2500);
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  for (const k of ids) write(k, s[k]);
  testServer();
});
for (const k of ids) {
  $(k).addEventListener("change", async () => {
    const v = read(k);
    write(k, v);
    await chrome.storage.sync.set({ [k]: v });
    showSaved();
    if (k === "server") testServer();
  });
}
$("test").addEventListener("click", testServer);

// The engine choice lives in storage.local so each PC keeps its own.
const PHASE = { idle: "読み込んでいません（最初の翻訳で読み込みます）", downloading: "モデルを取得中", loading: "読み込み中", ready: "準備完了", error: "読み込めません" };
async function showEngine() {
  const r = await chrome.runtime.sendMessage({ type: "engine-info" });
  const st = r?.state || {};
  $("engineHelp").textContent = r?.kind === "builtin"
    ? "内蔵エンジン: " + (PHASE[st.phase] || st.phase || "") + (st.phase === "downloading" ? ` ${st.pct}%` : "") +
      (st.backend ? `（${st.backend}）` : "") + (st.detail ? " — " + st.detail : "")
    : "llama-server を使います。";
}
chrome.storage.local.get({ engine: "auto", device: "cpu" }).then(({ engine, device }) => {
  $("engine").value = engine;
  $("device").value = device;
  showEngine();
});
// Takes effect on the next translation (the engine reloads on the other device).
$("device").addEventListener("change", async () => {
  await chrome.storage.local.set({ device: $("device").value });
  showSaved();
});
$("engine").addEventListener("change", async () => {
  await chrome.storage.local.set({ engine: $("engine").value });
  showSaved();
  showEngine();
  testServer();
});
chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === "engine-state") showEngine(); });
