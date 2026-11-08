// Service worker: talks to the local llama-server and routes the toolbar button.
const DEFAULTS = { server: "http://127.0.0.1:11437", target: "ja", size: "2b", autoStart: true, idleStopMin: 30 };
const MAX_PARALLEL = 4; // matches -np 4 in start-plamo.ps1
const HOST = "com.plamo.translate_host"; // registered by host/install.ps1
const IDLE_TITLE = "このページを翻訳（PDF なら翻訳ビューアで開く）";

const cache = new Map();
const queue = [];
let running = 0;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

// ---- server lifecycle via the native host ----
function native(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, msg, (r) => {
        if (chrome.runtime.lastError) {
          console.warn("native host:", chrome.runtime.lastError.message);
          resolve({ ok: false, up: false, log: chrome.runtime.lastError.message, noHost: true });
        } else resolve(r);
      });
    } catch (e) {
      resolve({ ok: false, up: false, log: String(e), noHost: true });
    }
  });
}

async function serverUp() {
  const s = await settings();
  try {
    const r = await fetch(s.server.replace(/\/$/, "") + "/props");
    const p = await r.json();
    return { up: true, model: String(p.model_path || "").split(/[\\/]/).pop() };
  } catch {
    return { up: false, model: "" };
  }
}

let starting = null;
// Makes sure the server is running; starts it (once, shared by all callers) when it is not.
// With `size` (chosen from the menu) a server running another size is restarted.
async function ensureServer(size) {
  const st = await serverUp();
  if (st.up && (!size || st.model.includes(`-${size}-`))) return { ok: true, ...st };
  size = size || (await settings()).size;
  if (!starting) {
    starting = native({ cmd: "start", size }).then(async (r) => {
      if (r?.ok && r.up) await chrome.storage.session.set({ startedByExt: true });
      return r;
    }).finally(() => { starting = null; });
  }
  const r = await starting;
  // up with another size: the requested file was missing and the running server was left alone
  return { ok: !!(r?.ok && r.up && String(r.model).includes(`-${size}-`)), model: r?.model || "", noHost: r?.noHost, log: r?.log || "" };
}

async function stopServer() {
  await chrome.storage.session.set({ startedByExt: false });
  return native({ cmd: "stop" });
}

let lastTouch = 0;
async function touchIdle() {
  const now = Date.now();
  if (now - lastTouch < 60_000) return;
  lastTouch = now;
  const s = await settings();
  if (s.idleStopMin > 0) chrome.alarms.create("idle-stop", { delayInMinutes: Number(s.idleStopMin) });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "idle-stop") return;
  if (running || queue.length) { chrome.alarms.create("idle-stop", { delayInMinutes: 5 }); return; }
  const { startedByExt } = await chrome.storage.session.get({ startedByExt: false });
  if (startedByExt) { // leave servers the user started by hand alone
    await stopServer();
    await chrome.action.setBadgeText({ text: "" });
  }
});

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const { job, resolve, reject } = queue.shift();
    running++;
    job().then(resolve, reject).finally(() => { running--; pump(); });
  }
}

function schedule(job) {
  return new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); pump(); });
}

// context: surrounding text for short strings (table cells, list items). PLaMo's chat template
// uses a system message that does not start with [plamo-translate] as context.
async function translate(text, target, context) {
  const s = await settings();
  target = target || s.target;
  const key = target + "\u0000" + (context || "") + "\u0000" + text;
  if (cache.has(key)) return cache.get(key);
  touchIdle();
  const body = JSON.stringify({
    model: "plamo",
    messages: [...(context ? [{ role: "system", content: context }] : []), { role: "user", content: text }],
    chat_template_kwargs: { target_lang: target },
    temperature: 0,
    max_tokens: 2048,
  });
  const post = () => fetch(s.server.replace(/\/$/, "") + "/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  const out = await schedule(async () => {
    let res;
    try {
      res = await post();
    } catch {
      if (!s.autoStart || !(await ensureServer()).ok) throw new Error("SERVER_DOWN");
      try { res = await post(); } catch { throw new Error("SERVER_DOWN"); }
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    return (j.choices?.[0]?.message?.content || "").trim();
  });
  if (cache.size > 5000) cache.clear();
  cache.set(key, out);
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "translate") {
    translate(msg.text, msg.target, msg.context).then(
      (text) => sendResponse({ ok: true, text }),
      (e) => sendResponse({ ok: false, error: String(e.message || e) }),
    );
    return true;
  }
  if (msg?.type === "page-state" && _sender.tab?.id) {
    const tabId = _sender.tab.id;
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#1b7a52" });
    chrome.action.setBadgeText({ tabId, text: msg.on ? "訳" : null });
    chrome.action.setTitle({ tabId, title: msg.on ? "翻訳を解除して元に戻す" : IDLE_TITLE });
    return;
  }
  if (msg?.type === "health") {
    serverUp().then((st) => sendResponse({ ok: st.up, model: st.model }));
    return true;
  }
  if (msg?.type === "stop") {
    stopServer().then(sendResponse);
    return true;
  }
  if (msg?.type === "ensure") {
    settings().then(async (s) => {
      const st = await serverUp();
      if (st.up || !s.autoStart) return sendResponse({ ok: st.up, model: st.model });
      sendResponse(await ensureServer());
    });
    return true;
  }
});

function viewerUrl(pdfUrl) {
  return chrome.runtime.getURL("viewer.html") + "?file=" + encodeURIComponent(pdfUrl);
}

function looksLikePdfUrl(url) {
  return /\.pdf($|[?#])/i.test(url || "") || /arxiv\.org\/pdf\//i.test(url || "");
}

async function isPdfTab(tab) {
  if (looksLikePdfUrl(tab.url)) return true;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.contentType,
    });
    return r?.result === "application/pdf";
  } catch {
    return false;
  }
}

// Browser pages (settings, the extension store) refuse scripts; say so on the button.
async function cannotTranslate(tab) {
  if (!tab?.id) return;
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#b3261e" });
  await chrome.action.setBadgeText({ tabId: tab.id, text: "×" });
  await chrome.action.setTitle({ tabId: tab.id, title: "このページは翻訳できません（ブラウザの管理ページなど）" });
}

async function inject(tab) {
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared.js", "content.js"] });
}

async function togglePage(tab) {
  if (!tab?.id || !/^(https?|file):/.test(tab.url || "")) { await cannotTranslate(tab); return; }
  if (await isPdfTab(tab)) {
    await chrome.tabs.update(tab.id, { url: viewerUrl(tab.url) });
    return;
  }
  try {
    await inject(tab);
  } catch {
    await cannotTranslate(tab);
    return;
  }
  await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
}

async function translateSelection(tab, text) {
  if (!tab?.id || !/^(https?|file):/.test(tab.url || "")) { await cannotTranslate(tab); return; }
  await inject(tab);
  await chrome.tabs.sendMessage(tab.id, { type: "translate-selection", text });
}

chrome.action.onClicked.addListener((tab) => { togglePage(tab).catch(console.error); });

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "translate-selection") translateSelection(tab).catch(console.error);
});

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    // Keep the action items first: Vivaldi's button menu lists every context and cuts off after ACTION_MENU_TOP_LEVEL_LIMIT.
    chrome.contextMenus.create({ id: "viewer", title: "PDF 翻訳ビューアを開く（ファイルを選ぶ）", contexts: ["action"] });
    chrome.contextMenus.create({ id: "start", title: "翻訳サーバーを起動", contexts: ["action"] });
    for (const [size, note] of [["0.8b", "いちばん軽い"], ["2b", "速い"], ["8b", "丁寧"], ["31b", "いちばん大きい"]]) {
      chrome.contextMenus.create({ id: "start-" + size, parentId: "start", title: `${size.toUpperCase()}（${note}）`, contexts: ["action"] });
    }
    chrome.contextMenus.create({ id: "stop", title: "翻訳サーバーを止める（VRAM を空ける）", contexts: ["action"] });
    chrome.contextMenus.create({ id: "page", title: "このページを翻訳 / 元に戻す", contexts: ["page"] });
    chrome.contextMenus.create({ id: "selection", title: "選択した文を翻訳", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "pdf-link", title: "リンク先の PDF を翻訳ビューアで開く", contexts: ["link"] });
  });
}
chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

async function badge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color: color || "#2ea06e" });
  await chrome.action.setBadgeText({ text });
}

async function menuServer(id) {
  await badge("…", "#888888");
  const r = id === "stop" ? await stopServer() : await ensureServer(id.slice(6));
  const ok = id === "stop" ? r?.ok && !r.up : r?.ok;
  await badge(ok ? (id === "stop" ? "" : id.slice(6).toUpperCase()) : "!", ok ? undefined : "#c0392b");
  if (!ok) {
    const why = r?.noHost
      ? "中継プログラムを呼び出せません（" + (r?.log || "") + "）。host\\install.ps1 を一度実行してください"
      : "サーバーの操作に失敗しました: " + (r?.log || "").slice(0, 200);
    await chrome.action.setTitle({ title: why }); // shown when hovering the button
  } else {
    await chrome.action.setTitle({ title: IDLE_TITLE });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (/^(start-|stop)/.test(info.menuItemId)) { menuServer(info.menuItemId).catch(console.error); return; }
  if (info.menuItemId === "page") togglePage(tab).catch(console.error);
  if (info.menuItemId === "selection") translateSelection(tab, info.selectionText).catch(console.error);
  if (info.menuItemId === "pdf-link") chrome.tabs.create({ url: viewerUrl(info.linkUrl) });
  if (info.menuItemId === "viewer") chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});
