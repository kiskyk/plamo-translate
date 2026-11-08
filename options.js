const DEFAULTS = { server: "http://127.0.0.1:11437", target: "ja", mode: "replace", size: "2b", autoStart: true, idleStopMin: 30 };
const ids = Object.keys(DEFAULTS);

function parse(k, v) {
  if (typeof DEFAULTS[k] === "boolean") return v === "true";
  if (typeof DEFAULTS[k] === "number") return Number.isFinite(Number(v)) && v !== "" ? Math.max(0, Number(v)) : DEFAULTS[k];
  return v.trim() || DEFAULTS[k];
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  for (const k of ids) document.getElementById(k).value = String(s[k]);
});
for (const k of ids) {
  document.getElementById(k).addEventListener("change", async (e) => {
    await chrome.storage.sync.set({ [k]: parse(k, e.target.value) });
    document.getElementById("saved").textContent = "保存したよ";
  });
}
