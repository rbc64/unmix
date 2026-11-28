// Unmix — transcription worker. Runs Whisper (via Transformers.js) off the main thread.
// Models are stored in the user's chosen models folder, or in this browser's own storage,
// and on the offline (localhost) version they can also be read from Unmix/models/whisper.
// Transformers.js ships gzipped (smaller download) and is unpacked and imported here.
const tjs = await (async () => {
  const r = await fetch(new URL('./vendor/transformers/transformers.min.js.gz', self.location.href));
  if (!r.ok) throw new Error('Transcription engine file missing (vendor/transformers).');
  const code = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).blob();
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try { return await import(url); } finally { URL.revokeObjectURL(url); }
})();
const { pipeline, env } = tjs;
import { MODELS, modelById, dtypeOptions } from './transcript-models.js';
import { TX_SR, planChunks } from './transcript-utils.js';

const HERE = self.location.href;
const HF = 'https://huggingface.co/';
const BROWSER_CACHE = 'unmix-whisper-v1';
const IS_LOCALHOST = ['localhost', '127.0.0.1'].includes(self.location.hostname);
const LOCAL_ROOT = new URL('./models/whisper/', HERE).href;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

/* ---------------- engine setup ---------------- */
env.allowRemoteModels = true;
env.allowLocalModels = IS_LOCALHOST;          // offline version: read Unmix/models/whisper first
env.localModelPath = LOCAL_ROOT;
env.useBrowserCache = false;                  // we provide our own layered storage below
env.useWasmCache = false;
env.useCustomCache = true;

const onnx = env.backends.onnx;
onnx.wasm.wasmPaths = {
  mjs: new URL('./vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs', HERE).href,
  wasm: new URL('./vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm', HERE).href
};
const cores = navigator.hardwareConcurrency || 4;
onnx.wasm.numThreads = self.crossOriginIsolated ? (cores <= 2 ? 4 : Math.min(cores - 1, 8)) : 1;

let engineReady = null;
function loadEngine() {
  // The engine ships gzipped (6.6 MB instead of 27 MB) and is unpacked here, like the separator's.
  if (!engineReady) {
    engineReady = (async () => {
      const r = await fetch(new URL('./vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm.gz', HERE));
      if (!r.ok) throw new Error('Transcription engine file missing (vendor/transformers).');
      const ds = r.body.pipeThrough(new DecompressionStream('gzip'));
      onnx.wasm.wasmBinary = await new Response(ds).arrayBuffer();
    })();
    engineReady.catch(() => { engineReady = null; });
  }
  return engineReady;
}

/* ---------------- device ---------------- */
let device = null; // { kind: 'gpu16' | 'gpu' | 'cpu', vendor, architecture, description, maxBuffer }
async function detectDevice() {
  if (device) return device;
  device = { kind: 'cpu' };
  try {
    if ('gpu' in navigator) {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (a) {
        const info = a.info || {};
        device = {
          kind: a.features.has('shader-f16') ? 'gpu16' : 'gpu',
          vendor: info.vendor || '', architecture: info.architecture || '', description: info.description || '',
          maxBuffer: a.limits ? a.limits.maxBufferSize : 0,
          fallback: !!info.isFallbackAdapter
        };
        if (device.fallback) device = { kind: 'cpu' };
      }
    }
  } catch (_) { device = { kind: 'cpu' }; }
  return device;
}

/* ---------------- storage: models folder → this browser → (download) ---------------- */
let dirHandle = null;          // FileSystemDirectoryHandle chosen by the user (Chrome / Edge)
const memFiles = new Map();    // rel path → File, from "Load models folder…" (any browser, this session only)
const hits = new Map();        // rel path → where it was found during the current load

// Turn a picked file's path (e.g. "whisper/onnx-community/whisper-small_timestamped/onnx/x.onnx")
// into our layout by finding where the model's organisation folder starts.
function relFromPicked(path) {
  const parts = path.split('/');
  for (const m of MODELS) {
    const [org, name] = m.repo.split('/');
    for (let i = 0; i < parts.length - 2; i++) if (parts[i] === org && parts[i + 1] === name) return parts.slice(i).join('/');
  }
  return null;
}

function relFromKey(key) {
  if (typeof key !== 'string') key = key && key.url ? key.url : String(key);
  if (!key.startsWith(HF)) return null;
  const p = decodeURIComponent(new URL(key).pathname).slice(1);
  const i = p.indexOf('/resolve/');
  if (i < 0) return null;
  const rest = p.slice(i + 9);
  return p.slice(0, i) + '/' + rest.slice(rest.indexOf('/') + 1); // drop the revision ("main")
}
function keyFromRel(rel) {
  const parts = rel.split('/');
  return HF + parts.slice(0, 2).join('/') + '/resolve/main/' + parts.slice(2).join('/');
}
async function openBrowserCache() { try { return await caches.open(BROWSER_CACHE); } catch (_) { return null; } }

async function walkDir(rel, create) {
  let d = dirHandle;
  const parts = rel.split('/');
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create });
  return { dir: d, name: parts[parts.length - 1] };
}
async function folderGet(rel) {
  if (!dirHandle) return null;
  try {
    const { dir, name } = await walkDir(rel, false);
    const f = await (await dir.getFileHandle(name)).getFile();
    return f.size > 0 ? f : null;
  } catch (_) { return null; }
}
async function folderPut(rel, blob) {
  const { dir, name } = await walkDir(rel, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

env.customCache = {
  async match(key) {
    const rel = relFromKey(key);
    if (!rel) return undefined;
    const mf = memFiles.get(rel);
    if (mf) {
      hits.set(rel, 'folder');
      return new Response(mf, { headers: { 'content-length': String(mf.size), 'content-type': 'application/octet-stream' } });
    }
    const f = await folderGet(rel);
    if (f) {
      hits.set(rel, 'folder');
      return new Response(f, { headers: { 'content-length': String(f.size), 'content-type': 'application/octet-stream' } });
    }
    const c = await openBrowserCache();
    const r = c && (await c.match(keyFromRel(rel)));
    if (r) { hits.set(rel, 'browser'); return r; }
    return undefined;
  },
  async put(key, response) {
    const rel = relFromKey(key);
    if (!rel) return;
    if (dirHandle) {
      const blob = await response.blob();
      try { await folderPut(rel, blob); return; }
      catch (e) {
        post({ type: 'note', text: 'Could not save to your models folder (' + e.message + '). Saved in this browser instead.' });
        response = new Response(blob, { headers: { 'content-length': String(blob.size) } });
      }
    }
    const c = await openBrowserCache();
    if (c) { try { await c.put(keyFromRel(rel), response); } catch (_) { /* storage full — still usable this session */ } }
  }
};

/* ---------------- what's downloaded where ---------------- */
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4', q4f16: '_q4f16', int8: '_int8', uint8: '_uint8', bnb4: '_bnb4' };
const CONFIG_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];
function weightFiles(dtype) {
  return [`onnx/encoder_model${SUFFIX[dtype.encoder_model]}.onnx`, `onnx/decoder_model_merged${SUFFIX[dtype.decoder_model_merged]}.onnx`];
}
async function whereIs(rel, cache) {
  if (memFiles.has(rel)) return 'loaded';
  if (await folderGet(rel)) return 'folder';
  if (cache && (await cache.match(keyFromRel(rel)))) return 'browser';
  if (IS_LOCALHOST) {
    try { const r = await fetch(LOCAL_ROOT + rel, { method: 'HEAD', cache: 'no-store' }); if (r.ok) return 'local'; } catch (_) {}
  }
  return null;
}
async function modelStatus(m, dtype) {
  const cache = await openBrowserCache();
  const rels = [...CONFIG_FILES, ...weightFiles(dtype)].map((f) => m.repo + '/' + f);
  const places = await Promise.all(rels.map((r) => whereIs(r, cache)));
  const found = places.filter(Boolean);
  if (found.length < rels.length) return { where: found.length ? 'partial' : null };
  const uniq = [...new Set(found)];
  return { where: uniq.length === 1 ? uniq[0] : 'mixed' };
}
async function remoteSize(url) {
  const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
  const cr = r.headers.get('content-range');
  try { await r.body?.cancel(); } catch (_) {}
  const m = cr && cr.match(/\/(\d+)/);
  if (m) return +m[1];
  const cl = r.headers.get('content-length');
  return cl && r.status === 200 ? +cl : 0;
}
async function downloadSize(m, dtype) {
  const sizes = await Promise.all(weightFiles(dtype).map((f) => remoteSize(keyFromRel(m.repo + '/' + f))));
  if (sizes.some((s) => !s)) return 0;
  return sizes.reduce((a, b) => a + b, 0) + 4.5e6; // + tokenizer and config files
}

async function usage() {
  const out = {};
  const cache = await openBrowserCache();
  if (cache) {
    for (const req of await cache.keys()) {
      const rel = relFromKey(req.url);
      if (!rel) continue;
      const repo = rel.split('/').slice(0, 2).join('/');
      const r = await cache.match(req);
      const n = +(r && r.headers.get('content-length')) || 0;
      (out[repo] ||= { browser: 0, folder: 0 }).browser += n;
    }
  }
  if (dirHandle) {
    for (const m of MODELS) {
      const [org, name] = m.repo.split('/');
      try {
        const d = await (await dirHandle.getDirectoryHandle(org)).getDirectoryHandle(name);
        const n = await dirBytes(d);
        if (n) (out[m.repo] ||= { browser: 0, folder: 0 }).folder += n;
      } catch (_) {}
    }
  }
  return out;
}
async function dirBytes(d) {
  let n = 0;
  for await (const h of d.values()) n += h.kind === 'file' ? (await h.getFile()).size : await dirBytes(h);
  return n;
}
async function removeModel(m, where) {
  if (where === 'browser' || where === 'all') {
    const cache = await openBrowserCache();
    if (cache) for (const req of await cache.keys()) if (req.url.startsWith(HF + m.repo + '/')) await cache.delete(req);
  }
  if ((where === 'folder' || where === 'all') && dirHandle) {
    const [org, name] = m.repo.split('/');
    try { await (await dirHandle.getDirectoryHandle(org)).removeEntry(name, { recursive: true }); } catch (_) {}
  }
  if (loaded && loaded.id === m.id) { try { await loaded.pipe.dispose(); } catch (_) {} loaded = null; }
}
// Move everything kept in this browser into the models folder (frees browser storage).
async function migrateToFolder() {
  const cache = await openBrowserCache();
  if (!cache || !dirHandle) return 0;
  let moved = 0;
  const keys = await cache.keys();
  for (let i = 0; i < keys.length; i++) {
    const rel = relFromKey(keys[i].url);
    if (!rel) continue;
    post({ type: 'migrate', done: i, total: keys.length });
    const r = await cache.match(keys[i]);
    if (!(await folderGet(rel))) await folderPut(rel, await r.blob());
    await cache.delete(keys[i]);
    moved++;
  }
  return moved;
}

/* A copy of a browser-stored model as a .zip (stored, not compressed), built from the cached
   files without loading them all into memory. Unzipped, it is a ready-made models folder. */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
async function crcOf(blob) {
  let c = 0xffffffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) c = CRC[(c ^ value[i]) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
async function exportZip(m) {
  const cache = await openBrowserCache();
  const files = [];
  if (cache) for (const req of await cache.keys()) {
    const rel = relFromKey(req.url);
    if (rel && rel.startsWith(m.repo + '/')) files.push({ name: rel, blob: await (await cache.match(req)).blob() });
  }
  if (!files.length) throw new Error('This model is not stored in this browser.');
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    post({ type: 'zipProgress', done: i, total: files.length });
    const f = files[i], name = enc.encode(f.name), crc = await crcOf(f.blob), size = f.blob.size;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, f.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
  }
  const cd = central.reduce((s, p) => s + (p.byteLength || p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cd, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/* ---------------- loading a model ---------------- */
let loaded = null; // { id, dtypeIndex, pipe, kind }
async function loadModel(id, dtypeIndex = 0) {
  const m = modelById(id);
  const dev = await detectDevice();
  if (loaded && loaded.id === id && loaded.kind === dev.kind) return loaded;
  if (loaded) { try { await loaded.pipe.dispose(); } catch (_) {} loaded = null; }
  await loadEngine();
  const files = new Map();
  hits.clear();
  const progress = (p) => {
    if (!p.file) return;
    const rel = m.repo + '/' + p.file;
    const f = files.get(p.file) || { loaded: 0, total: 0 };
    if (p.status === 'progress') { f.loaded = p.loaded || 0; f.total = p.total || f.total; }
    if (p.status === 'done') f.loaded = f.total = Math.max(f.total, f.loaded, 1);
    files.set(p.file, f);
    let loadedB = 0, totalB = 0;
    for (const v of files.values()) { loadedB += v.loaded; totalB += v.total; }
    const big = [...files.entries()].filter(([k]) => k.endsWith('.onnx'));
    const source = big.some(([k]) => !hits.get(m.repo + '/' + k)) ? (IS_LOCALHOST ? 'download-or-local' : 'download')
      : (big.length && big.every(([k]) => hits.get(m.repo + '/' + k) === 'folder') ? 'folder' : 'browser');
    post({ type: 'loadProgress', loaded: loadedB, total: totalB, source, file: p.file, rel });
  };
  // Try each weight format in turn; on a GPU, finish with a CPU attempt in case the card refuses them all.
  const options = dtypeOptions(m, dev.kind);
  const attempts = options.map((dtype) => ({ dtype, device: dev.kind === 'cpu' ? 'wasm' : 'webgpu' }));
  if (dev.kind !== 'cpu') attempts.push({ dtype: options[options.length - 1], device: 'wasm' });
  let lastErr = null;
  for (let i = Math.min(dtypeIndex, attempts.length - 1); i < attempts.length; i++) {
    const { dtype, device: devName } = attempts[i];
    try {
      post({ type: 'loadStart', id, dtype, device: devName });
      const pipe = await pipeline('automatic-speech-recognition', m.repo, { device: devName, dtype, progress_callback: progress });
      loaded = { id, dtypeIndex: i, dtype, pipe, kind: dev.kind, device: devName, wordsBroken: false };
      post({ type: 'loaded', id, dtypeIndex: i, dtype, device: devName });
      return loaded;
    } catch (e) {
      lastErr = e;
      console.warn('[Unmix transcriber] load failed', m.repo, dtype, e);
      post({ type: 'note', text: isMissing(e) ? 'That model format isn’t available, trying another…' : 'The graphics card refused this model, trying a safer setting…' });
    }
  }
  throw lastErr || new Error('Could not load the model.');
}
function isMissing(e) { return /404|not found|Could not locate/i.test(String(e && e.message)); }

/* ---------------- transcription ---------------- */
let stopFlag = false;
async function transcribe({ id, dtypeIndex, audio, language, translate, words }) {
  stopFlag = false;
  const t0 = performance.now();
  const L = await loadModel(id, dtypeIndex);
  const tLoad = performance.now();
  const chunks = planChunks(audio, TX_SR);
  const total = audio.length / TX_SR;
  const opts = { language: language || null, task: translate ? 'translate' : 'transcribe' };
  post({ type: 'txStart', chunks: chunks.length, seconds: total, device: L.device });
  let done = 0, wordsMode = words && !L.wordsBroken;
  for (let i = 0; i < chunks.length; i++) {
    if (stopFlag) break;
    const c = chunks[i];
    if (c.peak >= 0.0035) {
      const slice = audio.subarray(Math.floor(c.start * TX_SR), Math.min(audio.length, Math.ceil(c.end * TX_SR)));
      let out = null;
      if (wordsMode) {
        try { out = await L.pipe(slice, { ...opts, return_timestamps: 'word' }); }
        catch (e) {
          console.warn('[Unmix transcriber] word timing unavailable', e);
          L.wordsBroken = true; wordsMode = false;
          post({ type: 'note', text: 'This model can’t report exact word timings, so word times are estimated from each line.' });
        }
      }
      if (!out) out = await L.pipe(slice, { ...opts, return_timestamps: true });
      const items = (out.chunks || []).map((ch) => {
        const [a, b] = ch.timestamp || [0, null];
        const s = c.start + (a ?? 0), e = c.start + (b ?? (c.end - c.start));
        return { text: ch.text, start: Math.min(s, c.end), end: Math.min(Math.max(e, s + 0.05), c.end) };
      });
      if (!items.length && out.text && out.text.trim()) items.push({ text: out.text, start: c.start, end: c.end });
      post({ type: 'chunk', index: i, kind: wordsMode ? 'words' : 'segments', items, estimatedWords: words && !wordsMode });
    }
    done += c.end - c.start;
    const el = (performance.now() - tLoad) / 1000;
    post({ type: 'txProgress', progress: done / total, elapsed: el, audioDone: done });
  }
  const tEnd = performance.now();
  post({
    type: 'txDone', stopped: stopFlag, loadSeconds: (tLoad - t0) / 1000, workSeconds: (tEnd - tLoad) / 1000,
    audioSeconds: total, device: L.device, dtypeIndex: L.dtypeIndex, wordsReal: words && !L.wordsBroken
  });
}

/* ---------------- messages ---------------- */
self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'init': {
        const dev = await detectDevice();
        post({ type: 'device', device: dev, localhost: IS_LOCALHOST });
        break;
      }
      case 'setFolder':
        dirHandle = m.handle || null;
        post({ type: 'folderSet', name: dirHandle ? dirHandle.name : null });
        break;
      case 'status': {
        const dev = await detectDevice();
        const result = {};
        for (const { id, dtypeIndex } of m.models) {
          const model = modelById(id);
          const opts = dtypeOptions(model, dev.kind);
          const dtype = opts[Math.min(dtypeIndex || 0, opts.length - 1)];
          result[id] = { ...(await modelStatus(model, dtype)), dtype };
        }
        post({ type: 'status', status: result, kind: dev.kind });
        break;
      }
      case 'sizes': {
        const dev = await detectDevice();
        for (const { id, dtypeIndex } of m.models) {
          const model = modelById(id);
          const opts = dtypeOptions(model, dev.kind);
          try {
            const bytes = await downloadSize(model, opts[Math.min(dtypeIndex || 0, opts.length - 1)]);
            if (bytes) post({ type: 'size', id, kind: dev.kind, bytes });
          } catch (_) { /* offline — keep the estimate */ }
        }
        break;
      }
      case 'usage':
        post({ type: 'usage', usage: await usage() });
        break;
      case 'remove':
        await removeModel(modelById(m.id), m.where);
        post({ type: 'removed', id: m.id });
        break;
      case 'migrate': {
        const moved = await migrateToFolder();
        post({ type: 'migrated', moved });
        break;
      }
      case 'memFiles': {
        let n = 0;
        for (const { path, file } of m.files) {
          const rel = relFromPicked(path);
          if (rel) { memFiles.set(rel, file); n++; }
        }
        post({ type: 'memLoaded', count: n });
        break;
      }
      case 'exportZip': {
        const blob = await exportZip(modelById(m.id));
        post({ type: 'zip', id: m.id, blob });
        break;
      }
      case 'transcribe':
        await transcribe({ ...m, audio: new Float32Array(m.audio) });
        break;
      case 'stop':
        stopFlag = true;
        break;
    }
  } catch (e) {
    console.error('[Unmix transcriber]', e);
    post({ type: 'error', during: m.type, message: (e && e.message) || String(e) });
  }
};
post({ type: 'hello' });
