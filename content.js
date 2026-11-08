// Page translation: puts a translation under each paragraph, only for paragraphs near the viewport.
(() => {
  if (globalThis.__plamoPage) return;

  const HARD_SKIP = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "MATH",
    "CANVAS", "VIDEO", "AUDIO", "IFRAME", "PRE", "PLAMO-TR", "PLAMO-UI", "HEAD", "TITLE",
  ]);
  const CHROME_UI = "nav, [role=navigation], [role=menu], [role=menubar], [role=tab], button, [role=button]";
  const MAX_INFLIGHT = 6;
  const inExtension = !!globalThis.chrome?.runtime?.id;

  let on = false;
  let target = "ja";
  let mode = "replace";
  let replaced = new Set();
  let io = null;
  let mo = null;
  let seen = new WeakSet();
  let queue = [];
  let inflight = 0;
  let done = 0;
  let failed = [];
  let paused = false; // server is down: queue is kept until the user resumes
  let generation = 0; // results of an earlier run must not be applied after a restart
  let scanTimer = null;
  let added = new Set();
  const ours = new WeakSet(); // nodes this script put into the page

  const displayCache = new WeakMap();
  function isBlock(el) {
    let d = displayCache.get(el);
    if (d === undefined) { d = getComputedStyle(el).display; displayCache.set(el, d); }
    return !(d.startsWith("inline") || d === "contents" || d === "ruby" || d === "ruby-text");
  }

  function skipped(el) {
    return HARD_SKIP.has(el.tagName) || el.isContentEditable || el.getAttribute("translate") === "no"
      || el.classList.contains("notranslate");
  }

  // Nearest block-level ancestor of a text node, or null if it sits in something we never translate.
  function blockOf(textNode) {
    let el = textNode.parentElement;
    let block = null;
    while (el && el !== document.documentElement) {
      if (skipped(el)) return null;
      if (!block && isBlock(el)) block = el;
      el = el.parentElement;
    }
    return block;
  }

  // Text that belongs to this block itself (not to nested blocks), and the last node of it.
  function ownText(block) {
    let text = "";
    let last = null;
    const w = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (n === block) return NodeFilter.FILTER_SKIP;
          if (skipped(n) || isBlock(n)) return NodeFilter.FILTER_REJECT;
          if (n.tagName === "BR") return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 1) { text += "\n"; continue; }
      if (n.nodeValue.trim()) last = n;
      text += n.nodeValue;
    }
    text = text.replace(/[ \t\r\f\v ]+/g, " ").replace(/ *\n+ */g, "\n").trim();
    return { text, last };
  }

  // Short strings are ambiguous on their own; give the model the page title and the surrounding list/table.
  function contextOf(block) {
    const box = block.closest("table, ul, ol, dl, section, article, form") || block.parentElement;
    const around = (box?.innerText || "").replace(/\s+/g, " ").slice(0, 500);
    return (document.title + "\n" + around).trim();
  }

  function candidate(block) {
    if (seen.has(block)) return;
    seen.add(block);
    if (!block.getClientRects().length) return; // hidden
    const { text, last } = ownText(block);
    if (!last || !Plamo.shouldTranslate(text, target)) return;
    if (text.length < 40 && block.closest(CHROME_UI)) return;
    block.__plamo = { text, last, context: text.length < 80 ? contextOf(block) : "" };
    io.observe(block);
  }

  function scan(root) {
    if (!on || !root) return;
    if (root.nodeType === 3) root = root.parentElement;
    if (!root) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const b = blockOf(n);
      if (b) candidate(b);
    }
  }

  function insertPoint(block, last) {
    let n = last;
    while (n.parentNode && n.parentNode !== block) n = n.parentNode;
    return n.nextSibling;
  }

  // ---- replace mode: swap the block's own inline content, keeping links/bold as <tN> markers ----
  function ownNodes(block) {
    return [...block.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !skipped(n) && !isBlock(n)));
  }

  function serialize(nodes) {
    const els = [];
    let s = "";
    for (const n of nodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.tagName === "BR") s += "\n";
      else if (n.textContent.trim()) {
        els.push(n);
        s += `<t${els.length}>${n.textContent}</t${els.length}>`;
      }
    }
    return { src: s.replace(/[ \t\r\f\v ]+/g, " ").replace(/ *\n+ */g, "\n").trim(), els };
  }

  // Shallow copy of an inline element; follows single-child wrappers (<span><a>..</a></span>).
  function shell(el) {
    const root = el.cloneNode(false);
    let leaf = root;
    let src = el;
    while (src.children.length === 1 && src.childNodes.length === 1) {
      src = src.children[0];
      const c = src.cloneNode(false);
      leaf.appendChild(c);
      leaf = c;
    }
    return { root, leaf };
  }

  function build(out, els) {
    const frag = [];
    const addText = (t) => {
      t = t.replace(/<\/?t\d+>/g, "");
      t.split("\n").forEach((part, i) => {
        if (i) frag.push(document.createElement("br"));
        if (part) frag.push(document.createTextNode(part));
      });
    };
    const re = /<t(\d+)>([\s\S]*?)<\/t\1>/g;
    let last = 0;
    for (let m = re.exec(out); m; m = re.exec(out)) {
      addText(out.slice(last, m.index));
      const e = els[Number(m[1]) - 1];
      if (e) {
        const { root, leaf } = shell(e);
        leaf.textContent = m[2];
        frag.push(root);
      } else addText(m[2]);
      last = re.lastIndex;
    }
    addText(out.slice(last));
    return frag;
  }

  function applyReplace(block, orig, out, els) {
    if (!orig.every((n) => n.parentNode === block)) return false; // page changed meanwhile
    const fresh = build(out, els);
    const anchor = orig[0];
    for (const n of fresh) { ours.add(n); block.insertBefore(n, anchor); }
    for (const n of orig) n.remove();
    block.__plamoSwap = { orig, fresh };
    block.classList.add("plamo-replaced");
    replaced.add(block);
    return true;
  }

  function restore(block) {
    const s = block.__plamoSwap;
    if (!s) return;
    const anchor = s.fresh.find((n) => n.parentNode === block);
    for (const n of s.orig) block.insertBefore(n, anchor || null);
    for (const n of s.fresh) n.remove();
    block.classList.remove("plamo-replaced");
    delete block.__plamoSwap;
  }

  function pump() {
    while (on && !paused && inflight < MAX_INFLIGHT && queue.length) {
      const block = queue.shift();
      const info = block.__plamo;
      if (!info || !block.isConnected) continue;
      inflight++;
      block.classList.add("plamo-loading");
      paint();
      const nodes = mode === "replace" ? ownNodes(block) : null;
      const ser = nodes ? serialize(nodes) : null;
      const run = generation;
      Plamo.translate(ser ? ser.src : info.text, target, info.context).then(
        (tr) => {
          block.classList.remove("plamo-loading");
          if (!on || run !== generation || !tr || tr === info.text) return;
          if (ser) {
            if (applyReplace(block, nodes, tr, ser.els)) done++;
            return;
          }
          const el = document.createElement("plamo-tr");
          el.setAttribute("lang", target);
          el.textContent = tr;
          block.insertBefore(el, insertPoint(block, info.last));
          done++;
        },
        (e) => {
          block.classList.remove("plamo-loading");
          if (!on || run !== generation) return;
          failed.push(block);
          if (String(e.message) === "SERVER_DOWN" && !paused) {
            paused = true;
            say("翻訳サーバーに接続できません", true);
          }
        },
      ).finally(() => { inflight--; paint(); pump(); });
    }
    paint();
  }

  // ---- on-page UI (in a shadow root, so the page's CSS cannot reach it) ----
  const UI_CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .panel, .tip, .sel {
      position: fixed; z-index: 2147483647; box-sizing: border-box;
      background: #1f2a24; color: #e8f3ec; border: 1px solid #3c4d43; border-radius: 8px;
      font: 13px/1.6 "BIZ UDPGothic", "Yu Gothic UI", "Meiryo", sans-serif;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    }
    .panel { right: 16px; bottom: 16px; width: 320px; max-width: calc(100vw - 32px); padding: 8px 8px 8px 12px; }
    .panel.compact { width: auto; }
    .head { display: flex; align-items: center; gap: 8px; }
    .msg {
      flex: 1; min-width: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit;
      text-align: left; cursor: default; font-variant-numeric: tabular-nums;
    }
    .compact .msg { cursor: pointer; }
    button.icon { flex: none; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; }
    button.icon svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2; fill: none; }
    .btn, button.icon {
      border: 1px solid #4b5f54; border-radius: 6px; background: transparent; color: inherit;
      font: inherit; cursor: pointer;
    }
    .btn { min-height: 30px; padding: 2px 10px; white-space: nowrap; }
    .btn:hover, button.icon:hover { background: #2f3f36; }
    .btn.go { border-color: #7fd8ae; color: #a9e8c9; }
    :focus-visible { outline: 2px solid #7fd8ae; outline-offset: 1px; }
    .meter { height: 3px; margin: 6px 4px 2px 0; background: #36463d; border-radius: 2px; overflow: hidden; }
    .meter i { display: block; height: 100%; background: #62cf9f; transform-origin: left; transition: transform .2s ease-out; }
    .acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding-right: 4px; }
    .compact .acts, .compact .meter { display: none; }
    .compact:hover .acts, .compact:focus-within .acts { display: flex; }
    .tip { max-width: min(560px, calc(100vw - 24px)); max-height: 40vh; overflow: auto; padding: 8px 12px; white-space: pre-line; }
    .sel { width: min(460px, calc(100vw - 24px)); padding: 10px 12px; }
    .sel .text { max-height: 40vh; overflow: auto; font-size: 14px; white-space: pre-line; user-select: text; }
    .sel .acts { justify-content: flex-end; padding-right: 0; }
    @media (prefers-reduced-motion: reduce) { .meter i { transition: none; } }
  `;
  const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  let ui = null;
  function ensureUi() {
    if (ui) return ui;
    const host = document.createElement("plamo-ui");
    const root = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(UI_CSS); // a <style> element would be blocked by strict page CSPs
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = `
      <div class="panel" id="panel" hidden>
        <div class="head">
          <button class="msg" id="msg"></button>
          <button class="icon" id="close" aria-label="このパネルを閉じる">${CLOSE_ICON}</button>
        </div>
        <div class="meter" id="meter" hidden><i id="fill"></i></div>
        <div class="acts" id="acts">
          <button class="btn go" id="retry" hidden></button>
          <button class="btn" id="swap"></button>
          <button class="btn" id="undo">元に戻す</button>
        </div>
      </div>
      <div class="tip" id="tip" lang="en" hidden></div>
      <div class="sel" id="sel" role="dialog" aria-label="選択範囲の翻訳" hidden>
        <div class="text" id="selText" aria-live="polite"></div>
        <div class="acts">
          <button class="btn" id="selCopy" hidden>コピー</button>
          <button class="btn" id="selClose">閉じる</button>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    const el = (id) => root.getElementById(id);
    ui = { host, panel: el("panel"), msg: el("msg"), close: el("close"), meter: el("meter"), fill: el("fill"), acts: el("acts"), retry: el("retry"), swap: el("swap"), undo: el("undo"), tip: el("tip"), sel: el("sel"), selText: el("selText"), selCopy: el("selCopy"), selClose: el("selClose") };
    ui.close.addEventListener("click", () => { dismissed = true; say(null); paint(); });
    ui.undo.addEventListener("click", () => stop());
    ui.swap.addEventListener("click", () => setMode(mode === "replace" ? "dual" : "replace"));
    ui.retry.addEventListener("click", resume);
    ui.msg.addEventListener("click", () => { if (compact) { compact = false; paint(); } });
    ui.selClose.addEventListener("click", closeSelection);
    ui.selCopy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(ui.selText.textContent);
        ui.selCopy.textContent = "コピーしました";
      } catch {
        ui.selCopy.textContent = "コピーできませんでした";
      }
    });
    return ui;
  }

  let note = null;
  let noteTimer = null;
  let dismissed = false;
  let compact = false;
  let compactTimer = null;

  function say(msg, sticky) {
    clearTimeout(noteTimer);
    note = msg;
    if (msg) {
      dismissed = false;
      if (!sticky) noteTimer = setTimeout(() => { note = null; paint(); }, 3500);
    }
    paint();
  }

  function paint() {
    if (!ui && !note && !on) return;
    ensureUi();
    const busy = inflight + (paused ? 0 : queue.length);
    const visible = !dismissed && (note || on);
    ui.panel.hidden = !visible;
    if (!visible) return;

    ui.msg.textContent = note || (busy ? `翻訳中 残り ${busy} 段落` : `翻訳済み ${done} 段落`);
    ui.msg.setAttribute("aria-live", note ? "polite" : "off");
    ui.meter.hidden = !busy;
    ui.fill.style.transform = `scaleX(${done / Math.max(1, done + busy)})`;
    ui.acts.hidden = !on;
    ui.retry.hidden = !failed.length;
    ui.retry.textContent = paused ? "サーバーを起動して再開" : `失敗した ${failed.length} 段落をやり直す`;
    ui.swap.textContent = mode === "replace" ? "原文と併記" : "訳文に置き換え";

    // Once finished, shrink so the panel stays out of the way of the page.
    const settled = on && !busy && !note && !failed.length;
    if (!settled) { compact = false; clearTimeout(compactTimer); compactTimer = null; }
    else if (!compact && !compactTimer) {
      compactTimer = setTimeout(() => {
        compactTimer = null;
        if (ui.panel.matches(":hover, :focus-within")) { paint(); return; }
        compact = true;
        paint();
      }, 4000);
    }
    ui.panel.classList.toggle("compact", compact);
  }

  // ---- original text on hover (replace mode) ----
  let tipBlock = null;
  let tipWanted = null;
  let tipShow = null;
  let tipHide = null;

  function placeNear(el, rect, gap = 8) {
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(12, rect.left), vw - w - 12);
    let top = rect.top - h - gap;
    if (top < 12) top = rect.bottom + gap;
    if (top + h > vh - 12) top = Math.max(12, vh - h - 12);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  function hideTip() {
    clearTimeout(tipShow);
    clearTimeout(tipHide);
    tipBlock = null;
    tipWanted = null;
    if (ui) ui.tip.hidden = true;
  }

  function onTipKey(e) { if (e.key === "Escape") hideTip(); }

  function onHover(e) {
    if (e.target === ui?.host) { clearTimeout(tipHide); return; } // the pointer moved onto the tip itself
    const b = e.target.closest?.(".plamo-replaced") || null;
    if (b && (b === tipBlock || b === tipWanted)) { clearTimeout(tipHide); return; }
    if (!b && !tipBlock && !tipWanted) return;
    clearTimeout(tipShow);
    tipWanted = b;
    if (!b) {
      clearTimeout(tipHide);
      tipHide = setTimeout(hideTip, 200);
      return;
    }
    tipShow = setTimeout(() => {
      if (!b.isConnected || !b.__plamo) return;
      clearTimeout(tipHide);
      tipBlock = b;
      tipWanted = null;
      ensureUi();
      ui.tip.textContent = b.__plamo.text;
      ui.tip.hidden = false;
      placeNear(ui.tip, b.getBoundingClientRect());
    }, 350);
  }

  // ---- translation of the selected text ----
  function closeSelection() {
    if (!ui) return;
    ui.sel.hidden = true;
    document.removeEventListener("keydown", onSelectionKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
  }
  function onSelectionKey(e) { if (e.key === "Escape") closeSelection(); }
  function onOutside(e) { if (e.target !== ui.host) closeSelection(); }

  async function translateSelection(given) {
    const selection = getSelection();
    const text = (given || String(selection)).trim();
    if (!text) { say("文字を選択してから実行してください"); return; }
    ensureUi();
    const range = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    const rect = range?.width ? range : { left: innerWidth / 2 - 230, top: innerHeight / 3, bottom: innerHeight / 3 };
    ui.selText.textContent = "翻訳しています…";
    ui.selCopy.hidden = true;
    ui.sel.hidden = false;
    placeNear(ui.sel, rect);
    document.addEventListener("keydown", onSelectionKey, true);
    document.addEventListener("pointerdown", onOutside, true);
    try {
      if (!(await ensureServer())) throw new Error("SERVER_DOWN");
      const to = Plamo.isJapanese(text) ? "en" : "ja";
      const parts = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const out = await Promise.all(parts.map((s) => Plamo.translate(s, to)));
      ui.selText.textContent = out.join("\n");
      ui.selCopy.textContent = "コピー";
      ui.selCopy.hidden = false;
    } catch (e) {
      ui.selText.textContent = String(e.message) === "SERVER_DOWN"
        ? "翻訳サーバーに接続できませんでした。ボタンの右クリックメニューから起動してください。"
        : "翻訳できませんでした: " + String(e.message || e);
    }
    placeNear(ui.sel, rect);
  }

  // ---- start / stop ----
  async function ensureServer() {
    if (!inExtension) return true;
    const r = await chrome.runtime.sendMessage({ type: "ensure" });
    if (r?.ok) return true;
    say(r?.noHost
      ? "サーバーを起動できません。host\\install.ps1 での登録と server\\config.json を確認してください"
      : "サーバーを起動できません。ボタンの右クリックメニューから起動してください", true);
    return false;
  }

  async function resume() {
    if (paused) {
      say("翻訳サーバーを起動しています…", true);
      if (!(await ensureServer())) return;
      paused = false;
    }
    say(null);
    queue.unshift(...failed);
    failed = [];
    pump();
  }

  function report() {
    if (inExtension) chrome.runtime.sendMessage({ type: "page-state", on }).catch(() => {});
  }

  function start() {
    on = true;
    generation++;
    seen = new WeakSet();
    queue = [];
    failed = [];
    paused = false;
    done = 0;
    dismissed = false;
    compact = false;
    io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).map((e) => e.target);
      vis.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      for (const b of vis) { io.unobserve(b); queue.push(b); }
      pump();
    }, { rootMargin: "800px 0px" });
    mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeName !== "PLAMO-TR" && !ours.has(n)) added.add(n);
      }
      if (!added.size) return;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        const nodes = added;
        added = new Set();
        for (const n of nodes) if (n.isConnected) scan(n);
      }, 500);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    scan(document.body);
    if (mode === "replace") {
      document.addEventListener("mousemove", onHover, { capture: true, passive: true });
      document.addEventListener("scroll", hideTip, true);
      document.addEventListener("keydown", onTipKey, true);
    }
    report();
    say(mode === "replace" ? "翻訳を開始しました。カーソルを乗せると原文を表示します" : "翻訳を開始しました");
  }

  function stop(quiet) {
    on = false;
    generation++;
    io?.disconnect();
    mo?.disconnect();
    clearTimeout(scanTimer);
    added = new Set();
    queue = [];
    failed = [];
    paused = false;
    document.removeEventListener("mousemove", onHover, { capture: true });
    document.removeEventListener("scroll", hideTip, true);
    document.removeEventListener("keydown", onTipKey, true);
    hideTip();
    document.querySelectorAll("plamo-tr").forEach((e) => e.remove());
    for (const b of replaced) restore(b);
    replaced = new Set();
    document.querySelectorAll(".plamo-loading").forEach((e) => e.classList.remove("plamo-loading"));
    if (!quiet) {
      report();
      say("元に戻しました");
    }
  }

  function setMode(next) {
    stop(true);
    mode = next;
    if (inExtension) chrome.storage.sync.set({ mode: next });
    start();
  }

  async function toggle() {
    if (on) { stop(); return; }
    ({ target, mode } = await Plamo.prefs());
    if (inExtension) {
      say("翻訳サーバーを確認しています…", true);
      if (!(await ensureServer())) return;
    }
    start();
  }

  globalThis.__plamoPage = { toggle, translateSelection, isOn: () => on };
  globalThis.chrome?.runtime?.onMessage?.addListener((msg) => {
    if (msg?.type === "toggle") toggle();
    if (msg?.type === "translate-selection") translateSelection(msg.text);
  });
})();
