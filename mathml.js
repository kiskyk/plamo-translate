// Rebuilds a formula as MathML from where its glyphs sit on the page (born-digital TeX PDFs).
// Any glyph that cannot be placed makes the whole formula fail, so the caller keeps the page crop.

const NS = "http://www.w3.org/1998/Math/MathML";
const el = (tag, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const k of kids) e.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
  return e;
};

class Unplaced extends Error {}
const fail = (why) => { throw new Unplaced(why); };

// ---- characters ----
// Fonts embedded without glyph names report TeX's raw codes. These codes never occur as real
// text in these fonts, so they are safe to translate.
const CMMI_RAW = Object.fromEntries([..."αβγδϵζηθικλμνξπρστυϕχψωεϑϖϱςφ"].map((c, i) => [String.fromCharCode(0x0b + i), c]));
Object.assign(CMMI_RAW, { "✓": "θ" });
const CMSY_RAW = {
  "\0": "−", "\x01": "·", "\x02": "×", "\x03": "∗", "\x04": "÷", "\x05": "⋄", "\x06": "±", "\x07": "∓",
  "\x0e": "∘", "\x0f": "∙", "\x11": "≡", "\x12": "⊆", "\x13": "⊇", "\x14": "≤", "\x15": "≥", "\x18": "∼", "\x19": "≈",
  "\x1c": "≪", "\x1d": "≫", "!": "→", "\"": "↑", "#": "↓", "$": "↔", "'": "≃", "(": "⇐", ")": "⇒", ",": "⇔", "/": "∝",
};
const CMEX_RAW = {
  P: "∑", X: "∑", Q: "∏", Y: "∏", R: "∫", Z: "∫", S: "⋃", T: "⋂", p: "√", q: "√", r: "√", s: "√",
  ...Object.fromEntries([..."()[]⌊⌋⌈⌉{}⟨⟩|‖"].map((c, i) => [String.fromCharCode(i), c])),
  ...Object.fromEntries([..."()()[]⌊⌋⌈⌉{}⟨⟩"].map((c, i) => [String.fromCharCode(0x10 + i), c])),
};

// Tall delimiters are drawn from pieces: the top piece stands for the whole, the rest are dropped.
const PIECE_TOP = { "\uF8EE": "[", "\uF8F9": "]", "\uF8EB": "(", "\uF8F6": ")", "\uF8F1": "{", "\uF8FC": "}", "⎡": "[", "⎤": "]", "⎛": "(", "⎞": ")", "⎧": "{", "⎫": "}" };
const PIECE_REST = /^[\uF8EF\uF8F0\uF8FA\uF8FB\uF8EC\uF8ED\uF8F7\uF8F8\uF8F2\uF8F3\uF8F4\uF8FD\uF8FE⎢⎣⎥⎦⎜⎝⎟⎠⎨⎩⎪⎬⎭]$/;

const offset = (c, base, from) => String.fromCodePoint(base + c.codePointAt(0) - from.codePointAt(0));
const SCRIPT_GAPS = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" };
const DOUBLE_GAPS = { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" };
const BOLD_ITALIC_VARIANTS = { ϵ: 0x1d750, ϑ: 0x1d751, ϰ: 0x1d752, ϕ: 0x1d753, ϱ: 0x1d754, ϖ: 0x1d755 };

function boldUpright(c) {
  if (/[A-Z]/.test(c)) return offset(c, 0x1d400, "A");
  if (/[a-z]/.test(c)) return offset(c, 0x1d41a, "a");
  if (/[0-9]/.test(c)) return offset(c, 0x1d7ce, "0");
  if (/[Α-Ω]/.test(c)) return offset(c, 0x1d6a8, "Α");
  if (/[α-ω]/.test(c)) return offset(c, 0x1d6c2, "α");
  return c;
}
function boldItalic(c) {
  if (/[A-Z]/.test(c)) return offset(c, 0x1d468, "A");
  if (/[a-z]/.test(c)) return offset(c, 0x1d482, "a");
  if (/[Α-Ω]/.test(c)) return offset(c, 0x1d71c, "Α");
  if (/[α-ω]/.test(c)) return offset(c, 0x1d736, "α");
  if (BOLD_ITALIC_VARIANTS[c]) return String.fromCodePoint(BOLD_ITALIC_VARIANTS[c]);
  return c;
}

const familyOf = (font) => String(font || "").replace(/^[A-Z]{6}\+/, "").replace(/[\d.]+$/, "").toUpperCase();
const UPRIGHT_FONT = /^(CMR|CMSS|CMTT|LMROMAN|NIMBUSROM|TIMES|CMUSERIF-ROMAN|PAGELLA)/;
const KNOWN_SYMBOL = /^[A-Za-z0-9+\-−=<>≤≥≪≫∼≈≃≡×·∗/|‖∥⊺≲≳⩽⩾≅≜∅∣∈∉∋⊂⊆⊃⊇∪∩∧∨¬∀∃∅←→↔⇐⇒⇔↦↑↓()[\]{}⟨⟩⌊⌋⌈⌉,;:.!?∑∏∫∮⋃⋂⨁⨂√∇∂∞′″†‡∘∙⋄±∓∝'Α-Ωα-ωϑϕϖϰϱϵ∆Ω]$/u;
const ACCENT = /^[¯ˆ˜˙¨˘ˇ´`̂̃]$/;
const ACCENT_MO = { "̂": "ˆ", "̃": "˜" };
const LIMIT_OP = /^[∑∏⋃⋂⨁⨂]$/;
const OPEN = "([{⟨⌊⌈";
const CLOSE = ")]}⟩⌋⌉";
const DIGIT = /^[0-9]$/;
const LETTER = /^\p{L}$/u;

function decode(ch, fam) {
  if (PIECE_REST.test(ch)) return null;
  if (PIECE_TOP[ch]) ch = PIECE_TOP[ch];
  if (/^CMMI/.test(fam) && CMMI_RAW[ch]) ch = CMMI_RAW[ch];
  if (/^CMSY|^CMBSY/.test(fam) && CMSY_RAW[ch]) ch = CMSY_RAW[ch];
  if (/^CMEX/.test(fam) && CMEX_RAW[ch]) ch = CMEX_RAW[ch];
  if (ch === "∆") ch = "Δ";
  if (ch === "Ω") ch = "Ω";
  if (ACCENT.test(ch)) return { ch, accent: true };
  if (!KNOWN_SYMBOL.test(ch)) fail("文字 U+" + ch.codePointAt(0).toString(16).toUpperCase() + " " + fam);
  if (/^MSBM/.test(fam) && /[A-Z]/.test(ch)) return { ch: DOUBLE_GAPS[ch] || offset(ch, 0x1d538, "A"), identifier: true };
  if (/^CMSY|^CMBSY/.test(fam) && /[A-Z]/.test(ch)) return { ch: SCRIPT_GAPS[ch] || offset(ch, 0x1d49c, "A"), identifier: true };
  if (/^(CMSY|CMBSY)/.test(fam) && /[a-z0-9]/.test(ch)) fail("記号フォントの生コード " + ch);
  if (/^CMEX/.test(fam) && /[A-Za-z0-9]/.test(ch)) fail("記号フォントの生コード " + ch);
  if (/^MSAM|^MSBM/.test(fam) && ch.charCodeAt(0) < 0x80) fail("未対応の記号 " + ch);
  if (/^(CMMIB|CMBSY)/.test(fam)) return { ch: boldItalic(ch), identifier: LETTER.test(ch) };
  if (/^CMBX|^EURB/.test(fam)) return { ch: boldUpright(ch), identifier: LETTER.test(ch) };
  return { ch, upright: UPRIGHT_FONT.test(fam) && LETTER.test(ch) };
}

// One atom per glyph; the characters of a run share its width evenly.
function glyphsFrom(items) {
  const out = [];
  for (const it of items) {
    const chars = [...it.str];
    const n = chars.length || 1;
    const fam = familyOf(it.font);
    chars.forEach((raw, i) => {
      if (!raw.trim() && raw !== "\0") return;
      const d = decode(raw, fam);
      if (!d) return;
      out.push({
        ...d, x0: it.x + (it.w * i) / n, x1: it.x + (it.w * (i + 1)) / n, y: it.y, size: it.h,
        big: /^CMEX/.test(fam),
      });
    });
  }
  return joinArrows(joinBars(out.sort((a, b) => a.x0 - b.x0)));
}

// A tall norm or evaluation bar is several identical pieces stacked at one x.
function joinBars(glyphs) {
  const out = [];
  const last = new Map();
  for (const g of glyphs) {
    if (g.big && /^[∥∣|‖]$/.test(g.ch)) {
      const key = g.ch + Math.round(g.x0);
      const seen = last.get(key);
      if (seen && Math.abs(seen.y - g.y) < g.size * 2) { seen.y = g.y; continue; }
      last.set(key, { y: g.y });
    }
    out.push(g);
  }
  return out;
}

// A long arrow is overlapping minus signs ending in an arrow head.
function joinArrows(glyphs) {
  const out = [];
  for (const g of glyphs) {
    const p = out[out.length - 1];
    if (p && p.ch === "−" && (g.ch === "−" || g.ch === "→") && p.x1 - g.x0 > (p.x1 - p.x0) * 0.25 && Math.abs(p.y - g.y) < 0.1) {
      out[out.length - 1] = { ...g, x0: p.x0, ch: g.ch === "→" ? "⟶" : "−" };
    } else out.push(g);
  }
  return out;
}

// ---- layout ----
const center = (a) => (a.x0 + a.x1) / 2;
const nodeAtom = (node, parts, y, size) => ({
  node, x0: Math.min(...parts.map((p) => p.x0)), x1: Math.max(...parts.map((p) => p.x1)), y, size,
});

function baselineOf(atoms) {
  const normal = atoms.filter((a) => !a.big);
  const pool = normal.length ? normal : atoms;
  const size = Math.max(...pool.map((a) => a.size));
  const votes = new Map();
  for (const a of pool) {
    if (a.size < size * 0.85) continue;
    const key = a.y.toFixed(1);
    votes.set(key, (votes.get(key) || 0) + a.x1 - a.x0 + 0.01);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return { y: Number(best[0]), size };
}

function attachAccents(atoms) {
  const accents = atoms.filter((a) => a.accent);
  let rest = atoms.filter((a) => !a.accent);
  for (const acc of accents) {
    const wide = acc.big && acc.x1 - acc.x0 > 2;
    const base = rest.filter((a) => !a.big && a.size >= acc.size * 0.65 && (
      (center(a) >= acc.x0 - 2 && center(a) <= acc.x1 + 2) || (center(acc) >= a.x0 - 1 && center(acc) <= a.x1 + 1)));
    const picked = wide ? base : base.sort((a, b) => Math.abs(center(a) - center(acc)) - Math.abs(center(b) - center(acc))).slice(0, 1);
    if (!picked.length) fail("アクセントの相手がない");
    const inner = serialize(picked.sort((a, b) => a.x0 - b.x0), null);
    const mo = el("mo", ACCENT_MO[acc.ch] || acc.ch);
    mo.setAttribute("stretchy", wide ? "true" : "false");
    const over = el("mover", inner, mo);
    over.setAttribute("accent", "true");
    rest = rest.filter((a) => !picked.includes(a));
    rest.push({ ...nodeAtom(over, picked, picked[0].y, picked[0].size), identifier: true });
  }
  return rest.sort((a, b) => a.x0 - b.x0);
}

const middleY = (a) => (a.big || a.ch === "√" ? a.y - a.size * 1.2 : a.y);

function applyRules(atoms, rules) {
  let pool = atoms;
  const ordered = [...rules].sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0));
  const used = new Set();
  for (const r of ordered) {
    if (used.has(r) || !pool.length) continue;
    const others = ordered.filter((o) => o !== r && !used.has(o));
    const inX = (a) => center(a) >= r.x0 - 0.5 && center(a) <= r.x1 + 0.5;
    const size = Math.max(...pool.map((a) => a.size));
    const root = pool.find((a) => a.ch === "√" && Math.abs(a.x1 - r.x0) <= 3 && r.x0 >= center(a));
    if (root) {
      const inside = pool.filter((a) => a !== root && inX(a) && a.y < r.y);
      if (!inside.length) fail("根号の中身がない");
      const inRules = others.filter((o) => o.x0 >= r.x0 - 0.5 && o.x1 <= r.x1 + 0.5 && o.y < r.y);
      inRules.forEach((o) => used.add(o));
      used.add(r);
      const { y, size: s } = baselineOf(inside);
      const node = el("msqrt", serialize(build(inside, inRules), null));
      pool = pool.filter((a) => a !== root && !inside.includes(a));
      pool.push({ ...nodeAtom(node, [root, ...inside], y, s), x1: r.x1 });
      continue;
    }
    const reach = size * 2.6;
    const above = pool.filter((a) => inX(a) && middleY(a) > r.y && middleY(a) - r.y < reach);
    const below = pool.filter((a) => inX(a) && middleY(a) < r.y && r.y - middleY(a) < reach);
    const inside = (o, up) => o.x0 >= r.x0 - 0.5 && o.x1 <= r.x1 + 0.5 && (up ? o.y > r.y : o.y < r.y) && Math.abs(o.y - r.y) < reach;
    if (above.length && below.length) {
      const upRules = others.filter((o) => inside(o, true));
      const downRules = others.filter((o) => inside(o, false));
      [...upRules, ...downRules].forEach((o) => used.add(o));
      used.add(r);
      const node = el("mfrac", serialize(build(above, upRules), null), serialize(build(below, downRules), null));
      pool = pool.filter((a) => !above.includes(a) && !below.includes(a));
      pool.push({ ...nodeAtom(node, [...above, ...below], r.y - size * 0.25, size), x0: r.x0, x1: r.x1 });
    } else if (below.length && r.y - Math.max(...below.map((a) => a.y)) < size * 1.2) {
      used.add(r);
      const mo = el("mo", "¯");
      mo.setAttribute("stretchy", "true");
      const node = el("mover", serialize(build(below, []), null), mo);
      const { y, size: s } = baselineOf(below);
      pool = pool.filter((a) => !below.includes(a));
      pool.push(nodeAtom(node, below, y, s));
    }
  }
  return pool.sort((a, b) => a.x0 - b.x0);
}

function takeLimits(atoms) {
  const { y: base, size } = baselineOf(atoms);
  let pool = atoms;
  for (const op of atoms.filter((a) => a.big && LIMIT_OP.test(a.ch))) {
    const near = (a) => a !== op && !a.big && a.x1 > op.x0 - 4 && a.x0 < op.x1 + 4;
    const grow = (seed) => {
      const set = new Set(seed);
      for (let grew = true; grew;) {
        grew = false;
        for (const a of pool) {
          if (set.has(a) || a.big) continue;
          if ([...set].some((s) => Math.abs(s.y - a.y) < size * 0.35 && (a.x0 - s.x1 < 1.5 && s.x0 - a.x1 < 1.5))) { set.add(a); grew = true; }
        }
      }
      return [...set];
    };
    const under = grow(pool.filter((a) => near(a) && a.y < base - size * 0.75));
    const over = grow(pool.filter((a) => near(a) && a.y > base + size * 0.75));
    if (!under.length && !over.length) continue;
    const mo = el("mo", op.ch);
    mo.setAttribute("movablelimits", "false");
    const node = over.length && under.length
      ? el("munderover", mo, tightOperators(serialize(build(under, []), null)), tightOperators(serialize(build(over, []), null)))
      : over.length ? el("mover", mo, tightOperators(serialize(build(over, []), null))) : el("munder", mo, tightOperators(serialize(build(under, []), null)));
    pool = pool.filter((a) => a !== op && !under.includes(a) && !over.includes(a));
    const spread = [op, ...under, ...over];
    pool.push({ node, x0: Math.min(...spread.map((a) => a.x0)), x1: Math.max(...spread.map((a) => a.x1)), y: base, size, big: true });
  }
  return pool.sort((a, b) => a.x0 - b.x0);
}

// Turns atoms into a row: base atoms in x order, scripts attached to the atom before them.
function build(glyphs, rules) {
  if (!glyphs.length) return [];
  let atoms = attachAccents(glyphs);
  atoms = applyRules(atoms, rules);
  atoms = takeLimits(atoms);
  const { y: base, size } = baselineOf(atoms);
  const row = [];
  let i = 0;
  while (i < atoms.length) {
    const a = atoms[i];
    const dy = a.y - base;
    if (a.big || a.size >= size * 0.85 || Math.abs(dy) < size * 0.05) {
      if (!a.big && Math.abs(dy) > size * 0.45) fail("同じ大きさの文字が別の行にある");
      row.push(a);
      i++;
      continue;
    }
    // A superscript and a subscript of one symbol overlap in x, so the run is split by height.
    const run = [a];
    let j = i + 1;
    while (j < atoms.length && !atoms[j].big && atoms[j].size < size * 0.85
      && atoms[j].x0 - Math.max(...run.map((r) => r.x1)) < size * 0.5) { run.push(atoms[j]); j++; }
    const top = Math.max(...run.map((r) => r.size));
    const scripts = {};
    let side = null;
    for (const r of run) {
      // nested scripts are smaller and stay with the script they belong to
      if (r.size >= top * 0.85 || !side) side = r.y > base ? "sup" : "sub";
      (scripts[side] ||= []).push(r);
    }
    const target = row.pop();
    const baseNode = target ? single(target) : el("mrow");
    const sub = scripts.sub && tightOperators(serialize(build(scripts.sub, []), null));
    const sup = scripts.sup && tightOperators(serialize(build(scripts.sup, []), null));
    const node = sub && sup ? el("msubsup", baseNode, sub, sup) : sub ? el("msub", baseNode, sub) : el("msup", baseNode, sup);
    const parts = run;
    row.push({
      node, x0: target ? target.x0 : a.x0, x1: Math.max(...parts.map((p) => p.x1)), y: base, size, big: target?.big,
      closes: !!target && !target.node && target.big && CLOSE.includes(target.ch),
    });
    i = j;
  }
  return mergeRuns(row, size);
}

// "log" and "12" drawn as separate glyphs become one token.
function mergeRuns(row, size) {
  const out = [];
  for (const a of row) {
    const p = out[out.length - 1];
    const close = p && a.x0 - p.x1 < size * 0.2;
    if (close && !a.node && !p.node && DIGIT.test(a.ch) && /^[0-9.]+$/.test(p.ch)) {
      out[out.length - 1] = { ...p, ch: p.ch + a.ch, x1: a.x1, number: true };
    } else if (close && !a.node && !p.node && a.upright && p.upright) {
      out[out.length - 1] = { ...p, ch: p.ch + a.ch, x1: a.x1 };
    } else out.push(a);
  }
  return out;
}

function single(a) {
  if (a.node) return a.node;
  if (DIGIT.test(a.ch[0]) && /^[0-9.]+$/.test(a.ch)) return el("mn", a.ch);
  if (a.upright || a.identifier || LETTER.test(a.ch)) {
    const mi = el("mi", a.ch);
    if (a.upright && [...a.ch].length === 1) mi.setAttribute("mathvariant", "normal");
    return mi;
  }
  if (a.ch === "∞" || a.ch === "∇" || a.ch === "∂") return el("mi", a.ch);
  if (a.ch.codePointAt(0) >= 0x1d7ce && a.ch.codePointAt(0) <= 0x1d7ff) return el("mn", a.ch);
  if (a.ch.codePointAt(0) >= 0x1d400) return el("mi", a.ch);
  const mo = el("mo", a.ch);
  const fence = OPEN.includes(a.ch) || CLOSE.includes(a.ch) || a.ch === "∥" || a.ch === "∣" || a.ch === "|" || a.ch === "‖";
  if (fence) {
    mo.setAttribute("stretchy", a.big ? "true" : "false");
    if (!a.big) { mo.setAttribute("lspace", "0"); mo.setAttribute("rspace", "0"); }
  }
  return mo;
}

// TeX puts no medium space around operators in scripts.
function tightOperators(node) {
  if (node.localName === "mo") { node.setAttribute("lspace", "0"); node.setAttribute("rspace", "0"); }
  node.querySelectorAll("mo").forEach((m) => { m.setAttribute("lspace", "0"); m.setAttribute("rspace", "0"); });
  return node;
}

// Big delimiters wrap what they enclose, so that they stretch to it.
function serialize(row, wide) {
  const stack = [[]];
  let prev = null;
  for (const a of row) {
    const gap = prev ? a.x0 - prev.x1 : 0;
    const word = (x) => x.upright && !x.node && [...x.ch].length > 1;
    let space = "";
    if (wide && gap > wide) space = "1em";
    else if (prev && (word(prev) || word(a)) && gap > a.size * 0.12) space = (gap / a.size).toFixed(2) + "em";
    if (space) {
      const sp = el("mspace");
      sp.setAttribute("width", space);
      stack[stack.length - 1].push(sp);
    }
    prev = a;
    if (a.big && !a.node && OPEN.includes(a.ch)) { stack.push([single(a)]); continue; }
    if (a.closes || (a.big && !a.node && CLOSE.includes(a.ch))) {
      if (stack.length < 2) fail("括弧の対応が取れない");
      const inner = stack.pop();
      inner.push(single(a));
      stack[stack.length - 1].push(el("mrow", ...inner));
      continue;
    }
    stack[stack.length - 1].push(single(a));
  }
  if (stack.length > 1) fail("括弧の対応が取れない");
  return stack[0].length === 1 ? stack[0][0] : el("mrow", ...stack[0]);
}

// An equation number set apart at the right edge is not part of the formula.
function splitTag(glyphs) {
  const sorted = [...glyphs].sort((a, b) => a.x0 - b.x0);
  for (let n = 3; n <= 5 && n < sorted.length; n++) {
    const tail = sorted.slice(-n);
    const text = tail.map((g) => g.ch).join("");
    if (!/^\(\d+[a-z]?\)$/.test(text)) continue;
    const head = sorted.slice(0, -n);
    if (tail[0].x0 - Math.max(...head.map((g) => g.x1)) < tail[0].size * 1.5) continue;
    return { glyphs: head, tag: text };
  }
  return { glyphs: sorted, tag: "" };
}

const nearRules = (rules, glyphs) => {
  const x0 = Math.min(...glyphs.map((g) => g.x0)) - 3;
  const x1 = Math.max(...glyphs.map((g) => g.x1)) + 3;
  const hi = Math.max(...glyphs.map((g) => g.y + g.size * (g.big ? 1.2 : 0.9)));
  const lo = Math.min(...glyphs.map((g) => g.y - g.size * (g.big ? 2.6 : 0.3)));
  return (rules || []).filter((r) => r.x0 >= x0 && r.x1 <= x1 && r.y >= lo && r.y <= hi);
};

// Lines of a multi-line display: empty horizontal bands that no fraction bar crosses.
function splitLines(glyphs, rules, size) {
  const spans = glyphs.filter((g) => !g.big && g.ch !== "√").map((g) => ({ lo: g.y - g.size * 0.25, hi: g.y + g.size * 0.75 }));
  for (const g of glyphs) if (g.big && LIMIT_OP.test(g.ch)) spans.push({ lo: g.y - g.size * 2.3, hi: g.y + g.size * 0.6 });
  if (!spans.length) return [glyphs];
  spans.sort((a, b) => b.hi - a.hi);
  const bands = [{ ...spans[0] }];
  for (const s of spans.slice(1)) {
    const cur = bands[bands.length - 1];
    const crossed = rules.some((r) => r.y < cur.lo && r.y > s.hi);
    if (cur.lo - s.hi > size * 0.25 && !crossed) bands.push({ ...s });
    else cur.lo = Math.min(cur.lo, s.lo);
  }
  if (bands.length < 2) return [glyphs];
  const lines = bands.map(() => []);
  for (const g of glyphs) {
    const y = g.big || g.ch === "√" ? g.y - g.size * 1.2 : g.y + g.size * 0.2;
    let best = 0;
    let bestDist = Infinity;
    bands.forEach((b, i) => {
      const dist = y > b.hi ? y - b.hi : y < b.lo ? b.lo - y : 0;
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    lines[best].push(g);
  }
  return lines.filter((l) => l.length);
}

const RELATION = /^[=≤≥≈∼≃≡←→<>]$/;

function relationOf(line, size) {
  const base = baselineOf(line);
  return line.find((g) => RELATION.test(g.ch) && Math.abs(g.y - base.y) < size * 0.2 && g.size >= base.size * 0.85) || null;
}

function mtd(node, align) {
  const cell = el("mtd");
  if (node) cell.appendChild(node);
  cell.style.textAlign = align;
  cell.style.padding = "0";
  return cell;
}

function tableFrom(lines, rules, size) {
  const parsed = lines.map((line) => {
    const { glyphs, tag } = splitTag(line);
    return { glyphs, tag, rel: relationOf(glyphs, size) };
  });
  const withRel = parsed.filter((p) => p.rel);
  const anchor = withRel.length ? withRel[withRel.length - 1].rel.x0 : 0;
  const aligned = withRel.length >= 2 && withRel.every((p) => Math.abs(p.rel.x0 - anchor) < 6);
  const part = (glyphs) => (glyphs.length ? serialize(build(glyphs, nearRules(rules, glyphs)), size * 0.9) : null);
  const table = el("mtable");
  table.style.mathStyle = "normal";
  for (const p of parsed) {
    const row = el("mtr");
    if (aligned && p.rel) {
      const cut = p.rel.x0 - 0.1;
      row.append(mtd(part(p.glyphs.filter((g) => center(g) < cut)), "right"), mtd(part(p.glyphs.filter((g) => center(g) >= cut)), "left"));
    } else if (aligned) {
      row.append(mtd(null, "right"), mtd(part(p.glyphs), "left"));
    } else {
      row.append(mtd(part(p.glyphs), "left"));
    }
    const tagCell = el("mtd");
    tagCell.style.paddingLeft = "2em";
    tagCell.style.textAlign = "right";
    if (p.tag) tagCell.appendChild(el("mtext", p.tag));
    row.append(tagCell);
    table.append(row);
  }
  return table;
}

// items: positioned text pieces of one formula. rules: thin lines of the page.
// Returns { math, tag } or { why } when the formula has to stay an image.
export function mathFrom(items, rules, display) {
  try {
    const all = glyphsFrom(items);
    if (!all.length) fail("文字がない");
    const size = Math.max(...all.filter((g) => !g.big).map((g) => g.size), 1);
    let math;
    let tag = "";
    const lines = display ? splitLines(all, nearRules(rules, all), size) : [all];
    if (lines.length > 1) {
      math = el("math", tableFrom(lines, rules, size));
    } else {
      const split = display ? splitTag(all) : { glyphs: all, tag: "" };
      tag = split.tag;
      if (!split.glyphs.length) fail("文字がない");
      math = el("math", serialize(build(split.glyphs, nearRules(rules, split.glyphs)), display ? size * 0.9 : null));
    }
    if (display) math.setAttribute("display", "block");
    return { math, tag };
  } catch (e) {
    if (e instanceof Unplaced) return { why: e.message };
    return { why: "例外: " + (e?.message || e) };
  }
}
