// Unmix — separation worker. Runs the Demucs model off the main thread so the UI stays smooth.
import * as ort from './vendor/ort/ort.webgpu.bundle.min.mjs';
import { DemucsProcessor } from './vendor/demucs/processor.js';

const MODEL_FILE = 'htdemucs_embedded.onnx';
const LOCAL_URL = new URL('./models/' + MODEL_FILE, self.location.href).href;
const REMOTE_URL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/' + MODEL_FILE;
const CACHE_NAME = 'unmix-models-v1';
const CACHE_KEY = LOCAL_URL; // one canonical key, wherever the model came from

ort.env.wasm.wasmPaths = new URL('./vendor/ort/', self.location.href).href;
// Privacy browsers (LibreWolf, Brave) often under-report CPU cores, so never go below 4 threads.
const reportedCores = navigator.hardwareConcurrency || 4;
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? (reportedCores <= 2 ? 4 : Math.min(reportedCores - 1, 8))
  : 1;

let processor = null;
let backend = 'cpu';

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const status = (text) => post({ type: 'status', text });

async function detectBackend() {
  try {
    if ('gpu' in navigator) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) return 'webgpu';
    }
  } catch (_) { /* fall through */ }
  return 'cpu';
}

async function readWithProgress(response, source) {
  const total = parseInt(response.headers.get('Content-Length') || '0', 10);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    post({ type: 'download', loaded, total, source });
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function getCache() {
  try { return await caches.open(CACHE_NAME); } catch (_) { return null; }
}

async function findModel({ allowDownload }) {
  // 1) A model file sitting in the app's models/ folder (fully offline)
  try {
    const r = await fetch(LOCAL_URL, { cache: 'no-store' });
    if (r.ok && (parseInt(r.headers.get('Content-Length') || '0', 10) > 1e6 || !r.headers.get('Content-Length'))) {
      status('Loading model from the models folder…');
      const bytes = await readWithProgress(r, 'local');
      if (bytes.length > 1e6) return { bytes, source: 'models folder' };
    }
  } catch (_) { /* not there */ }

  // 2) A copy this browser saved earlier
  const cache = await getCache();
  if (cache) {
    const hit = await cache.match(CACHE_KEY);
    if (hit) {
      status('Loading saved model…');
      return { bytes: new Uint8Array(await hit.arrayBuffer()), source: 'browser storage' };
    }
  }

  // 3) Download once from Hugging Face, then keep it
  if (!allowDownload) return null;
  status('Downloading model (one time only)…');
  const r = await fetch(REMOTE_URL, { mode: 'cors' });
  if (!r.ok) throw new Error('Model download failed (HTTP ' + r.status + ').');
  const bytes = await readWithProgress(r, 'remote');
  if (cache) {
    try {
      await cache.put(CACHE_KEY, new Response(bytes, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) }
      }));
    } catch (_) { /* storage full or blocked — still usable this session */ }
  }
  return { bytes, source: 'download' };
}

// The engine ships gzipped (7 MB instead of 29 MB) and is unpacked here.
let engineLoaded = false;
async function loadEngine() {
  if (engineLoaded) return;
  const r = await fetch(new URL('./vendor/ort/ort-wasm-simd-threaded.asyncify.wasm.gz', self.location.href));
  if (!r.ok) throw new Error('Engine file missing (vendor/ort).');
  const ds = r.body.pipeThrough(new DecompressionStream('gzip'));
  ort.env.wasm.wasmBinary = await new Response(ds).arrayBuffer();
  engineLoaded = true;
}

async function createSession(bytes) {
  await loadEngine();
  backend = await detectBackend();
  processor = new DemucsProcessor({
    ort,
    sessionOptions: {
      executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'basic'
    }
  });
  status(backend === 'webgpu' ? 'Starting the GPU engine…' : 'Starting the CPU engine (no GPU found — slower)…');
  // copy into a standalone ArrayBuffer for ORT
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer : bytes.slice().buffer;
  try {
    await processor.loadModel(buf);
  } catch (e) {
    if (backend === 'webgpu') {
      // Some GPUs/drivers reject the model — retry on CPU
      backend = 'cpu';
      processor = new DemucsProcessor({ ort, sessionOptions: { executionProviders: ['wasm'], graphOptimizationLevel: 'basic' } });
      status('GPU engine failed, switching to CPU…');
      await processor.loadModel(bytes.slice().buffer);
    } else throw e;
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      const found = await findModel({ allowDownload: !!msg.allowDownload });
      if (!found) { post({ type: 'needModel' }); return; }
      await createSession(found.bytes);
      post({ type: 'ready', backend, source: found.source, threads: ort.env.wasm.numThreads });
    }

    else if (msg.type === 'importModel') {
      const bytes = new Uint8Array(msg.buffer);
      if (bytes.length < 1e6) throw new Error('That file is too small to be the model.');
      const cache = await getCache();
      if (cache) {
        try { await cache.put(CACHE_KEY, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (_) {}
      }
      await createSession(bytes);
      post({ type: 'ready', backend, source: 'imported file', threads: ort.env.wasm.numThreads });
    }

    else if (msg.type === 'forget') {
      const cache = await getCache();
      if (cache) await cache.delete(CACHE_KEY);
      post({ type: 'forgotten' });
    }

    else if (msg.type === 'separate') {
      if (!processor) throw new Error('The model is not loaded yet.');
      const left = new Float32Array(msg.left);
      const right = new Float32Array(msg.right);
      const t0 = performance.now();
      processor.onProgress = ({ progress }) => {
        post({ type: 'progress', progress: Math.min(1, progress), elapsed: (performance.now() - t0) / 1000 });
      };
      const r = await processor.separate(left, right);
      const out = {};
      const transfer = [];
      for (const k of ['vocals', 'drums', 'bass', 'other']) {
        out[k] = { left: r[k].left, right: r[k].right };
        transfer.push(r[k].left.buffer, r[k].right.buffer);
      }
      post({ type: 'result', stems: out, seconds: (performance.now() - t0) / 1000, backend }, transfer);
    }
  } catch (e) {
    post({ type: 'error', message: (e && e.message) ? e.message : String(e), during: msg.type });
  }
};
