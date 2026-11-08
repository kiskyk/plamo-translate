import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { blocksFromPage, graphicsBoxes, makeCropper, figureImg, sourceOf, nodesFrom, partsNodes } from "./pdftext.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

const $ = (id) => document.getElementById(id);
const pagesEl = $("pages");
let target = "ja";
let total = 0;
let paraTotal = 0;
let paraDone = 0;
let doc = null; // { pdf, name, rows }
// "print" intent: rendering does not wait for requestAnimationFrame, which never fires in a
// background tab, so pages keep loading while the user is elsewhere.
const INTENT = "print";

// ---- server status ----
async function checkServer(start = false) {
  const el = $("server");
  try {
    let model;
    if (globalThis.chrome?.runtime?.id) {
      if (start) { el.textContent = "翻訳サーバーを起動中…"; el.className = "server"; }
      const r = await chrome.runtime.sendMessage({ type: start ? "ensure" : "health" });
      if (!r?.ok) throw new Error();
      model = r.model;
    } else {
      const r = await fetch("http://127.0.0.1:11437/props");
      model = String((await r.json()).model_path || "").split(/[\\/]/).pop();
    }
    el.textContent = (model || "接続中").replace(/\.gguf$/, "");
    el.className = "server ok";
  } catch {
    el.textContent = "サーバー未起動（ボタンを右クリック →「翻訳サーバーを起動」）";
    el.className = "server ng";
  }
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

async function open(data, name) {
  pagesEl.innerHTML = "";
  document.title = name + " - PDF 翻訳ビューア";
  $("name").textContent = name;
  paraTotal = paraDone = 0;
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  total = pdf.numPages;
  const first = await pdf.getPage(1);
  const vp = first.getViewport({ scale: 1 });
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      ensureLoaded(e.target);
    }
  }, { rootMargin: "1200px 0px" });
  const rows = [];
  for (let i = 1; i <= total; i++) {
    const row = document.createElement("section");
    row.className = "row";
    row.dataset.page = i;
    row.innerHTML = `<div class="sheet" style="aspect-ratio:${vp.width}/${vp.height}"><span class="no">${i} / ${total}</span></div><div class="tr"></div>`;
    pagesEl.appendChild(row);
    io.observe(row);
    rows.push(row);
  }
  doc = { pdf, name, rows };
  $("export").disabled = false;
  progress();
  prefetch(doc);
}

// Loads a page once (from scrolling or from the background prefetch, whichever comes first).
function ensureLoaded(row) {
  if (!row._loading) {
    row._loading = loadPage(doc.pdf, Number(row.dataset.page), row).catch((err) => {
      row.querySelector(".tr").innerHTML = `<p class="err">このページは読めなかったよ: ${String(err.message || err)}</p>`;
    });
  }
  return row._loading;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Translates the rest of the document in the background, page by page, without flooding the
// translation queue (pages the user scrolls to still get served first).
async function prefetch(d) {
  for (const row of d.rows) {
    if (doc !== d) return; // another file was opened
    await ensureLoaded(row);
    while (doc === d && paraTotal - paraDone > 8) await sleep(300);
  }
}

function progress() {
  $("progress").textContent = total ? `${total} ページ・訳 ${paraDone} / ${paraTotal} 段落` : "";
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
      await ensureLoaded(row);
    }
    while (paraDone < paraTotal) {
      btn.textContent = `訳し終わるのを待っているよ… ${paraDone} / ${paraTotal}`;
      await sleep(500);
    }
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
    fitRows(d.rows);
    btn.textContent = "印刷画面で「PDF に保存」を選んでね";
    window.print(); // blocks until the print dialog is closed
    document.body.classList.remove("print-layout");
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

// ---- one page ----
async function loadPage(pdf, n, row) {
  const page = await pdf.getPage(n);
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
  const tr = row.querySelector(".tr");
  if (!blocks.length) tr.innerHTML = `<p class="empty">文字が見つからないページだよ（画像だけのページかも）。</p>`;
  let prevText = "";
  const figRows = figureRows(blocks.filter((b) => b.kind === "figure"));
  for (const b of blocks) {
    if (b.kind === "figure" && !figRows.has(b)) continue; // drawn with the first figure of its row
    const div = document.createElement("div");
    div.className = "para";
    tr.appendChild(div);
    if (b.kind === "table") {
      renderTable(b, div, crop, prevText);
      continue;
    }
    if (b.kind === "figure") {
      renderFigures(figRows.get(b), div, pix, base.width);
      continue;
    }
    if (b.kind === "text") prevText = b.text;
    if (b.kind === "eq") {
      div.classList.add("eq");
      div.appendChild(crop(b.items, b.h));
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
    div.addEventListener("click", () => div.classList.toggle("open"));
    ja.append(...partsNodes(b.parts, imgs));
    if (!Plamo.shouldTranslate(plain, target)) {
      div.classList.add("keep");
      continue;
    }
    div.classList.add("pending");
    paraTotal++;
    Plamo.translate(src, target).then(
      (t) => { ja.replaceChildren(...nodesFrom(t, imgs)); div.classList.remove("pending"); },
      (e) => {
        div.classList.remove("pending");
        ja.classList.add("err");
        if (String(e.message) === "SERVER_DOWN") checkServer();
      },
    ).finally(() => { paraDone++; progress(); });
  }
  progress();
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
function renderTable(b, div, crop, caption) {
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
      const imgs = cell.parts.filter((p) => p.t === "math").map((m) => crop(m.items, b.h));
      td.append(...partsNodes(cell.parts, imgs));
      if (cell.parts.every((p) => p.t === "text") && Plamo.shouldTranslate(cell.text, target)) {
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
  div.addEventListener("click", () => div.classList.toggle("open"));
  if (!cells.length) return;
  div.classList.add("pending");
  paraTotal++;
  const src = cells.map((c, k) => `<t${k + 1}>${c.text.replace(/[<>]/g, "")}</t${k + 1}>`).join("\n");
  const context = caption.slice(0, 400);
  Plamo.translate(src, target, context).then(
    (t) => {
      const re = /<t(\d+)>([\s\S]*?)<\/t\1>/g;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        const c = cells[Number(m[1]) - 1];
        if (c && m[2].trim()) c.td.textContent = m[2].trim();
      }
    },
    () => {},
  ).finally(() => { div.classList.remove("pending"); paraDone++; progress(); });
}

// ---- wiring ----
$("showOrig").addEventListener("change", (e) => document.body.classList.toggle("show-orig", e.target.checked));
$("export").addEventListener("click", () => exportPdf().catch((e) => alert("書き出せなかったよ: " + (e.message || e))));
$("pick").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) open(await f.arrayBuffer(), f.name);
});
document.addEventListener("dragover", (e) => { e.preventDefault(); $("drop")?.classList.add("over"); });
document.addEventListener("dragleave", () => $("drop")?.classList.remove("over"));
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.type === "application/pdf" || /\.pdf$/i.test(x.name));
  if (f) open(await f.arrayBuffer(), f.name);
});

(async () => {
  target = await Plamo.target();
  checkServer(true);
  const file = new URLSearchParams(location.search).get("file");
  if (!file) return;
  const name = decodeURIComponent(file.split(/[?#]/)[0].split("/").pop() || "document.pdf");
  $("name").textContent = name + " を読み込み中…";
  try {
    open(await bytesFromUrl(file), name);
  } catch (e) {
    $("name").textContent = name;
    const hint = file.startsWith("file:")
      ? "ローカルの PDF は、拡張機能の詳細で「ファイルの URL へのアクセスを許可する」をオンにするか、ここにドロップしてね。"
      : "PDF を取得できなかったよ。ダウンロードしてここにドロップしてね。";
    $("drop").innerHTML = `<p class="err">${hint}</p><p class="hint">${String(e.message || e)}</p>`;
  }
})();
