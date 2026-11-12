// Builds the in-browser engine (wllama = llama.cpp compiled to WebAssembly + WebGPU) into vendor/wllama/.
// Needs git, Node, and a running Docker Desktop. Usage: node tools/wllama/build.mjs [workDir]
// The pinned commits, the patches in ./patches and the artifact layout follow jammaru/sakutto (MIT);
// see tools/wllama/NOTICE.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WLLAMA_REPOSITORY = "https://github.com/ngxson/wllama.git";
const WLLAMA_COMMIT = "d275dac17bc7f190161deb24fd834ce03342e2bc";
const LLAMA_CPP_COMMIT = "5aeac37a35b44fde4bdffaec9159f2fcb253b622";
const EMSDK_TAG = "4.0.20";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const patchDir = join(here, "patches");
const outDir = join(root, "vendor", "wllama");
const work = resolve(process.argv[2] || join(process.env.LOCALAPPDATA || root, "plamo-translate", "wllama-build"));
const src = join(work, "wllama");

const log = (m) => console.log(`[wllama] ${m}`);
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: opts.inherit ? "inherit" : "pipe", ...opts })?.toString().trim();
}
const git = (args, cwd = src) => run("git", ["-c", "core.hooksPath=", "-c", "core.autocrlf=false", "-c", "core.eol=lf", ...args], { cwd });
const npm = (args, env) => run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...args], { cwd: src, inherit: true, env });

// 1. pinned checkout
mkdirSync(src, { recursive: true });
if (!existsSync(join(src, ".git"))) {
  git(["init", "--quiet"]);
  git(["remote", "add", "origin", WLLAMA_REPOSITORY]);
}
git(["config", "core.autocrlf", "false"]);
git(["config", "core.eol", "lf"]);
let head = "";
try { head = git(["rev-parse", "HEAD"]); } catch {}
if (head !== WLLAMA_COMMIT) {
  try { git(["cat-file", "-e", `${WLLAMA_COMMIT}^{commit}`]); } catch {
    log(`fetching ${WLLAMA_COMMIT}`);
    try { git(["fetch", "--depth", "1", "origin", WLLAMA_COMMIT]); } catch { git(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"]); }
  }
  git(["checkout", "--detach", "--force", WLLAMA_COMMIT]);
}
if (!existsSync(join(src, "llama.cpp", ".git"))) {
  log("fetching the llama.cpp submodule");
  try { git(["submodule", "update", "--init", "--recursive", "--depth", "1"]); } catch { git(["submodule", "update", "--init", "--recursive"]); }
}
if (git(["rev-parse", "HEAD"], join(src, "llama.cpp")) !== LLAMA_CPP_COMMIT) throw new Error("llama.cpp submodule is not at the pinned commit");

// 2. reset and patch
git(["checkout", "--", "."], join(src, "llama.cpp"));
git(["reset", "--hard", WLLAMA_COMMIT]);
git(["clean", "-fd", "-e", "node_modules", "-e", "build", "-e", "build-compat", "-e", "esm"]);
for (const name of readdirSync(patchDir).filter((n) => n.endsWith(".patch")).sort()) {
  git(["apply", join(patchDir, name)]);
  log(`applied ${name}`);
}

// 3. library bundle
log("installing wllama build dependencies");
npm(["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], process.env);
npm(["exec", "--", "tsup", "src/index.ts", "--format", "esm", "--clean"], process.env);

// 4. wasm (WebGPU + JSPI only; Chromium 137+ has JSPI, so the asyncify "compat" build is skipped)
log(`building wasm with emscripten/emsdk:${EMSDK_TAG}`);
run("docker", ["compose", "up", "llamacpp-wasm-builder", "--exit-code-from", "llamacpp-wasm-builder"], {
  cwd: join(src, "scripts"), inherit: true,
  env: { ...process.env, EMSDK_IMAGE_TAG: EMSDK_TAG, WLLAMA_TEST_BACKEND: "", SKIP_COMPAT: "1", D_UID: "0", D_GID: "0" },
});
const kernel = join(src, "build", "llama.cpp", "ggml", "src", "CMakeFiles", "ggml-cpu.dir", "ggml-cpu", "arch", "wasm", "quants.c.o");
if (!existsSync(kernel)) throw new Error("the wasm build used ggml's generic CPU kernels (0003 patch not effective)");

// 5. artifacts
const JSPI_STUB = `if (!WebAssembly.Suspending) {
  WebAssembly.Suspending = function (fn) { return fn; };
  WebAssembly.promising = function (fn) {
    return function (...args) { try { return Promise.resolve(fn(...args)); } catch (e) { return Promise.reject(e); } };
  };
}`;
const header = `// SPDX-License-Identifier: MIT
// Generated from ngxson/wllama@${WLLAMA_COMMIT} (MIT) with llama.cpp (MIT) and the Emscripten runtime (MIT).
// Built by tools/wllama/build.mjs. Do not edit.`;
const glue = readFileSync(join(src, "src", "wasm", "wllama.js"), "utf8");
const worker = readFileSync(join(src, "src", "workers-code", "llama-cpp.js"), "utf8");
if ((glue.match(/var Module\b/g) || []).length !== 1) throw new Error("unexpected emscripten glue");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyFileSync(join(src, "esm", "index.js"), join(outDir, "wllama.js"));
copyFileSync(join(src, "src", "wasm", "wllama.wasm"), join(outDir, "wllama.wasm"));
writeFileSync(join(outDir, "wllama-module.js"), `${header}\nfunction wModuleInit() { ${`${JSPI_STUB}\n${glue}`.replace(/var Module\b/, "var ___Module")}; return Module; }\n`);
writeFileSync(join(outDir, "wllama-pthread.js"), `${header}\n${JSPI_STUB}\n${glue}\n`);
writeFileSync(join(outDir, "wllama-worker.js"), `${header}
const RUN_OPTIONS = JSON.parse(new URL(self.location.href).searchParams.get('options') || 'null');
if (!RUN_OPTIONS) throw new Error('the wllama worker was started without run options');
if (RUN_OPTIONS.noWebGPU) {
  try { Object.defineProperty(WorkerNavigator.prototype, 'gpu', { get: () => ({ requestAdapter: async () => null }) }); } catch (e) {}
}
importScripts(RUN_OPTIONS.moduleUrl);
${worker}
`);
const files = {};
for (const name of readdirSync(outDir).sort()) {
  const buf = readFileSync(join(outDir, name));
  files[name] = { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}
const patches = readdirSync(patchDir).filter((n) => n.endsWith(".patch")).sort()
  .map((file) => ({ file, sha256: createHash("sha256").update(readFileSync(join(patchDir, file))).digest("hex") }));
writeFileSync(join(outDir, "wllama-build.json"), JSON.stringify({
  wllama: { repository: WLLAMA_REPOSITORY, commit: WLLAMA_COMMIT }, llamaCpp: { commit: LLAMA_CPP_COMMIT },
  emscripten: `emscripten/emsdk:${EMSDK_TAG}`, features: ["webgpu", "jspi", "memory64"], patches, files,
}, null, 2) + "\n");
for (const [n, f] of Object.entries(files)) log(`${n} ${f.bytes} bytes`);
log("done");
