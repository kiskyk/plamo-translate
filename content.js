// Page translation: puts a translation under each paragraph, only for paragraphs near the viewport.
(() => {
  if (globalThis.__plamoPage) return;

  const HARD_SKIP = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "MATH",
    "CANVAS", "VIDEO", "AUDIO", "IFRAME", "PRE", "PLAMO-TR", "HEAD", "TITLE",
  ]);
  const CHROME_UI = "nav, [role=navigation], [role=menu], [role=menubar], [role=tab], button, [role=button]";
  const MAX_INFLIGHT = 6;

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
  let failed = 0;
  let toastEl = null;
  let scanTimer = null;

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
    text = text.replace(/[ \t\r\f\v\u00a0]+/g, " ").replace(/ *\n+ */g, "\n").trim();
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
    for (const n of fresh) block.insertBefore(n, anchor);
    for (const n of orig) n.remove();
    block.__plamoSwap = { orig, fresh, title: block.getAttribute("title") };
    if (!block.hasAttribute("title")) block.setAttribute("title", block.__plamo.text.slice(0, 600));
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
    if (s.title === null) block.removeAttribute("title");
    block.classList.remove("plamo-replaced");
    delete block.__plamoSwap;
  }

  function pump() {
    while (on && inflight < MAX_INFLIGHT && queue.length) {
      const block = queue.shift();
      const info = block.__plamo;
      if (!info || !block.isConnected) continue;
      inflight++;
      block.classList.add("plamo-loading");
      toast();
      const nodes = mode === "replace" ? ownNodes(block) : null;
      const ser = nodes ? serialize(nodes) : null;
      Plamo.translate(ser ? ser.src : info.text, target, info.context).then(
        (tr) => {
          block.classList.remove("plamo-loading");
          if (!on || !tr || tr === info.text) return;
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
          failed++;
          if (String(e.message) === "SERVER_DOWN") {
            toast("翻訳サーバーに繋がらないよ。ボタンを右クリック →「翻訳サーバーを起動」を試してね", true);
            stop(false);
          }
        },
      ).finally(() => { inflight--; toast(); pump(); });
    }
  }

  function toast(msg, sticky) {
    if (!toastEl) {
      toastEl = document.createElement("plamo-toast");
      document.documentElement.appendChild(toastEl);
    }
    if (msg) {
      toastEl.textContent = msg;
      toastEl.hidden = false;
      if (!sticky) setTimeout(() => { if (toastEl.textContent === msg) toastEl.hidden = true; }, 2500);
      return;
    }
    const busy = inflight + queue.length;
    toastEl.hidden = busy === 0;
    toastEl.textContent = `翻訳中… 残り ${busy}`;
  }

  function start() {
    on = true;
    seen = new WeakSet();
    queue = [];
    done = failed = 0;
    io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).map((e) => e.target);
      vis.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      for (const b of vis) { io.unobserve(b); queue.push(b); }
      pump();
    }, { rootMargin: "800px 0px" });
    mo = new MutationObserver((muts) => {
      if (muts.every((m) => [...m.addedNodes].every((n) => n.nodeName === "PLAMO-TR" || n.nodeName === "PLAMO-TOAST"))) return;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => scan(document.body), 500);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    scan(document.body);
    toast(mode === "replace"
      ? "翻訳を始めたよ。原文はマウスを乗せると出るよ（もう一度押すと元に戻る）"
      : "翻訳を始めたよ（もう一度押すと元に戻る）");
  }

  function stop(removeTranslations = true) {
    on = false;
    io?.disconnect();
    mo?.disconnect();
    clearTimeout(scanTimer);
    queue = [];
    if (removeTranslations) {
      document.querySelectorAll("plamo-tr").forEach((e) => e.remove());
      for (const b of replaced) restore(b);
      replaced = new Set();
      document.querySelectorAll(".plamo-loading").forEach((e) => e.classList.remove("plamo-loading"));
      toast("元に戻したよ");
    }
  }

  async function toggle() {
    if (on) { stop(); return; }
    ({ target, mode } = await Plamo.prefs());
    if (globalThis.chrome?.runtime?.id) {
      toast("翻訳サーバーを確認しているよ…", true);
      const r = await chrome.runtime.sendMessage({ type: "ensure" });
      if (!r?.ok) {
        toast(r?.noHost
          ? "翻訳サーバーを起動できなかったよ。host\\install.ps1 の登録と server\\config.json を確かめてね"
          : "翻訳サーバーを起動できなかったよ。ボタンを右クリック →「翻訳サーバーを起動」を試してね", true);
        return;
      }
    }
    start();
  }

  globalThis.__plamoPage = { toggle, isOn: () => on };
  globalThis.chrome?.runtime?.onMessage?.addListener((msg) => {
    if (msg?.type === "toggle") toggle();
  });
})();
