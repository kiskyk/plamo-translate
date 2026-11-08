// Shared by content.js and viewer.js: which text to translate, and how to ask for a translation.
(() => {
  if (globalThis.Plamo) return;

  const JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/g;
  const KANA = /[぀-ヿ]/;

  function shouldTranslate(text, target = "ja") {
    const t = text.trim();
    if (t.length < 2) return false;
    const letters = t.match(/\p{L}/gu);
    if (!letters || letters.length < 2) return false;
    if (!/\s/.test(t) && /[\/_.@=]/.test(t) && t.length > 12) return false; // URL, path, identifier
    const ja = (t.match(JA) || []).length;
    if (target === "ja") return !(KANA.test(t) || ja / letters.length > 0.3);
    return ja > 0;
  }

  // Inside the extension this goes through background.js (queue + cache).
  // Outside (test pages) it calls the server directly.
  const DIRECT_SERVER = "http://127.0.0.1:11437";
  async function translate(text, target, context) {
    if (globalThis.chrome?.runtime?.id) {
      const r = await chrome.runtime.sendMessage({ type: "translate", text, target, context });
      if (!r?.ok) throw new Error(r?.error || "no response");
      return r.text;
    }
    let res;
    try {
      res = await fetch(DIRECT_SERVER + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "plamo",
          messages: [...(context ? [{ role: "system", content: context }] : []), { role: "user", content: text }],
          chat_template_kwargs: { target_lang: target || "ja" }, temperature: 0, max_tokens: 2048,
        }),
      });
    } catch {
      throw new Error("SERVER_DOWN");
    }
    const j = await res.json();
    return (j.choices?.[0]?.message?.content || "").trim();
  }

  const PREFS = { target: "ja", mode: "replace" };
  async function prefs() {
    if (globalThis.chrome?.storage?.sync) return { ...PREFS, ...(await chrome.storage.sync.get(PREFS)) };
    return { ...PREFS, ...(globalThis.__plamoTestPrefs || {}) };
  }
  async function target() {
    return (await prefs()).target;
  }

  globalThis.Plamo = { shouldTranslate, translate, target, prefs };
})();
