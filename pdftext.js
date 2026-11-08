// PDF text -> blocks (paragraphs and display equations), with math kept as positioned item groups
// so the viewer can show it as a crop of the rendered page instead of broken text.

const MATH_FONT = /^(CMMI|CMSY|CMEX|CMBSY|CMMIB|MSBM|MSAM|EUFM|EUSM|EURM|EUEX|RSFS|LMMath|LatinModernMath|STIX.*Math|STIXMath|XITSMath|CambriaMath|TeXGyre.*Math|txmi|txsy|txex|pxmi|pxsy|pxex|rtxmi|ntxmi|ntxsy|zxlmi|esint|wasy|MTMI|MTSY|MTEX|Symbol)/i;
// Roman math fonts: math only when they are not the page's body font (papers set entirely in CM use CMR for text).
const MATH_ROMAN = /^(CMR|CMBX|LMRoman|LMMono)\d*/i;
const MATH_CHAR = /[Α-ωϑϕϵ∀-⋿←-⇿⨀-⫿\u{1d400}-\u{1d7ff}√′″±×÷·]/u;
const GLUE = /^[\s()[\]{}=+\-−,.:;|/0-9]{1,3}$/;

function family(name) {
  return String(name || "").replace(/^[A-Z]{6}\+/, "");
}

// The real font name (CMMI10 etc.) is only in commonObjs after the page has been rendered.
function fontOf(page, id) {
  try {
    return family(page.commonObjs.get(id)?.name);
  } catch {
    return "";
  }
}

function mathCharRatio(s) {
  const chars = [...s.replace(/\s/g, "")];
  if (!chars.length) return 0;
  return chars.filter((c) => MATH_CHAR.test(c)).length / chars.length;
}

// ---- drawn graphics (to find figures) ----
// Bounding boxes, in PDF units, of everything painted: paths (not clip paths) and images.
// opList comes from page.getOperatorList(); OPS is pdfjsLib.OPS.
export function graphicsBoxes(opList, OPS) {
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let clip = [-Infinity, -Infinity, Infinity, Infinity]; // plotted curves often run far outside their axes
  const stack = [];
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const toPage = (x0, y0, x1, y1) => {
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  };
  const cut = (b) => [Math.max(b[0], clip[0]), Math.max(b[1], clip[1]), Math.min(b[2], clip[2]), Math.min(b[3], clip[3])];
  const boxOf = (x0, y0, x1, y1, kind) => {
    const b = cut(toPage(x0, y0, x1, y1));
    if (b[2] > b[0] && b[3] > b[1]) out.push({ box: b, kind });
  };
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push([ctm, clip]);
    else if (fn === OPS.restore) [ctm, clip] = stack.pop() || [[1, 0, 0, 1, 0, 0], [-Infinity, -Infinity, Infinity, Infinity]];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([ctm, clip]); if (args?.[0]) ctm = mul(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) [ctm, clip] = stack.pop() || [[1, 0, 0, 1, 0, 0], [-Infinity, -Infinity, Infinity, Infinity]];
    else if (fn === OPS.constructPath) {
      const [paint, , mm] = args;
      if (!mm) continue;
      // a path that is not painted is a clipping path: later drawing is cut to it
      if (paint === OPS.endPath) { clip = cut(toPage(mm[0], mm[1], mm[2], mm[3])); continue; }
      boxOf(mm[0], mm[1], mm[2], mm[3], "path");
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      boxOf(0, 0, 1, 1, "image");
    }
  }
  return out;
}

// Figure regions: drawn areas (thin rules and page-sized backgrounds left out), merged when close,
// plus the short labels inside them. A frame around running text (an algorithm box) is not a figure.
function figureRegions(gfx, items, rotated, pageBox) {
  const pageArea = (pageBox[2] - pageBox[0]) * (pageBox[3] - pageBox[1]);
  let regions = [];
  for (const g of gfx) {
    const [x0, y0, x1, y1] = g.box;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w * h > pageArea * 0.5) continue; // page background
    // Thin lines (arrows, axes, table rules, fraction bars) only connect other drawings:
    // a region made of lines alone is a table or a formula, not a figure.
    if (g.kind === "path" && Math.min(w, h) < 2) {
      if (Math.max(w, h) >= 8) regions.push({ box: [...g.box], n: 0 });
      continue;
    }
    if (w * h < 30) continue;
    regions.push({ box: [...g.box], n: 1, image: g.kind === "image" });
  }
  for (const r of rotated) regions.push({ box: [...r], n: 1, rot: 1 });
  const close = (A, B, m) => A[0] < B[2] + m && A[2] > B[0] - m && A[1] < B[3] + m && A[3] > B[1] - m;
  const join = (a, b) => ({
    box: [Math.min(a.box[0], b.box[0]), Math.min(a.box[1], b.box[1]), Math.max(a.box[2], b.box[2]), Math.max(a.box[3], b.box[3])],
    n: a.n + b.n, image: a.image || b.image, rot: (a.rot || 0) + (b.rot || 0),
  });
  const mergeAll = (m) => {
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < regions.length; i++) {
        for (let j = i + 1; j < regions.length; j++) {
          if (close(regions[i].box, regions[j].box, m)) {
            regions[i] = join(regions[i], regions[j]);
            regions.splice(j, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
  };
  mergeAll(8);
  regions = regions.filter((r) => r.n > 0 || r.rot);
  // Labels: short text whose centre is in (or just around) a region becomes part of it.
  // Short text, but not the start of a caption ("Figure 6. Training on CIFAR-10" set in bold) and
  // not a piece of a running-text line (the rest of the caption line is a long item on the same baseline).
  // (only a long item right next to it counts: on two-column pages a body line of the other column
  // often shares the baseline of a figure label)
  const longItems = items.filter((it) => it.str.trim().length >= 40);
  const partOfLongLine = (it) => longItems.some((o) => Math.abs(o.y - it.y) < 1
    && (Math.abs(o.x - (it.x + it.w)) < 20 || Math.abs(it.x - (o.x + o.w)) < 20));
  const label = (it) => it.str.trim().length < 40
    && !/^(Figure|Fig\.|Table|Algorithm)\s*\d/i.test(it.str.trim())
    && !partOfLongLine(it);
  const centre = (it) => [it.x + it.w / 2, it.y + it.h * 0.35];
  const taken = new Set();
  for (const r of regions) {
    const [x0, y0, x1, y1] = r.box;
    let labelChars = 0;
    let longChars = 0;
    const inside = [];
    for (const it of items) {
      if (!it.str.trim()) continue;
      const [cx, cy] = centre(it);
      const strict = cx > x0 && cx < x1 && cy > y0 && cy < y1;
      const near = cx > x0 - 14 && cx < x1 + 14 && cy > y0 - 18 && cy < y1 + 18; // panel titles sit just above/below
      if (strict && !label(it)) longChars += it.str.length;
      if ((strict || near) && label(it)) { labelChars += it.str.length; inside.push(it); }
    }
    // a frame around paragraphs (algorithm box, highlighted note): leave its text alone
    if (longChars > labelChars) { r.frame = true; continue; }
    for (const it of inside) {
      taken.add(it);
      r.box = [Math.min(r.box[0], it.x), Math.min(r.box[1], it.y - it.h * 0.3), Math.max(r.box[2], it.x + it.w), Math.max(r.box[3], it.y + it.h)];
    }
  }
  // Boxes of a diagram joined by arrows: after labels are added, pieces a line apart belong together.
  const frames = regions.filter((r) => r.frame);
  regions = regions.filter((r) => !r.frame);
  mergeAll(12);
  regions = regions.filter((r) => {
    const w = r.box[2] - r.box[0];
    const h = r.box[3] - r.box[1];
    const big = Math.max(w, h) >= 50 && Math.min(w, h) >= 20; // a tall narrow diagram column counts
    return big && (r.n >= 2 || r.image || r.rot >= 3);
  });
  // Panels side by side (sub-figures, diagram columns): merge when they share most of their height.
  let sideBySide = true;
  while (sideBySide) {
    sideBySide = false;
    outer2: for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        const A = regions[i].box;
        const B = regions[j].box;
        const overlapY = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
        const gapX = Math.max(A[0], B[0]) - Math.min(A[2], B[2]);
        if (overlapY > 0.5 * Math.min(A[3] - A[1], B[3] - B[1]) && gapX < 40) {
          regions[i] = join(regions[i], regions[j]);
          regions.splice(j, 1);
          sideBySide = true;
          break outer2;
        }
      }
    }
  }
  // Row labels set beside a figure ("output size: 112" left of a diagram).
  // Pieces of a running-text line (a citation split off a body line) are not labels.
  for (const r of regions) {
    const [bx0, by0, bx1, by1] = r.box; // fixed: growing the box while scanning would chain into a nearby table
    for (const it of items) {
      if (!it.str.trim() || !label(it) || taken.has(it)) continue;
      const [, cy] = centre(it);
      // the whole label (not just its centre) must sit in the margin beside the figure,
      // so headings of the next column are not pulled in
      // a word with more words to its right on the same line, outside the figure, is a table cell
      const rowGoesOn = items.some((o) => o !== it && !taken.has(o) && o.str.trim() && Math.abs(o.y - it.y) < 1
        && o.x > it.x + it.w && o.x > bx1 && o.x - (it.x + it.w) < 80); // the next cell, not the other column
      if (!rowGoesOn && cy > by0 && cy < by1 && it.x > bx0 - 60 && it.x + it.w < bx1 + 60) {
        taken.add(it);
        r.box = [Math.min(r.box[0], it.x), r.box[1], Math.max(r.box[2], it.x + it.w), r.box[3]];
      }
    }
  }
  // labels of pieces that did not make a figure go back to the text
  for (const it of [...taken]) {
    const [cx, cy] = centre(it);
    const kept = regions.some((r) => cx > r.box[0] - 1 && cx < r.box[2] + 1 && cy > r.box[1] - 1 && cy < r.box[3] + 1);
    if (!kept) taken.delete(it);
  }
  void frames;
  return { figures: regions.map((r) => ({ kind: "figure", box: r.box, top: r.box[3], h: 10 })), taken };
}

// Call after page.render() has finished, so that font names are available.
// gfx: graphicsBoxes(...) of the page (optional; without it only rotated labels make figures).
export function blocksFromPage(page, tc, gfx = []) {
  const items = [];
  const weight = new Map();
  const rotated = []; // text drawn at an angle: labels inside figures, not running text
  for (const it of tc.items) {
    if (!("str" in it)) continue;
    const [a, b, c, d, x, y] = it.transform;
    const font = fontOf(page, it.fontName);
    const h = Math.hypot(c, d) || it.height || 1;
    if (it.str.trim() && (Math.abs(b) > Math.abs(a) * 0.05 || Math.abs(c) > Math.abs(d) * 0.05)) {
      rotated.push(rotatedBox(it.transform, it.width || 0, h));
      continue;
    }
    items.push({ str: it.str, x, y, w: it.width || 0, h, font, eol: it.hasEOL });
    if (it.str.trim()) weight.set(font, (weight.get(font) || 0) + it.str.length);
  }
  const body = [...weight.entries()].filter(([f]) => !MATH_FONT.test(f)).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const view = page.view || [0, 0, 612, 792];
  const { figures: figs, taken } = figureRegions(gfx, items, rotated, view);
  for (let k = items.length - 1; k >= 0; k--) if (taken.has(items[k])) items.splice(k, 1);
  for (const it of items) {
    const s = it.str.trim();
    it.math = !!s && (MATH_FONT.test(it.font) || (MATH_ROMAN.test(it.font) && it.font !== body) || mathCharRatio(s) >= 0.5);
  }

  // items -> lines
  const lines = [];
  let cur = null;
  let eolPending = false;
  for (const it of items) {
    // pdf.js marks line ends inside a line too (around formulas); keep going when the next item
    // continues on the same baseline to the right.
    if (eolPending && cur) {
      // (x within a few chars of the line end, so the next column of a two-column page is not glued on)
      const sameLine = Math.abs(it.y - cur.y) < Math.max(it.h, cur.h || it.h) * 0.3
        && it.x >= cur.endX - it.h && it.x <= cur.endX + it.h * 1.5;
      if (!sameLine) { lines.push(cur); cur = null; }
      eolPending = false;
    }
    if (cur && cur.items.length && Math.abs(it.y - cur.y) > Math.max(it.h, cur.h) * 0.6 && !(it.math || cur.lastMath)) {
      lines.push(cur);
      cur = null;
    }
    // sub/superscripts move y a little; keep them on the line when they are math
    if (cur && cur.items.length && Math.abs(it.y - cur.y) > Math.max(it.h, cur.h) * 1.2) { lines.push(cur); cur = null; }
    if (!cur) cur = { items: [], x: it.x, y: it.y, h: 0, endX: it.x, lastMath: false };
    cur.items.push(it);
    if (it.str.trim()) {
      if (!it.math) cur.h = Math.max(cur.h, it.h);
      cur.endX = Math.max(cur.endX, it.x + it.w);
      cur.lastMath = it.math;
      if (!it.math) cur.y = it.y; // baseline of the text, not of a subscript
    }
    if (it.eol) eolPending = true;
  }
  if (cur) lines.push(cur);

  for (const ln of lines) finishLine(ln);
  const blocks = group(lines.filter((l) => l.text.trim()));
  // Two-column pages are read left column then right column, so a figure goes into the reading
  // order of its own column: before the first block of that column that starts below its top.
  const mid = (view[0] + view[2]) / 2;
  const textLines = lines.filter((l) => l.text.trim().length > 20);
  const twoColumn = textLines.filter((l) => l.x > mid - 15).length >= 5 && textLines.filter((l) => l.endX < mid + 15).length >= 5;
  const column = (x0, x1) => (!twoColumn ? "F" : x1 < mid + 15 ? "L" : x0 > mid - 15 ? "R" : "F");
  const colOfBlock = (bl) => {
    if (bl.kind === "figure") return column(bl.box[0], bl.box[2]);
    const xs = bl.kind === "text" ? [bl.x] : (bl.items || []).map((i) => i.x);
    const x0 = Math.min(...xs);
    return x0 > mid - 15 ? "R" : "L";
  };
  for (const fig of figs) {
    const c = column(fig.box[0], fig.box[2]);
    fig.col = c; // the viewer puts side-by-side figures together only within one column
    const below = (bl) => (bl.top ?? bl.y) < fig.box[3];
    let at;
    if (c === "F") at = blocks.findIndex(below); // spans both columns: by height alone
    else {
      at = blocks.findIndex((bl) => colOfBlock(bl) === c && below(bl));
      if (at < 0) {
        // nothing of its column below it: after the last block of that column
        let last = -1;
        blocks.forEach((bl, k) => { if (colOfBlock(bl) === c) last = k; });
        at = last + 1;
      }
    }
    blocks.splice(at < 0 ? blocks.length : at, 0, fig);
  }
  return blocks;
}

// Bounding box [x0, y0, x1, y1] (PDF units) of a text item drawn in any direction.
function rotatedBox([a, b, c, d, x, y], width, h) {
  const n = Math.hypot(a, b) || 1;
  const m = Math.hypot(c, d) || 1;
  const dir = [a / n, b / n];
  const up = [c / m, d / m];
  const pts = [];
  for (const s of [0, width]) for (const t of [-0.25 * h, h]) pts.push([x + dir[0] * s + up[0] * t, y + dir[1] * s + up[1] * t]);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

// Marks glue between math items as math, then splits the line into text/math parts.
function finishLine(ln) {
  const its = ln.items.filter((i) => i.str !== "");
  const solid = its.filter((i) => i.str.trim());
  for (let i = 1; i < solid.length - 1; i++) {
    if (!solid[i].math && GLUE.test(solid[i].str) && solid[i - 1].math && solid[i + 1].math) solid[i].math = true;
  }
  // Sub/superscripts set in the text font (d_model): smaller, off the baseline, next to math.
  const bodyH = Math.max(0, ...solid.filter((i) => !i.math).map((i) => i.h));
  for (let i = 0; i < solid.length; i++) {
    const it = solid[i];
    const small = it.h < bodyH * 0.85 && Math.abs(it.y - ln.y) > bodyH * 0.1;
    if (!it.math && small && (solid[i - 1]?.math || solid[i + 1]?.math)) it.math = true;
  }
  const parts = [];
  let prevEnd = null;
  let prevText = null; // last text item, to put a space where a table cell wraps to a new line
  let text = "";
  let mathChars = 0;
  let allChars = 0;
  for (const it of its) {
    const s = it.str;
    const n = s.replace(/\s/g, "").length;
    allChars += n;
    if (it.math) mathChars += n;
    const last = parts[parts.length - 1];
    const wrapped = !it.math && prevText && Math.abs(it.y - prevText.y) > it.h * 0.8;
    const gapSpace = prevEnd !== null && (it.x - prevEnd > it.h * 0.15 || wrapped) ? " " : "";
    if (s.trim() && !it.math) prevText = it;
    if (it.math || (!s.trim() && last?.t === "math")) {
      if (last?.t === "math") last.items.push(it);
      else {
        if (gapSpace && last?.t === "text" && !/\s$/.test(last.s)) last.s += " ";
        parts.push({ t: "math", items: [it] });
      }
    } else if (last?.t === "text") {
      last.s += (gapSpace && !/\s$/.test(last.s) && !/^\s/.test(s) ? " " : "") + s;
    } else {
      parts.push({ t: "text", s: (gapSpace && last ? " " : "") + s });
    }
    text += (gapSpace && text && !/\s$/.test(text) && !/^\s/.test(s) ? " " : "") + s;
    if (s.trim()) prevEnd = it.x + it.w;
  }
  for (const p of parts) if (p.t === "math") p.items = p.items.filter((i) => i.str.trim());
  ln.parts = parts.filter((p) => (p.t === "text" ? p.s !== "" : p.items.length));
  ln.text = text.replace(/\s+/g, " ").trim();
  ln.display = allChars > 0 && mathChars / allChars >= 0.6;
  if (!ln.h) ln.h = Math.max(...ln.items.map((i) => i.h));
}

function joinParts(a, b) {
  const last = a[a.length - 1];
  const first = b[0];
  if (last?.t === "text" && first?.t === "text") {
    const hyph = /[A-Za-z]-$/.test(last.s.trimEnd()) && /^[a-z]/.test(first.s.trimStart());
    last.s = hyph ? last.s.trimEnd().slice(0, -1) + first.s.trimStart() : last.s.trimEnd() + " " + first.s.trimStart();
    return a.concat(b.slice(1));
  }
  if (last?.t === "text") last.s = last.s.trimEnd() + " ";
  return a.concat(b);
}

function group(lines) {
  const rightEdge = (ln) => Math.max(...lines.filter((o) => Math.abs(o.x - ln.x) < ln.h * 3).map((o) => o.endX));
  const isHeading = (t) => t.length < 90 && /^(\d+(\.\d+)*\.?|[A-Z]\.)\s+\S/.test(t) && !/[.,;]$/.test(t);
  const sentenceEnd = /[.!?:]["')\]]?$/;
  const out = [];
  let p = null;
  const solid = (ln) => ln.items.filter((i) => i.str.trim());
  // Pieces of one display equation (fraction bars, limits, the "(1)" label) arrive as separate lines.
  const nearEq = (eq, ln) => ln.y > eq.bottom - eq.h * 2.5 && ln.y < eq.top + eq.h * 2.5;
  const addToEq = (eq, ln) => {
    eq.items.push(...solid(ln));
    eq.top = Math.max(eq.top, ln.y);
    eq.bottom = Math.min(eq.bottom, ln.y);
  };
  const tables = findTables(lines);
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const tb = tables.get(li);
    if (tb) {
      if (p) out.push(p);
      out.push(tb.block);
      p = null;
      li = tb.end;
      continue;
    }
    if (ln.display) {
      if (p?.kind === "eq" && nearEq(p, ln)) { addToEq(p, ln); continue; }
      // A small formula sitting on the current text line (e.g. an inline fraction) stays in the sentence.
      if (p?.kind === "text" && Math.abs(ln.y - p.y) < p.h * 1.0 && ln.text.length < 40) {
        p.parts = joinParts(p.parts, [{ t: "math", items: solid(ln) }]);
        p.text += " " + ln.text;
        p.lines.push(ln);
        p.inlineTail = true;
        continue;
      }
      if (p) out.push(p);
      p = { kind: "eq", items: solid(ln), y: ln.y, top: ln.y, bottom: ln.y, h: ln.h };
      continue;
    }
    const t = ln.text;
    if (p?.kind === "eq" && nearEq(p, ln) && t.length < 25 && (ln.parts.some((x) => x.t === "math") || /^\(\d+\)$/.test(t))) {
      addToEq(p, ln);
      continue;
    }
    if (p?.kind === "text") {
      const gap = p.y - ln.y; // PDF y grows upward
      const sameSize = Math.abs(ln.h - p.h) <= p.h * 0.15;
      const lineGap = p.gap ?? p.h * 1.6;
      // gap <= 0: the rest of the same line after an inline formula
      const sameLine = p.inlineTail && Math.abs(gap) < p.h * 0.5 && ln.x >= p.lastEnd - p.h;
      const near = sameLine || (gap > 0 && gap <= lineGap * 1.35);
      const indent = ln.x - p.x > p.h * 0.8 && sentenceEnd.test(p.text);
      const prevShort = p.lastEnd < rightEdge(p.last) - p.h * 2 && sentenceEnd.test(p.text);
      if (sameSize && near && (sameLine || (!indent && !prevShort)) && !p.heading && !isHeading(t)) {
        if (p.gap === undefined && !sameLine) p.gap = gap;
        p.text += " " + t;
        p.parts = joinParts(p.parts, ln.parts.map((x) => ({ ...x })));
        p.lines.push(ln);
        if (!sameLine) p.y = ln.y;
        p.last = ln;
        p.lastEnd = ln.endX;
        p.inlineTail = false;
        continue;
      }
    }
    if (p) out.push(p);
    p = { kind: "text", text: t, parts: ln.parts.map((x) => ({ ...x })), x: ln.x, y: ln.y, top: ln.y + ln.h, h: ln.h, last: ln, lines: [ln], lastEnd: ln.endX, heading: isHeading(t) };
  }
  if (p) out.push(p);
  return out;
}

// ---- tables ----
// A table is a run of lines whose items are split by wide horizontal gaps (cells).

function segments(ln, factor = 1.5) {
  const its = ln.items.filter((i) => i.str.trim()).sort((a, b) => a.x - b.x);
  const gapMin = Math.max(ln.h || 8, 6) * factor; // word spaces are ~0.25em, cell gaps are usually wider
  const segs = [];
  let cur = null;
  for (const it of its) {
    if (cur && it.x - cur.x1 > gapMin) { segs.push(cur); cur = null; }
    if (!cur) cur = { x0: it.x, x1: it.x + it.w, items: [] };
    cur.items.push(it);
    cur.x1 = Math.max(cur.x1, it.x + it.w);
  }
  if (cur) segs.push(cur);
  return segs;
}

function isEqLabelRow(ln, segs) {
  return segs.length === 2 && /^\(\d+[a-z]?\)$/.test(segs[1].items.map((i) => i.str).join("").trim());
}

function findTables(lines) {
  // A row is cells split by wide gaps (1.5em). Tightly set numeric tables use narrower gaps (0.6em):
  // those count only with 3+ cells of which 2+ are numbers, so reference lists and formulas stay text.
  const NUM = /^[-–—+±~≈<>≤≥]?\d[\d.,]*%?(\s*±\s*[\d.]+)?$|^[-–—]$/;
  const segs = lines.map((ln) => {
    const tight = segments(ln, 0.6);
    const numeric = tight.filter((s) => NUM.test(s.items.map((i) => i.str).join("").trim())).length;
    return tight.length >= 3 && numeric >= 2 ? tight : segments(ln, 1.5);
  });
  const multi = (k) => segs[k].length >= 2 && !isEqLabelRow(lines[k], segs[k]);
  const found = new Map();
  let i = 0;
  while (i < lines.length) {
    if (!multi(i)) { i++; continue; }
    let lastMulti = i;
    let count = 1;
    let bottom = lines[i].y; // lowest row so far (PDF y grows upward)
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      const h = Math.max(lines[lastMulti].h, ln.h);
      const gap = bottom - ln.y;
      if (multi(j) && gap > -0.5 * h && gap < 2.6 * h) { lastMulti = j; count++; bottom = Math.min(bottom, ln.y); continue; }
      // wrapped header, or a row-group label like "(C)" centred beside several rows below
      if (segs[j].length === 1 && ln.text.length < 60 && ln.y > bottom - 8 * h && ln.y < lines[i].y + h) continue;
      break;
    }
    if (count >= 2) {
      found.set(i, { end: lastMulti, block: tableBlock(lines.slice(i, lastMulti + 1), segs.slice(i, lastMulti + 1)) });
      i = lastMulti + 1;
    } else i++;
  }
  return found;
}

function tableBlock(lines, segs) {
  // Columns: x ranges that most data rows cover. A gap that is empty in nearly every row splits
  // columns even when one row has a cell spanning it (a value centred under two sub-columns).
  const maxCells = Math.max(...segs.map((s) => s.length));
  const h0 = Math.min(...lines.map((l) => l.h));
  const dataRows = segs.filter((s) => s.length >= Math.max(2, maxCells - 1));
  const xs = dataRows.flat().flatMap((s) => s.items.map((i) => [i.x, i.x + i.w]));
  const left = Math.floor(Math.min(...xs.map((r) => r[0])));
  const right = Math.ceil(Math.max(...xs.map((r) => r[1])));
  const cover = new Array(right - left + 1).fill(0);
  for (const row of dataRows) {
    const hit = new Uint8Array(cover.length);
    for (const s of row) for (const it of s.items) {
      // close the tiny gaps inside a cell (between the pieces of "2.3·10^19")
      for (let x = Math.floor(it.x - h0 * 0.15); x <= Math.ceil(it.x + it.w + h0 * 0.15); x++) if (x >= left && x <= right) hit[x - left] = 1;
    }
    hit.forEach((v, k) => { cover[k] += v; });
  }
  const minCover = Math.max(1, Math.ceil(dataRows.length * 0.3));
  const cols = [];
  for (let k = 0; k < cover.length; k++) {
    if (cover[k] < minCover) continue;
    const last = cols[cols.length - 1];
    if (last && left + k <= last[1] + 1) last[1] = left + k;
    else cols.push([left + k, left + k]);
  }
  const colOf = (s) => {
    let best = 0;
    let bestScore = -Infinity;
    cols.forEach(([a, b], k) => {
      const overlap = Math.min(b, s.x1) - Math.max(a, s.x0);
      const score = overlap > 0 ? overlap : -Math.abs((a + b) / 2 - (s.x0 + s.x1) / 2);
      if (score > bestScore) { bestScore = score; best = k; }
    });
    return best;
  };
  const rows = [];
  let prevLine = null;
  lines.forEach((ln, k) => {
    const cells = cols.map(() => []);
    // Place tight clusters (a word, or the pieces of "3.3·10^18") as a whole, so a value centred
    // across two sub-columns is not split between them.
    for (const s of segs[k]) {
      let group = [];
      const flush = () => {
        if (!group.length) return;
        const x0 = Math.min(...group.map((i) => i.x));
        const x1 = Math.max(...group.map((i) => i.x + i.w));
        cells[colOf({ x0, x1 })].push(...group);
        group = [];
      };
      for (const it of s.items) {
        const prev = group[group.length - 1];
        if (prev && it.x - (prev.x + prev.w) > h0 * 0.4) flush();
        group.push(it);
      }
      flush();
    }
    const filled = cells.filter((c) => c.length).length;
    const gap = prevLine ? prevLine.y - ln.y : Infinity;
    // A words-only line filling a few columns right under another row continues it (wrapped header).
    // Lines with numbers are data rows even when sparse (row groups).
    const wordsOnly = cells.flat().every((i) => !i.math && !/^[\d.,%+\-−×]+$/.test(i.str.trim()));
    if (rows.length && wordsOnly && filled <= Math.max(1, Math.floor(cols.length / 2)) && gap > 0 && gap < 1.4 * Math.max(ln.h, prevLine.h)) {
      cells.forEach((c, n) => rows[rows.length - 1][n].push(...c));
    } else rows.push(cells);
    prevLine = ln;
  });
  const cellOf = (items) => {
    if (!items.length) return null;
    const textItems = items.filter((i) => !i.math);
    const ln = { items: [...items].sort((a, b) => b.y - a.y || a.x - b.x), y: (textItems[0] || items[0]).y, h: Math.max(...items.map((i) => i.h)) };
    // keep reading order: top line first, left to right
    ln.items = groupByLine(ln.items);
    finishLine(ln);
    return { parts: ln.parts, text: ln.text };
  };
  const all = lines.flatMap((l) => l.items.filter((i) => i.str.trim()));
  const built = rows.map((r) => r.map(cellOf));
  // Very wide or nearly empty grids are probably a misread layout: show the original picture instead.
  const filled = built.flat().filter(Boolean).length;
  const regular = cols.length >= 2 && cols.length <= 16 && filled / (built.length * cols.length) >= 0.3;
  // Size of the table's body text (for math crops), not the smallest line (superscripts).
  const textHs = all.filter((i) => !i.math).map((i) => i.h).sort((a, b) => a - b);
  const bodyH = textHs[Math.floor(textHs.length / 2)] || h0;
  return { kind: "table", rows: built, regular, items: all, h: bodyH, top: Math.max(...lines.map((l) => l.y + l.h)) };
}

// Orders items top-to-bottom by visual line (sub/superscripts stay with their line), then left-to-right.
function groupByLine(items) {
  const out = [];
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const bands = [];
  for (const it of sorted) {
    const band = bands.find((b) => Math.abs(b.y - it.y) < Math.max(b.h, it.h) * 0.8);
    if (band) band.items.push(it);
    else bands.push({ y: it.y, h: it.h, items: [it] });
  }
  for (const b of bands) out.push(...b.items.sort((a, c) => a.x - c.x));
  return out;
}

// ---- crops of the rendered page ----
// Crops become ink-only images (transparent background) so they work on light and dark themes.
// A figure region (box in PDF units, already padded by the caller) as a colour picture.
export function figureImg(canvas, vp, box) {
  const [ax, ay, bx, by] = vp.convertToViewportRectangle(box);
  const sx = Math.max(0, Math.floor(Math.min(ax, bx)));
  const sy = Math.max(0, Math.floor(Math.min(ay, by)));
  const sw = Math.min(canvas.width - sx, Math.ceil(Math.abs(bx - ax)));
  const sh = Math.min(canvas.height - sy, Math.ceil(Math.abs(by - ay)));
  const c = document.createElement("canvas");
  c.width = Math.max(1, sw);
  c.height = Math.max(1, sh);
  c.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const img = document.createElement("img");
  img.className = "figure";
  img.src = c.toDataURL("image/jpeg", 0.9);
  img.alt = "図";
  return img;
}

export function makeCropper(canvas, vp) {
  return function crop(items, emH) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of items) {
      x0 = Math.min(x0, it.x);
      x1 = Math.max(x1, it.x + it.w);
      y0 = Math.min(y0, it.y - it.h * 0.27);
      y1 = Math.max(y1, it.y + it.h * 0.88);
    }
    const [ax, ay, bx, by] = vp.convertToViewportRectangle([x0, y0, x1, y1]);
    const pad = vp.scale; // about 1pt, so table rules just above/below are not caught
    const sx = Math.max(0, Math.floor(Math.min(ax, bx) - pad));
    const sy = Math.max(0, Math.floor(Math.min(ay, by) - pad));
    const sw = Math.min(canvas.width - sx, Math.ceil(Math.abs(bx - ax) + pad * 2));
    const sh = Math.min(canvas.height - sy, Math.ceil(Math.abs(by - ay) + pad * 2));
    const c = document.createElement("canvas");
    c.width = Math.max(1, sw);
    c.height = Math.max(1, sh);
    const cx = c.getContext("2d");
    cx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const px = cx.getImageData(0, 0, c.width, c.height);
    const d = px.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * (d[i + 3] / 255) + 255 * (1 - d[i + 3] / 255);
      d[i] = d[i + 1] = d[i + 2] = 0;
      d[i + 3] = 255 - lum;
    }
    // Table rules caught at the top/bottom edge: rows inked across almost the whole width.
    // (Only near the edges, so fraction bars in the middle stay.)
    const W = c.width;
    const H = c.height;
    const edge = Math.max(1, Math.floor(H * 0.2));
    for (let y = 0; y < H; y++) {
      if (y >= edge && y < H - edge) continue;
      let ink = 0;
      for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 96) ink++;
      if (ink > W * 0.9) for (let x = 0; x < W; x++) d[(y * W + x) * 4 + 3] = 0;
    }
    cx.putImageData(px, 0, 0);
    const img = document.createElement("img");
    img.className = "math";
    img.src = c.toDataURL("image/png");
    img.alt = items.map((i) => i.str).join("");
    const pdfH = (y1 - y0) * (sh / Math.max(1, Math.abs(by - ay)));
    img.style.height = (pdfH / (emH || 10)).toFixed(2) + "em";
    return img;
  };
}

// Where a block sits on its page: boxes [x0, y0, x1, y1] in PDF units (one per line for paragraphs).
export function sourceBoxes(block) {
  if (block.kind === "figure") return [block.box];
  const extent = (items) => {
    const its = items.filter((i) => i.str.trim());
    if (!its.length) return null;
    return [
      Math.min(...its.map((i) => i.x)),
      Math.min(...its.map((i) => i.y - i.h * 0.27)),
      Math.max(...its.map((i) => i.x + i.w)),
      Math.max(...its.map((i) => i.y + i.h * 0.88)),
    ];
  };
  const groups = block.kind === "text" ? block.lines.map((ln) => ln.items) : [block.items];
  return groups.map(extent).filter(Boolean);
}

// Text sent to the model: math parts become <tN>…</tN> so the model keeps them in place.
export function sourceOf(block) {
  let n = 0;
  let s = "";
  const maths = [];
  for (const p of block.parts) {
    if (p.t === "text") s += p.s;
    else {
      maths.push(p);
      n++;
      s += `<t${n}>${p.items.map((i) => i.str).join("").replace(/[<>]/g, "")}</t${n}>`;
    }
  }
  return { src: s.replace(/\s+/g, " ").trim(), maths, plain: block.parts.filter((p) => p.t === "text").map((p) => p.s).join(" ") };
}

// Builds DOM nodes from a translation that contains <tN>…</tN> markers.
export function nodesFrom(out, mathImgs) {
  const nodes = [];
  const re = /<t(\d+)>([\s\S]*?)<\/t\1>/g;
  let last = 0;
  const text = (t) => { t = t.replace(/<\/?t\d+>/g, ""); if (t) nodes.push(document.createTextNode(t)); };
  for (let m = re.exec(out); m; m = re.exec(out)) {
    text(out.slice(last, m.index));
    const img = mathImgs[Number(m[1]) - 1];
    nodes.push(img ? img.cloneNode() : document.createTextNode(m[2]));
    last = re.lastIndex;
  }
  text(out.slice(last));
  return nodes;
}

export function partsNodes(parts, mathImgs) {
  let k = 0;
  return parts.map((p) => (p.t === "text" ? document.createTextNode(p.s) : mathImgs[k++].cloneNode()));
}
