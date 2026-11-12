import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { blocksFromPage, markFrontMatter, findReferences, markReferences, graphicsBoxes, makeCropper, figureImg, sourceOf, sourceBoxes, nodesFrom, partsNodes } from "./pdftext.js";
import { mathFrom } from "./mathml.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const pagesEl = $("pages");
const inExtension = !!globalThis.chrome?.runtime?.id;
let target = "ja";
let useMathML = true;
let doc = null; // { pdf, name, rows, paraTotal, paraDone, pagesLoaded, failed, meter }
// "print" intent: rendering does not wait for requestAnimationFrame, which never fires in a
// background tab, so pages keep loading while the user is elsewhere.
const INTENT = "print";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- server status ----
function modelLabel(file) {
  const m = /-(\d+(?:\.\d+)?b)-/i.exec(file || "");
  return m ? "PLaMo " + m[1].toUpperCase() : "接続中";
}

// The built-in engine reports its first-run download here (the viewer is an extension page).
let engineLabel = "";
globalThis.chrome?.runtime?.onMessage?.addListener((msg) => {
  if (msg?.type !== "engine-state") return;
  const s = msg.state || {};
  engineLabel = s.phase === "downloading" ? `モデルを取得中 ${s.pct}%` : s.phase === "loading" ? "モデルを読み込み中…" : "";
  if (engineLabel) { $("server").textContent = engineLabel; $("server").className = "server"; }
  else if (s.phase === "ready") checkServer();
});

let checkingStart = 0; // a start takes seconds; polling must not report "stopped" meanwhile
let startError = ""; // why the last start failed; polling has no way to learn it again

// Stopping mid-translation would be undone at once: queued paragraphs auto-start the server again.
function syncStop(up = !$("stopServer").hidden) {
  const button = $("stopServer");
  const busy = !!doc && doc.paraDone < doc.paraTotal;
  button.hidden = !inExtension || !up;
  button.disabled = busy;
  button.title = busy ? "翻訳が終わると止められます" : "翻訳サーバーを止めて VRAM を空けます";
}

async function checkServer(start = false) {
  const el = $("server");
  const button = $("startServer");
  if (start) checkingStart++;
  try {
    let model;
    if (inExtension) {
      if (start) { el.textContent = engineLabel || "サーバーを起動中…"; el.className = "server"; button.hidden = true; $("stopServer").hidden = true; }
      const r = await chrome.runtime.sendMessage({ type: start ? "ensure" : "health" });
      if (!r?.ok) throw Object.assign(new Error(), { noHost: r?.noHost, log: r?.log });
      model = r.model;
    } else {
      const r = await fetch("http://127.0.0.1:11437/props");
      model = String((await r.json()).model_path || "").split(/[\\/]/).pop();
    }
    el.textContent = modelLabel(model);
    el.title = (model || "").replace(/\.gguf$/, "");
    el.className = "server ok";
    button.hidden = true;
    startError = "";
    syncStop(true);
    return true;
  } catch (e) {
    if (start) startError = e.log || "";
    const noModel = /model not found/.test(startError);
    el.textContent = e.noHost ? "中継エラー: " + String(e.log || "不明").slice(0, 70) : noModel ? "モデルのファイルがありません" : "サーバー停止中";
    el.title = e.noHost ? (e.log || "") + "\nhost\\install.ps1 を一度実行してください" : startError || "翻訳サーバーに接続できません";
    el.className = "server ng";
    button.hidden = false;
    syncStop(false);
    return false;
  } finally {
    if (start) checkingStart--;
  }
}
setInterval(() => { if (!document.hidden && !checkingStart) checkServer(); }, 5000);

// ---- messages in place of the pages ----
function notice(title, hint) {
  document.title = "PDF 翻訳ビューア";
  $("name").textContent = "PDF 翻訳ビューア";
  const box = document.createElement("section");
  box.className = "drop notice";
  const t = document.createElement("p");
  t.className = "notice-title";
  t.textContent = title;
  const b = document.createElement("button");
  b.className = "btn primary";
  b.dataset.pick = "";
  b.textContent = "別の PDF を選ぶ";
  const h = document.createElement("p");
  h.className = "hint";
  h.textContent = hint || "";
  box.append(t, b, h);
  pagesEl.replaceChildren(box);
}

function describeLoadError(e) {
  if (e?.name === "PasswordException") return ["パスワード付きの PDF は開けません。", "パスワードを解除した PDF をドロップしてください。"];
  if (e?.name === "InvalidPDFException") return ["PDF として読み込めませんでした。", "ファイルが壊れているか、PDF ではない可能性があります。"];
  return ["PDF を読み込めませんでした。", String(e?.message || e)];
}

// ---- loading ----
async function bytesFromUrl(url) {
  if (url.startsWith("file:")) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("GET", url);
      x.responseType = "arraybuffer";
      x.onload = () => (x.response ? resolve(x.response) : reject(new Error("empty")));
      x.onerror = () => reject(new Error("file"));
      x.send();
    });
  }
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.arrayBuffer();
}

async function openFile(file) {
  try {
    await open(await file.arrayBuffer(), file.name);
  } catch (e) {
    doc = null;
    resetBar();
    notice(...describeLoadError(e));
  }
}

function resetBar() {
  $("export").disabled = true;
  $("pager").hidden = true;
  $("meter").hidden = true;
  $("retry").hidden = true;
  $("progress").textContent = "";
}

let pageWatcher = null;

async function open(data, name) {
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  pagesEl.replaceChildren();
  document.title = name + " - PDF 翻訳ビューア";
  $("name").textContent = name;
  $("name").title = name;
  const total = pdf.numPages;
  const first = await pdf.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  const d = { pdf, name, rows: [], paraTotal: 0, paraDone: 0, pagesLoaded: 0, failed: new Set(), meter: 0, refs: findReferences(pdf).catch(() => null) };
  doc = d;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      ensureLoaded(d, e.target);
    }
  }, { rootMargin: "1200px 0px" });
  pageWatcher?.disconnect();
  pageWatcher = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) showCurrentPage(Number(e.target.dataset.page));
  }, { rootMargin: "-45% 0px -55% 0px" });
  for (let i = 1; i <= total; i++) {
    const row = document.createElement("section");
    row.className = "row";
    row.dataset.page = i;
    row.innerHTML = `<div class="sheet" style="aspect-ratio:${vp.width}/${vp.height}"><div class="marks"></div><span class="no">${i} / ${total}</span></div><div class="tr"></div>`;
    pagesEl.appendChild(row);
    io.observe(row);
    pageWatcher.observe(row);
    d.rows.push(row);
  }
  $("export").disabled = false;
  $("pager").hidden = false;
  $("pageNo").max = total;
  $("pageNo").value = 1;
  $("pageTotal").textContent = "/ " + total;
  $("meter").hidden = false;
  progress();
  const fromHash = /^#page=(\d+)$/.exec(location.hash);
  if (fromHash) goToPage(Number(fromHash[1]));
  prefetch(d);
}

function showCurrentPage(n) {
  if (doc?.pin) return;
  if (document.activeElement !== $("pageNo")) $("pageNo").value = n;
  try { history.replaceState(null, "", location.pathname + location.search + "#page=" + n); } catch {}
}

// Pages above the target grow as they load, so the jump is repeated until they have settled
// (or the user scrolls on their own).
function goToPage(n) {
  const d = doc;
  if (!d) return;
  n = Math.min(d.rows.length, Math.max(1, n));
  const row = d.rows[n - 1];
  window.scrollTo(0, row.getBoundingClientRect().top + scrollY - document.querySelector(".bar").offsetHeight - 12);
  d.pin = d.rows.slice(0, n).every((r) => r._done) ? 0 : n;
  $("pageNo").value = n;
}
for (const type of ["wheel", "keydown", "pointerdown", "touchstart"]) {
  window.addEventListener(type, () => { if (doc) doc.pin = 0; }, { capture: true, passive: true });
}

// Loads a page once (from scrolling or from the background prefetch, whichever comes first).
function ensureLoaded(d, row) {
  if (!row._loading) {
    row._loading = loadPage(d, Number(row.dataset.page), row).catch((err) => {
      const p = document.createElement("p");
      p.className = "err";
      p.textContent = "このページは読み込めませんでした: " + String(err.message || err);
      row.querySelector(".tr").replaceChildren(p);
    }).finally(() => {
      row._done = true;
      d.pagesLoaded++;
      progress();
      if (doc === d && d.pin) goToPage(d.pin);
    });
  }
  return row._loading;
}

// Translates the rest of the document in the background, page by page, without flooding the
// translation queue (pages the user scrolls to still get served first).
async function prefetch(d) {
  for (const row of d.rows) {
    if (doc !== d) return; // another file was opened
    await ensureLoaded(d, row);
    while (doc === d && d.paraTotal - d.paraDone > 8) await sleep(300);
  }
}

function progress() {
  const d = doc;
  if (!d) return;
  const pages = d.rows.length;
  const allLoaded = d.pagesLoaded >= pages;
  const pending = d.paraTotal - d.paraDone;
  const failed = d.failed.size;
  const ok = d.paraDone - failed;
  $("progress").textContent = allLoaded && !pending && !failed
    ? `${pages} ページ・翻訳完了`
    : `${pages} ページ・訳 ${ok} / ${d.paraTotal} 段落`;
  const retry = $("retry");
  retry.hidden = !failed;
  retry.textContent = `失敗した ${failed} 段落をやり直す`;
  const ratio = (d.pagesLoaded / pages) * (d.paraTotal ? d.paraDone / d.paraTotal : 1);
  d.meter = Math.max(d.meter, ratio);
  const meter = $("meter");
  meter.setAttribute("aria-valuenow", Math.round(d.meter * 100));
  meter.firstElementChild.style.transform = `scaleX(${d.meter})`;
  meter.style.opacity = d.meter >= 1 ? 0 : 1;
  syncStop();
}

// One translation job of a paragraph or table. Failed jobs stay in d.failed until retried.
function track(d, div, job) {
  d.paraTotal++;
  const entry = { div, run: null };
  entry.run = () => {
    div.classList.remove("failed");
    div.querySelector(":scope > .retry")?.remove();
    div.classList.add("pending");
    return job().then(
      () => { d.failed.delete(entry); },
      (e) => {
        d.failed.add(entry);
        div.classList.add("failed");
        const b = document.createElement("button");
        b.className = "btn warn retry";
        b.textContent = "訳せませんでした。もう一度試す";
        b.addEventListener("click", (ev) => { ev.stopPropagation(); retry(d, [entry]); });
        div.appendChild(b);
        if (String(e.message) === "SERVER_DOWN") checkServer();
      },
    ).finally(() => { div.classList.remove("pending"); d.paraDone++; progress(); });
  };
  entry.run();
}

function retry(d, entries = [...d.failed]) {
  for (const entry of entries) d.failed.delete(entry);
  d.paraDone -= entries.length;
  d.meter = 0;
  for (const entry of entries) entry.run();
  progress();
}

async function settled(d, btn) {
  while (doc === d && d.paraDone < d.paraTotal) {
    btn.textContent = `訳し終わるのを待っています… ${d.paraDone} / ${d.paraTotal}`;
    await sleep(500);
  }
}

// Shrinks each page's translation until it fits one sheet; below the minimum it may run onto the next sheet.
function fitRows(rows) {
  const MAX_PT = 9;
  const MIN_PT = 6;
  for (const row of rows) {
    const tr = row.querySelector(".tr");
    const avail = row.clientHeight;
    let pt = MAX_PT;
    tr.style.fontSize = pt + "pt";
    while (tr.scrollHeight > avail && pt > MIN_PT) {
      pt -= 0.25;
      tr.style.fontSize = pt + "pt";
    }
    if (tr.scrollHeight > avail) row.classList.add("overflow");
    row.dataset.fit = pt;
  }
}

// ---- bilingual PDF (left: original page, right: translation) via the browser's print to PDF ----
async function exportPdf() {
  const d = doc;
  if (!d) return;
  const btn = $("export");
  btn.disabled = true;
  try {
    for (const row of d.rows) {
      btn.textContent = `ページを準備中… ${row.dataset.page} / ${d.rows.length}`;
      await ensureLoaded(d, row);
    }
    await settled(d, btn);
    if (d.failed.size) {
      retry(d);
      await settled(d, btn);
    }
    if (doc !== d) return;
    if (d.failed.size && !confirm(`${d.failed.size} 段落を訳せませんでした。その部分は原文のまま保存します。続けますか？`)) return;
    // Sharp page images for paper (the on-screen canvas is only as wide as the column).
    for (const row of d.rows) {
      if (row.querySelector(".print-img")) continue;
      btn.textContent = `印刷用の画像を作成中… ${row.dataset.page} / ${d.rows.length}`;
      const page = await d.pdf.getPage(Number(row.dataset.page));
      const vp = page.getViewport({ scale: 2.2 });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
      const img = document.createElement("img");
      img.className = "print-img";
      // wait for load (img.decode() never settles in a background tab)
      await new Promise((resolve) => {
        img.onload = img.onerror = resolve;
        setTimeout(resolve, 5000);
        img.src = c.toDataURL("image/jpeg", 0.88);
      });
      row.querySelector(".sheet").appendChild(img);
    }
    const title = document.title;
    document.title = d.name.replace(/\.pdf$/i, "") + "（対訳）";
    document.body.classList.add("print-layout");
    fitEquations(document);
    fitRows(d.rows);
    btn.textContent = "印刷画面で「PDF に保存」を選んでください";
    window.print(); // blocks until the print dialog is closed
    document.body.classList.remove("print-layout");
    fitEquations(document);
    for (const row of d.rows) {
      row.classList.remove("overflow");
      row.querySelector(".tr").style.fontSize = "";
    }
    document.title = title;
  } finally {
    btn.disabled = false;
    btn.textContent = "対訳 PDF を保存";
  }
}

// ---- link between a paragraph and where it sits on the page ----
function marksOf(boxes, base) {
  return boxes.map((box) => {
    const [ax, ay, bx, by] = base.convertToViewportRectangle(box);
    return {
      l: (Math.min(ax, bx) / base.width) * 100,
      t: (Math.min(ay, by) / base.height) * 100,
      w: (Math.abs(bx - ax) / base.width) * 100,
      h: (Math.abs(by - ay) / base.height) * 100,
    };
  });
}

function drawMarks(row, marks) {
  row.querySelector(".marks").replaceChildren(...marks.map((m) => {
    const el = document.createElement("i");
    el.style.cssText = `left:${m.l}%;top:${m.t}%;width:${m.w}%;height:${m.h}%`;
    return el;
  }));
}

let active = null; // { row, spot }
function setActive(row, spot, fromSheet) {
  if (active?.spot === spot) return;
  if (active) {
    drawMarks(active.row, []);
    active.spot.div.classList.remove("linked");
    active.row.querySelector(".sheet").classList.remove("hit");
  }
  active = spot ? { row, spot } : null;
  if (!spot) return;
  drawMarks(row, spot.marks);
  if (fromSheet) {
    spot.div.classList.add("linked");
    row.querySelector(".sheet").classList.add("hit");
  }
}

function spotAt(row, e) {
  const r = row.querySelector(".sheet").getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 100;
  const y = ((e.clientY - r.top) / r.height) * 100;
  const gap = 0.5; // the space between two lines still counts as the paragraph
  return row._spots?.find((s) => s.marks.some((m) => x >= m.l && x <= m.l + m.w && y >= m.t - gap && y <= m.t + m.h + gap)) || null;
}

pagesEl.addEventListener("mouseover", (e) => {
  if (!e.target.closest?.(".tr")) return;
  const row = e.target.closest(".row");
  const para = e.target.closest(".para");
  setActive(row, para && row._spots?.find((s) => s.div === para) || null, false);
});
pagesEl.addEventListener("mousemove", (e) => {
  const sheet = e.target.closest?.(".sheet");
  if (!sheet) return;
  const row = sheet.closest(".row");
  setActive(row, spotAt(row, e), true);
});
pagesEl.addEventListener("mouseleave", () => setActive(null, null));
pagesEl.addEventListener("click", (e) => {
  const sheet = e.target.closest?.(".sheet");
  if (!sheet) return;
  const row = sheet.closest(".row");
  const spot = spotAt(row, e);
  if (spot) spot.div.scrollIntoView({ block: "nearest" });
});

function toggleOriginal(div) {
  div.addEventListener("click", () => {
    if (String(getSelection())) return; // selecting text to copy is not a click on the paragraph
    div.classList.toggle("open");
  });
}

// ---- one page ----
async function loadPage(d, n, row) {
  if (doc !== d) return;
  const page = await d.pdf.getPage(n);
  const sheet = row.querySelector(".sheet");
  const cssWidth = sheet.clientWidth || 700;
  const base = page.getViewport({ scale: 1 });
  const scale = (cssWidth / base.width) * (window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  sheet.style.aspectRatio = `${base.width}/${base.height}`;
  sheet.prepend(canvas);
  // Render first: font names (used to find math) and the pixels for math crops come from it.
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, intent: INTENT }).promise;

  const gfx = graphicsBoxes(await page.getOperatorList({ intent: INTENT }), pdfjsLib.OPS);
  const blocks = blocksFromPage(page, await page.getTextContent(), gfx);
  if (page.pageNumber === 1) markFrontMatter(blocks);
  markReferences(blocks, n, await d.refs);
  // Math crops come from a sharper render than the page preview (about 216 dpi or more).
  let crop = makeCropper(canvas, vp);
  let pix = { canvas, vp }; // the render math and figure crops are cut from
  const hasMath = blocks.some((b) => b.kind !== "text" || b.parts.some((p) => p.t === "math"));
  if (hasMath && scale < 3) {
    const hvp = page.getViewport({ scale: 3 });
    const hi = document.createElement("canvas");
    hi.width = Math.floor(hvp.width);
    hi.height = Math.floor(hvp.height);
    const hctx = hi.getContext("2d");
    hctx.fillStyle = "#fff";
    hctx.fillRect(0, 0, hi.width, hi.height);
    await page.render({ canvasContext: hctx, viewport: hvp, intent: INTENT }).promise;
    crop = makeCropper(hi, hvp);
    pix = { canvas: hi, vp: hvp };
  }
  // Formulas are shown as MathML when they could be rebuilt; the page crop stays as the fallback
  // and as the original shown when a paragraph is opened.
  const formula = (items, image) => {
    if (!useMathML) return image;
    return mathFrom(items, gfx.rules, false).math || image;
  };
  const tr = row.querySelector(".tr");
  if (!blocks.length) tr.innerHTML = `<p class="empty">文字が見つからないページです（画像だけのページかもしれません）。</p>`;
  row._spots = [];
  const link = (div, boxes) => row._spots.push({ div, marks: marksOf(boxes, base) });
  let prevText = "";
  const figRows = figureRows(blocks.filter((b) => b.kind === "figure"));
  for (const b of blocks) {
    if (b.kind === "figure" && !figRows.has(b)) continue; // drawn with the first figure of its row
    if (b.front && /^[\d∗*†‡,\s]*$/.test(b.text)) continue; // affiliation marks left alone on a line
    const div = document.createElement("div");
    div.className = "para";
    tr.appendChild(div);
    if (b.kind === "table") {
      link(div, sourceBoxes(b));
      renderTable(d, b, div, crop, prevText, formula);
      continue;
    }
    if (b.kind === "figure") {
      link(div, figRows.get(b).map((f) => f.box));
      renderFigures(figRows.get(b), div, pix, base.width);
      continue;
    }
    link(div, sourceBoxes(b));
    if (b.kind === "text") prevText = b.text;
    if (b.kind === "eq") {
      div.classList.add("eq");
      const image = crop(b.items, b.h);
      const built = useMathML ? mathFrom(b.items, gfx.rules, true) : {};
      if (!built.math) { div.appendChild(image); continue; }
      const line = document.createElement("div");
      line.className = "eqline";
      line.appendChild(built.math);
      if (built.tag) {
        const no = document.createElement("span");
        no.className = "eqno";
        no.textContent = built.tag;
        line.appendChild(no);
      }
      const orig = document.createElement("div");
      orig.className = "orig";
      orig.appendChild(image);
      div.classList.add("built");
      div.append(line, orig);
      toggleOriginal(div);
      continue;
    }
    const { src, maths, plain } = sourceOf(b);
    const imgs = maths.map((m) => crop(m.items, b.h));
    const ja = document.createElement("div");
    ja.className = "ja";
    const orig = document.createElement("div");
    orig.className = "orig";
    orig.append(...partsNodes(b.parts, imgs));
    div.append(ja, orig);
    toggleOriginal(div);
    const shown = maths.map((m, i) => formula(m.items, imgs[i]));
    if (b.front) {
      ja.textContent = b.lines.map((ln) => ln.text).join("\n");
      div.classList.add("keep", "front");
      continue;
    }
    ja.append(...partsNodes(b.parts, shown));
    if (b.keep || !Plamo.shouldTranslate(plain, target)) {
      div.classList.add("keep");
      continue;
    }
    track(d, div, () => Plamo.translate(src, target).then((t) => { ja.replaceChildren(...nodesFrom(t, shown)); }));
  }
  fitEquations(row);
  progress();
}

// A display wider than the column is drawn smaller, so that it stays readable without scrolling.
function fitEquations(root) {
  for (const line of root.querySelectorAll(".eqline")) {
    const math = line.querySelector("math");
    math.style.fontSize = "";
    const room = line.clientWidth - (line.querySelector(".eqno")?.offsetWidth || 0) - 8;
    const need = math.firstElementChild?.getBoundingClientRect().width || 0;
    if (need > room && room > 0) math.style.fontSize = Math.max(55, Math.floor((room / need) * 100)) + "%";
  }
}

// Figures that sit side by side on the page (sub-figures, figures in both columns) form one row.
// Returns Map(first figure of a row -> all figures of that row).
function figureRows(figs) {
  const rows = [];
  for (const f of figs) {
    const [, y0, , y1] = f.box;
    const row = rows.find((r) => r.some((g) => {
      if (g.col !== f.col) return false; // figures in the left and right column are read apart
      const overlap = Math.min(y1, g.box[3]) - Math.max(y0, g.box[1]);
      return overlap > 0.5 * Math.min(y1 - y0, g.box[3] - g.box[1]);
    }));
    if (row) row.push(f);
    else rows.push([f]);
  }
  return new Map(rows.map((r) => [r[0], r]));
}

// Draws figures at the scale of the original page (the translation column is as wide as the page
// preview) and in their original left/right/up/down arrangement.
function renderFigures(figs, div, pix, pageW) {
  const pad = 6;
  const boxes = figs.map((f) => [f.box[0] - pad, f.box[1] - pad, f.box[2] + pad, f.box[3] + pad]);
  const ux0 = Math.min(...boxes.map((b) => b[0]));
  const uy0 = Math.min(...boxes.map((b) => b[1]));
  const ux1 = Math.max(...boxes.map((b) => b[2]));
  const uy1 = Math.max(...boxes.map((b) => b[3]));
  const uw = ux1 - ux0;
  const uh = uy1 - uy0;
  div.classList.add("fig");
  const frame = document.createElement("div");
  frame.className = "figbox";
  frame.style.width = Math.min(100, (uw / pageW) * 100).toFixed(2) + "%";
  frame.style.aspectRatio = `${uw} / ${uh}`;
  for (const b of boxes) {
    const img = figureImg(pix.canvas, pix.vp, b);
    img.style.left = (((b[0] - ux0) / uw) * 100).toFixed(2) + "%";
    img.style.top = (((uy1 - b[3]) / uh) * 100).toFixed(2) + "%";
    img.style.width = (((b[2] - b[0]) / uw) * 100).toFixed(2) + "%";
    frame.appendChild(img);
  }
  div.appendChild(frame);
}

// Table: rebuilt as an HTML table. All translatable cells go to the model in one request
// (<tN> per cell) so short cells are translated with the caption and their neighbours as context.
function renderTable(d, b, div, crop, caption, formula) {
  div.classList.add("table");
  const table = document.createElement("table");
  table.className = "ptable";
  const cells = [];
  b.rows.forEach((row, ri) => {
    const tr = table.insertRow();
    for (const cell of row) {
      const td = document.createElement(ri === 0 ? "th" : "td");
      tr.appendChild(td);
      if (!cell) continue;
      const imgs = cell.parts.filter((p) => p.t === "math").map((m) => formula(m.items, crop(m.items, b.h)));
      td.append(...partsNodes(cell.parts, imgs));
      if (!b.keep && cell.parts.every((p) => p.t === "text") && Plamo.shouldTranslate(cell.text, target)) {
        cells.push({ td, text: cell.text });
      }
    }
  });
  const orig = document.createElement("div");
  orig.className = "orig";
  orig.appendChild(crop(b.items, b.h));
  const wrap = document.createElement("div");
  wrap.className = "ja";
  wrap.appendChild(table);
  div.append(wrap, orig);
  toggleOriginal(div);
  if (!cells.length) return;
  const src = cells.map((c, k) => `<t${k + 1}>${c.text.replace(/[<>]/g, "")}</t${k + 1}>`).join("\n");
  const context = caption.slice(0, 400);
  track(d, div, () => Plamo.translate(src, target, context).then((t) => {
    const re = /<t(\d+)>([\s\S]*?)<\/t\1>/g;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const c = cells[Number(m[1]) - 1];
      if (c && m[2].trim()) c.td.textContent = m[2].trim();
    }
  }));
}

// ---- reading comfort ----
const SIZE_KEY = "plamo.translationSize";
const SIZE_MIN = 13;
const SIZE_MAX = 22;
let trSize = 15;

function applySize() {
  document.documentElement.style.setProperty("--tr-size", trSize + "px");
  $("fontDown").disabled = trSize <= SIZE_MIN;
  $("fontUp").disabled = trSize >= SIZE_MAX;
  fitEquations(document);
}

function changeSize(delta) {
  trSize = Math.min(SIZE_MAX, Math.max(SIZE_MIN, trSize + delta));
  applySize();
  try { localStorage.setItem(SIZE_KEY, String(trSize)); } catch {}
}

try {
  const saved = Number(localStorage.getItem(SIZE_KEY));
  if (saved >= SIZE_MIN && saved <= SIZE_MAX) trSize = saved;
} catch {}
applySize();

// ---- wiring ----
let refit = null;
window.addEventListener("resize", () => {
  clearTimeout(refit);
  refit = setTimeout(() => fitEquations(document), 200);
});
$("fontDown").addEventListener("click", () => changeSize(-1));
$("fontUp").addEventListener("click", () => changeSize(1));
$("showOrig").addEventListener("change", (e) => document.body.classList.toggle("show-orig", e.target.checked));
$("export").addEventListener("click", () => exportPdf().catch((e) => alert("書き出せませんでした: " + (e.message || e))));
$("retry").addEventListener("click", () => { if (doc) retry(doc); });
$("startServer").addEventListener("click", async (e) => {
  e.target.disabled = true;
  const ok = await checkServer(true);
  e.target.disabled = false;
  if (ok && doc?.failed.size) retry(doc);
});
$("stopServer").addEventListener("click", async (e) => {
  const el = $("server");
  e.target.disabled = true;
  el.textContent = "サーバーを停止中…";
  el.className = "server";
  checkingStart++;
  const r = await chrome.runtime.sendMessage({ type: "stop" }).catch((err) => ({ log: String(err.message || err) }));
  checkingStart--;
  if (r?.ok && !r.up) { checkServer(); return; }
  // No reply at all: the page was reloaded from disk but the extension's background is still the old one.
  const why = r ? r.log || "不明" : "拡張機能を再読み込みしてください";
  el.textContent = "停止できませんでした: " + String(why).slice(0, 70);
  el.title = why;
  el.className = "server ng";
  e.target.disabled = false;
});
$("pageNo").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { goToPage(Number(e.target.value)); e.target.blur(); }
});
$("pageNo").addEventListener("change", (e) => goToPage(Number(e.target.value)));
document.addEventListener("click", (e) => {
  if (e.target.closest?.("[data-pick]")) $("pick").click();
});
$("pick").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = ""; // choosing the same file again must fire change
  if (f) openFile(f);
});

let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const f = [...e.dataTransfer.files].find((x) => x.type === "application/pdf" || /\.pdf$/i.test(x.name));
  if (f) openFile(f);
  else if (e.dataTransfer.files.length) {
    if (doc) $("progress").textContent = "開けるのは PDF だけです";
    else notice("開けるのは PDF だけです。", e.dataTransfer.files[0].name);
  }
});

(async () => {
  const prefs = await Plamo.prefs();
  target = prefs.target;
  useMathML = prefs.math !== "image";
  checkServer(true);
  const file = new URLSearchParams(location.search).get("file");
  if (!file) return;
  const name = decodeURIComponent(file.split(/[?#]/)[0].split("/").pop() || "document.pdf");
  $("name").textContent = name + " を読み込み中…";
  try {
    await open(await bytesFromUrl(file), name);
  } catch (e) {
    doc = null;
    resetBar();
    if (file.startsWith("file:")) notice("ローカルの PDF を読み込めませんでした。", "拡張機能の詳細で「ファイルの URL へのアクセスを許可する」をオンにするか、ここにドロップしてください。");
    else if (/^HTTP |fetch/i.test(String(e.message))) notice("PDF を取得できませんでした。", "ダウンロードしてここにドロップしてください（" + String(e.message) + "）");
    else notice(...describeLoadError(e));
  }
})();
