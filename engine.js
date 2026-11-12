// In-browser engine: PLaMo 3 Translate 0.8B on wllama (llama.cpp in WebAssembly, WebGPU when available).
// Lives in an offscreen document so its workers outlive the service worker. background.js talks to it with
// chrome.runtime messages whose `target` is "engine".
const MODEL = {
  file: "plamo-3-translate-0.8b-Q4_K_M.gguf",
  url: "https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf",
  size: 573_123_200,
};
const CTX_PER_SLOT = 2048; // one PDF paragraph plus its translation fits
const TAG = "<|plamo:tag|>", MSG = "<|plamo:msg|>", KEY = "<|plamo:key|>", VAL = "<|plamo:val|>", BOS = "<|plamo:bos|>";

let state = { phase: "idle", backend: "", detail: "", pct: 0 };
let loading = null;
let runtime = null; // { wllama, parallel, backend }
// Outside the extension (test/engine.html served over http) assets resolve relative to this file.
const inExtension = !!globalThis.chrome?.runtime?.id;
const assetUrl = (p) => (inExtension ? chrome.runtime.getURL(p) : new URL(p, import.meta.url).href);

function setState(patch) {
  state = { ...state, ...patch };
  if (inExtension) chrome.runtime.sendMessage({ type: "engine-state", state }).catch(() => {});
  globalThis.dispatchEvent?.(new CustomEvent("engine-state", { detail: state }));
}

// ---- model file in OPFS ----
async function modelFile() {
  try {
    return await cachedModelFile();
  } catch (e) {
    // No room in OPFS (a page without unlimitedStorage): keep the model in memory for this session.
    if (!/quota/i.test(String(e?.message || e))) throw e;
    console.warn("OPFS full, loading the model into memory", e);
    try { await (await navigator.storage.getDirectory()).removeEntry(MODEL.file + ".part"); } catch {}
    return downloadToMemory();
  }
}

async function downloadToMemory() {
  setState({ phase: "downloading", pct: 0 });
  const res = await fetch(MODEL.url);
  if (!res.ok || !res.body) throw new Error(`モデルを落とせません（HTTP ${res.status}）`);
  const reader = res.body.getReader();
  const parts = [];
  let got = 0, shown = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    const pct = Math.floor((got / MODEL.size) * 100);
    if (pct !== shown) { shown = pct; setState({ pct }); }
  }
  if (got !== MODEL.size) throw new Error("モデルのダウンロードが途中で切れました");
  return new Blob(parts);
}

async function cachedModelFile() {
  const dir = await navigator.storage.getDirectory();
  try {
    const h = await dir.getFileHandle(MODEL.file);
    const f = await h.getFile();
    if (f.size === MODEL.size) return f;
    await dir.removeEntry(MODEL.file);
  } catch {}
  setState({ phase: "downloading", pct: 0 });
  const part = await dir.getFileHandle(MODEL.file + ".part", { create: true });
  const out = await part.createWritable();
  let got = 0, shown = -1;
  // A dropped connection resumes from where it stopped (Range request), up to 5 times.
  for (let attempt = 0; got < MODEL.size; attempt++) {
    try {
      const res = await fetch(MODEL.url, got ? { headers: { Range: `bytes=${got}-` } } : {});
      if (!res.ok || !res.body || (got && res.status !== 206)) throw new Error(`モデルを落とせません（HTTP ${res.status}）`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await out.write(value);
        got += value.byteLength;
        const pct = Math.floor((got / MODEL.size) * 100);
        if (pct !== shown) { shown = pct; setState({ pct }); }
      }
      if (got < MODEL.size) throw new Error("接続が途中で切れました");
    } catch (e) {
      if (attempt >= 4 || /HTTP 4/.test(String(e?.message))) { await out.abort().catch(() => {}); throw e; }
      console.warn("download retry", got, e);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  await out.close();
  if ((await part.getFile()).size !== MODEL.size) {
    await dir.removeEntry(MODEL.file + ".part");
    throw new Error("モデルのダウンロードが途中で切れました");
  }
  await part.move(MODEL.file);
  return (await dir.getFileHandle(MODEL.file)).getFile();
}

// ---- runtime ----
async function hasWebGpu() {
  try {
    const a = await navigator.gpu?.requestAdapter();
    return !!a && a.features.has("shader-f16");
  } catch {
    return false;
  }
}

// device: "cpu" (default; on an integrated GPU the CPU decoded faster) or "webgpu" (falls back to the CPU).
function plans(gpu, device) {
  const threads = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
  const cpu = { backend: "cpu", n_gpu_layers: 0, n_parallel: 1, n_threads: threads };
  if (!gpu || device !== "webgpu") return [cpu];
  return [
    { backend: "webgpu", n_gpu_layers: 99999, n_parallel: 4, n_threads: threads },
    { backend: "webgpu", n_gpu_layers: 99999, n_parallel: 1, n_threads: threads },
    cpu,
  ];
}

async function createRuntime(file, plan) {
  const { Wllama } = await import(assetUrl("vendor/wllama/wllama.js"));
  const u = (n) => assetUrl("vendor/wllama/" + n);
  const lines = [];
  const note = (...a) => { if (lines.length < 2000) lines.push(a.map(String).join(" ")); };
  const wllama = new Wllama({
    default: u("wllama.wasm"),
    "wllama.worker.js": u("wllama-worker.js"),
    "wllama.module.js": u("wllama-module.js"),
    "wllama.pthread.js": u("wllama-pthread.js"),
    // The compat (non-JSPI) build is not shipped; Chromium 137+ has JSPI.
    "wllama.compat.js": u("wllama-module.js"),
    "wllama.compat.pthread.js": u("wllama-pthread.js"),
    "wllama.compat.wasm": u("wllama.wasm"),
  }, { suppressNativeLog: false, logger: { debug: note, log: note, warn: note, error: note } });
  try {
    await wllama.loadModel([file], {
      n_ctx: CTX_PER_SLOT * plan.n_parallel,
      n_threads: globalThis.crossOriginIsolated ? plan.n_threads : 1,
      n_gpu_layers: plan.n_gpu_layers,
      n_parallel: plan.n_parallel,
      swa_full: true, // faster prompt processing on PLaMo 3 (measured by sakutto)
      ...(plan.n_parallel > 1 ? { cont_batching: true } : {}),
      ctx_shift: false,
      log_level: 2,
    });
  } catch (e) {
    await wllama.exit().catch(() => {});
    throw new Error((e?.message || String(e)) + "\n" + lines.filter((l) => /error|fail|webgpu/i.test(l)).slice(-5).join("\n"));
  }
  if (plan.backend === "webgpu") {
    const off = lines.map((l) => /offloaded (\d+)\/\d+ layers to GPU/i.exec(l)).find(Boolean);
    const failed = lines.some((l) => /ggml_webgpu: (Failed to get|giving up|no adapter|adapter lacks|correctness probe failed)/i.test(l));
    if ((off && Number(off[1]) === 0) || (!off && failed)) {
      await wllama.exit().catch(() => {});
      throw new Error("WebGPU に載りませんでした");
    }
  }
  return { wllama, parallel: plan.n_parallel, backend: plan.backend, active: 0, waiters: [] };
}

async function load(device = "cpu") {
  if (loading) await loading.catch(() => {});
  if (runtime && runtime.device !== device) await unload();
  if (runtime) return runtime;
  if (!loading) {
    loading = (async () => {
      try {
        const file = await modelFile();
        setState({ phase: "loading", pct: 100 });
        let last;
        for (const plan of plans(device === "webgpu" && (await hasWebGpu()), device)) {
          try {
            runtime = { ...(await createRuntime(file, plan)), device };
            setState({ phase: "ready", backend: `${plan.backend}${plan.n_parallel > 1 ? " ×" + plan.n_parallel : ""}`, detail: "" });
            return runtime;
          } catch (e) {
            last = e;
            console.warn("engine plan failed", plan, e);
          }
        }
        throw last;
      } catch (e) {
        setState({ phase: "error", detail: String(e?.message || e).slice(0, 500) });
        throw e;
      } finally {
        loading = null;
      }
    })();
  }
  return loading;
}

async function unload() {
  const r = runtime;
  runtime = null;
  if (r) await r.wllama.exit().catch(() => {});
  setState({ phase: "idle", backend: "" });
}

// ---- translation ----
function clean(s) {
  return s.replace(/<\|plamo:[^|]*\|>/g, "");
}

function prompt(text, target, context) {
  let p = `${TAG}dataset${MSG}translation`;
  if (context && context.trim()) p += `${TAG}context${MSG}${clean(context)}`;
  p += `${TAG}input${MSG}${clean(text)}`;
  p += `${TAG}output${KEY}lang${VAL}${target === "en" ? "en" : "ja"}${MSG}`;
  return p;
}

async function slot(r, task) {
  if (r.active >= r.parallel) await new Promise((res) => r.waiters.push(res));
  r.active++;
  try {
    return await task();
  } finally {
    r.active--;
    r.waiters.shift()?.();
  }
}

async function translate(text, target, context, device) {
  const r = await load(device);
  // Leave room for the prompt inside one slot's context.
  const maxTokens = Math.min(CTX_PER_SLOT - 64 - Math.ceil((text.length + (context || "").length) * 0.6), 64 + text.length * 2);
  return slot(r, async () => {
    let out = "";
    await r.wllama.createCompletion({
      prompt: prompt(text, target, context),
      max_tokens: Math.max(64, maxTokens),
      temperature: 0,
      cache_prompt: r.parallel === 1,
      stop: [TAG, BOS],
      stream: true,
      onData: (chunk) => { out += chunk?.choices?.[0]?.text || ""; },
    });
    for (const m of [TAG, BOS]) { const i = out.indexOf(m); if (i !== -1) out = out.slice(0, i); }
    return out.trim();
  });
}

globalThis.PlamoEngine = { load, unload, translate, get state() { return state; } };

if (inExtension) chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "engine") return;
  const reply = (p) => p.then((v) => sendResponse({ ok: true, ...v }), (e) => sendResponse({ ok: false, error: String(e?.message || e), state }));
  if (msg.cmd === "translate") reply(translate(msg.text, msg.target_lang, msg.context, msg.device).then((text) => ({ text })));
  else if (msg.cmd === "load") reply(load(msg.device).then(() => ({ state })));
  else if (msg.cmd === "unload") reply(unload().then(() => ({ state })));
  else if (msg.cmd === "state") sendResponse({ ok: true, state });
  else return;
  return true;
});
