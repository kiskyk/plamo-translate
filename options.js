const DEFAULTS = { server: "http://127.0.0.1:11437", target: "ja", mode: "replace", size: "2b", autoStart: true, idleStopMin: 30 };
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
