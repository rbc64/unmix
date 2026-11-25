// Unmix — main app: file loading, separation, layer mixer, export.
const SR = 44100;
const LAYERS = [
  { key: 'vocals', name: 'Voice', desc: 'Voiceover, dialogue and singing', color: '--voice', gate: true, file: 'Voice' },
  { key: 'drums', name: 'Drums & hits', desc: 'Drums, percussion and sharp impacts', color: '--drums', file: 'Drums' },
  { key: 'bass', name: 'Bass', desc: 'Bass line and low end', color: '--bass', file: 'Bass' },
  { key: 'other', name: 'Music & background', desc: 'Instruments, pads, ambience and sound effects', color: '--other', file: 'Music and Background' }
];

const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const state = {
  modelReady: false,
  backend: null,
  file: null,
  baseName: 'audio',
  original: null,          // { left, right } at 44.1 kHz
  duration: 0,
  stems: null,             // { vocals: {left,right}, ... } raw model output
  voiceGated: null,        // processed voice when clean-up is on
  gateAmount: 0,
  layer: {},               // key -> { mute, solo, vol, el, canvas, head }
  format: 'wav',
  kbps: 192,
  busy: false
};

/* ---------------- workers ---------------- */
window.__unmixBooted = true;
window.addEventListener('error', (e) => console.error('[Unmix]', e.message));
let sepWorker, encWorker;
try {
  sepWorker = new Worker('./separator-worker.js', { type: 'module' });
  encWorker = new Worker('./encoder-worker.js');
} catch (e) {
  window.__unmixFatal('This browser blocked the Unmix engine.', 'Open Unmix with the Start launcher (address starting with http://localhost). Details: ' + e.message);
  throw e;
}
sepWorker.onerror = (e) => {
  e.preventDefault && e.preventDefault();
  setEngine('Engine failed to start', 'bad');
  $('modelCard').hidden = false;
  $('modelMsg').textContent = 'The separation engine could not start in this browser' + (e.message ? ' (' + e.message + ')' : '') + '. Chrome or Edge work best.';
};
let encJobs = new Map(), encId = 0;

encWorker.onmessage = (ev) => {
  const m = ev.data;
  const job = encJobs.get(m.id) || [...encJobs.values()][0];
  if (!job) return;
  if (m.type === 'progress') job.onProgress && job.onProgress(m.progress);
  else if (m.type === 'done') { encJobs.delete(m.id); job.resolve(new Blob(m.parts, { type: m.mime })); }
  else if (m.type === 'error') { encJobs.delete(m.id); job.reject(new Error(m.message)); }
};
function encode(left, right, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++encId;
    encJobs.set(id, { resolve, reject, onProgress });
    encWorker.postMessage({ id, left, right, sampleRate: SR, format: state.format, kbps: state.kbps });
  });
}

/* ---------------- engine / model ---------------- */
function setEngine(text, cls) {
  $('engineText').textContent = text;
  $('engine').className = 'engine ' + (cls || '');
}
function fmtMB(b) { return (b / 1048576).toFixed(0) + ' MB'; }

sepWorker.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'status':
      setEngine(m.text, 'busy');
      $('modelMsg').textContent = m.text;
      break;
    case 'download': {
      $('modelCard').hidden = false;
      $('modelBar').hidden = false;
      const pct = m.total ? (m.loaded / m.total) * 100 : 0;
      $('modelBar').firstElementChild.style.width = pct + '%';
      const txt = m.total ? `${fmtMB(m.loaded)} of ${fmtMB(m.total)}` : fmtMB(m.loaded);
      $('modelMsg').textContent = (m.source === 'local' ? 'Reading model… ' : 'Downloading model… ') + txt;
      setEngine(m.source === 'local' ? 'Loading model…' : `Downloading model ${pct ? pct.toFixed(0) + '%' : ''}`, 'busy');
      break;
    }
    case 'needModel':
      $('modelCard').hidden = false;
      setEngine('Model needed', 'bad');
      $('btnDownloadModel').disabled = false;
      break;
    case 'ready':
      state.modelReady = true;
      state.backend = m.backend;
      $('modelCard').hidden = true;
      setEngine(m.backend === 'webgpu' ? 'Ready · GPU' : 'Ready · CPU (slower)', 'ok');
      updateSeparateButton();
      break;
    case 'forgotten':
      $('modelMsg').textContent = 'Saved model removed from this browser.';
      break;
    case 'progress':
      onSepProgress(m.progress, m.elapsed);
      break;
    case 'result':
      onSepResult(m.stems, m.seconds, m.backend);
      break;
    case 'error':
      if (m.during === 'separate') {
        state.busy = false;
        $('progressWrap').hidden = true;
        showWarn('Separation failed: ' + m.message + (state.duration > 900 ? ' — the file may be too long for the browser. Try a shorter section.' : ''));
        updateSeparateButton();
        setEngine(state.backend === 'webgpu' ? 'Ready · GPU' : 'Ready · CPU (slower)', 'ok');
      } else {
        $('modelCard').hidden = false;
        $('btnDownloadModel').disabled = false;
        $('modelBar').hidden = true;
        $('modelMsg').textContent = m.message + (navigator.onLine ? '' : ' You seem to be offline — use “Load model file…” or put the model in the models folder.');
        setEngine('Model not loaded', 'bad');
      }
      break;
  }
};

function startEngine(allowDownload) {
  if (location.protocol === 'file:') {
    $('modelCard').hidden = false;
    $('modelCard').querySelector('h2').textContent = 'Please open Unmix with the Start launcher';
    $('modelCard').querySelector('p').textContent = 'Browsers block the AI engine on pages opened directly from a file. Double-click “Start Unmix (Windows).bat” or “Start Unmix (Mac).command” in the Unmix folder instead.';
    $('modelCard').querySelector('.model-actions').hidden = true;
    setEngine('Open via launcher', 'bad');
    return;
  }
  $('btnDownloadModel').disabled = true;
  sepWorker.postMessage({ type: 'init', allowDownload });
}

$('btnDownloadModel').onclick = () => startEngine(true);
$('modelFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $('modelMsg').textContent = 'Reading ' + f.name + '…';
  const buf = await f.arrayBuffer();
  sepWorker.postMessage({ type: 'importModel', buffer: buf }, [buf]);
};
$('btnForget').onclick = () => {
  if (confirm('Remove the saved model from this browser? You will need to download or load it again.')) {
    sepWorker.postMessage({ type: 'forget' });
    state.modelReady = false;
    $('modelCard').hidden = false;
    $('btnDownloadModel').disabled = false;
    setEngine('Model needed', 'bad');
    updateSeparateButton();
  }
};

/* ---------------- file input ---------------- */
let ctx = null;
function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  return ctx;
}

const drop = $('dropZone');
drop.addEventListener('click', (e) => {
  if (drop.classList.contains('has-file')) return;
  $('fileInput').click();
});
drop.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !drop.classList.contains('has-file')) $('fileInput').click(); });
$('btnChange').onclick = (e) => { e.stopPropagation(); if (!state.busy) $('fileInput').click(); };
$('fileInput').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); if (!state.busy) drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
window.addEventListener('drop', (e) => {
  drop.classList.remove('over');
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f && !state.busy) loadFile(f);
});

function showWarn(t) { $('fileWarn').textContent = t; $('fileWarn').hidden = !t; }
function fmtTime(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}

async function loadFile(file) {
  stopPlayback(true);
  showWarn('');
  state.file = file;
  state.baseName = file.name.replace(/\.[^.]+$/, '') || 'audio';
  drop.classList.add('has-file');
  $('dropEmpty').hidden = true;
  $('fileRow').hidden = false;
  $('fileName').textContent = file.name;
  $('fileMeta').textContent = 'Reading audio…';
  $('btnSeparate').disabled = true;
  try {
    const buf = await file.arrayBuffer();
    const ab = await getCtx().decodeAudioData(buf);
    const left = ab.getChannelData(0).slice();
    const right = ab.numberOfChannels > 1 ? ab.getChannelData(1).slice() : left.slice();
    state.original = { left, right };
    state.duration = ab.duration;
    $('fileMeta').textContent = `${fmtTime(ab.duration)} · ${ab.numberOfChannels > 1 ? 'stereo' : 'mono'} · ${(file.size / 1048576).toFixed(1)} MB`;
    if (ab.duration > 20 * 60) showWarn('Long file: over 20 minutes can run out of browser memory. If it fails, split it into shorter parts.');
  } catch (e) {
    state.original = null;
    $('fileMeta').textContent = '';
    showWarn('Could not read the audio in this file. Try MP3, WAV, M4A or MP4 — or export the audio from your editor first.');
  }
  updateSeparateButton();
}

function updateSeparateButton() {
  const b = $('btnSeparate');
  b.disabled = !(state.original && state.modelReady && !state.busy);
  b.title = !state.modelReady ? 'Waiting for the model to load' : '';
}

/* ---------------- separation ---------------- */
let sepStart = 0;
$('btnSeparate').onclick = (e) => {
  e.stopPropagation();
  if (!state.original || !state.modelReady) return;
  state.busy = true;
  updateSeparateButton();
  showWarn('');
  $('results').hidden = true;
  $('progressWrap').hidden = false;
  $('sepFill').style.width = '0%';
  $('sepText').textContent = state.backend === 'webgpu' ? 'Separating on your GPU…' : 'Separating on your CPU (this can take a while)…';
  $('sepEta').textContent = '';
  setEngine('Working…', 'busy');
  sepStart = performance.now();
  const l = state.original.left.slice(), r = state.original.right.slice();
  sepWorker.postMessage({ type: 'separate', left: l.buffer, right: r.buffer }, [l.buffer, r.buffer]);
};

function onSepProgress(p, elapsed) {
  $('sepFill').style.width = (p * 100).toFixed(1) + '%';
  $('sepText').textContent = `Separating… ${(p * 100).toFixed(0)}%`;
  if (p > 0.03) {
    const remain = elapsed / p - elapsed;
    const speed = (state.duration * p) / elapsed;
    $('sepEta').textContent = `about ${fmtTime(remain)} left · ${speed.toFixed(1)}× real-time`;
  }
}

function onSepResult(stems, seconds, backend) {
  state.busy = false;
  state.stems = stems;
  state.voiceGated = null;
  state.gateAmount = 0;
  $('progressWrap').hidden = true;
  setEngine(backend === 'webgpu' ? 'Ready · GPU' : 'Ready · CPU (slower)', 'ok');
  updateSeparateButton();
  $('doneInfo').textContent = `Separated in ${fmtTime(seconds)}`;
  buildLayers();
  $('results').hidden = false;
  $('tDur').textContent = fmtTime(state.duration);
  updateSizeHint();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- voice clean-up gate ---------------- */
function gateThresholdDb(v) { return -62 + v; } // slider 1..40 → -61 … -22 dB
function applyGate(stem, v) {
  if (!v) return null;
  const thr = Math.pow(10, gateThresholdDb(v) / 20);
  const L = stem.left, R = stem.right, n = L.length;
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const envAtt = Math.exp(-1 / (0.001 * SR)), envRel = Math.exp(-1 / (0.040 * SR));
  const gOpen = Math.exp(-1 / (0.004 * SR)), gClose = Math.exp(-1 / (0.090 * SR));
  const hold = Math.round(0.14 * SR);
  const floor = 0.0;
  let env = 0, g = 0, holdCount = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    env = a > env ? envAtt * env + (1 - envAtt) * a : envRel * env + (1 - envRel) * a;
    let target;
    if (env > thr) { holdCount = hold; target = 1; }
    else if (holdCount > 0) { holdCount--; target = 1; }
    else target = floor;
    g = target > g ? gOpen * g + (1 - gOpen) * target : gClose * g + (1 - gClose) * target;
    outL[i] = L[i] * g; outR[i] = R[i] * g;
  }
  return { left: outL, right: outR };
}
function layerData(key) {
  if (key === 'vocals' && state.voiceGated) return state.voiceGated;
  return state.stems[key];
}

/* ---------------- layer UI ---------------- */
function buildLayers() {
  const host = $('layers');
  host.innerHTML = '';
  const tpl = $('layerTpl');
  for (const L of LAYERS) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.swatch').style.background = css(L.color);
    node.querySelector('.nm').textContent = L.name;
    node.querySelector('.layer-desc').textContent = L.desc;
    const st = { mute: false, solo: false, vol: 1, el: node, canvas: node.querySelector('canvas'), head: node.querySelector('.head'), color: css(L.color) };
    state.layer[L.key] = st;
    node.querySelector('.m').onclick = (e) => { st.mute = !st.mute; e.currentTarget.classList.toggle('on', st.mute); applyGains(); };
    node.querySelector('.s').onclick = (e) => { st.solo = !st.solo; e.currentTarget.classList.toggle('on', st.solo); applyGains(); };
    node.querySelector('.vol').oninput = (e) => { st.vol = e.target.value / 100; applyGains(); };
    node.querySelector('.dl').onclick = () => exportLayer(L);
    node.querySelector('.wave').addEventListener('pointerdown', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      seek(((e.clientX - r.left) / r.width) * state.duration);
    });
    if (L.gate) {
      const g = node.querySelector('.gate');
      g.hidden = false;
      const range = g.querySelector('.gateRange'), val = g.querySelector('.gateVal');
      let t = null;
      range.oninput = () => {
        const v = +range.value;
        val.textContent = v ? gateThresholdDb(v) + ' dB' : 'Off';
        clearTimeout(t);
        t = setTimeout(() => {
          state.gateAmount = v;
          state.voiceGated = applyGate(state.stems.vocals, v);
          rebuildBuffer('vocals');
          drawWave('vocals');
        }, 180);
      };
    }
    host.appendChild(node);
  }
  buildBuffers();
  requestAnimationFrame(() => LAYERS.forEach((L) => drawWave(L.key)));
  applyGains();
}

function drawWave(key) {
  const st = state.layer[key];
  const c = st.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(c.clientWidth * dpr)), h = Math.max(1, Math.floor(c.clientHeight * dpr));
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  const d = layerData(key);
  const n = d.left.length;
  const per = Math.max(1, Math.floor(n / w));
  const mins = new Float32Array(w), maxs = new Float32Array(w);
  let peak = 0;
  for (let x = 0; x < w; x++) {
    let lo = 1, hi = -1;
    const s0 = x * per, s1 = Math.min(n, s0 + per);
    const step = per > 2000 ? 4 : 1;
    for (let i = s0; i < s1; i += step) {
      const v = (d.left[i] + d.right[i]) * 0.5;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (lo > hi) { lo = 0; hi = 0; }
    mins[x] = lo; maxs[x] = hi;
    peak = Math.max(peak, -lo, hi);
  }
  const scale = (h / 2 - 2) / Math.max(peak, 0.05);
  g.fillStyle = st.color;
  const mid = h / 2;
  for (let x = 0; x < w; x++) {
    const y0 = mid - maxs[x] * scale, y1 = mid - mins[x] * scale;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}
let resizeT = null;
window.addEventListener('resize', () => {
  if (!state.stems) return;
  clearTimeout(resizeT);
  resizeT = setTimeout(() => LAYERS.forEach((L) => drawWave(L.key)), 200);
});

/* ---------------- playback ---------------- */
let master = null;
const buffers = {}, gains = {};
let sources = [], playing = false, startCtxTime = 0, startOffset = 0, raf = 0;

function toAudioBuffer(d) {
  const ab = getCtx().createBuffer(2, d.left.length, SR);
  ab.copyToChannel(d.left, 0);
  ab.copyToChannel(d.right, 1);
  return ab;
}
function buildBuffers() {
  getCtx();
  for (const L of LAYERS) {
    buffers[L.key] = toAudioBuffer(layerData(L.key));
    if (!gains[L.key]) { gains[L.key] = ctx.createGain(); gains[L.key].connect(master); }
  }
  buffers.original = toAudioBuffer(state.original);
  if (!gains.original) { gains.original = ctx.createGain(); gains.original.connect(master); }
}
function rebuildBuffer(key) {
  buffers[key] = toAudioBuffer(layerData(key));
  if (playing) { const p = position(); startSources(p); }
}
function effectiveGain(key) {
  const anySolo = LAYERS.some((L) => state.layer[L.key].solo);
  const st = state.layer[key];
  if (st.mute) return 0;
  if (anySolo && !st.solo) return 0;
  return st.vol;
}
function applyGains() {
  if (!ctx) return;
  const orig = $('chkOriginal').checked;
  const t = ctx.currentTime;
  for (const L of LAYERS) {
    const gv = orig ? 0 : effectiveGain(L.key);
    gains[L.key].gain.setTargetAtTime(gv, t, 0.015);
    state.layer[L.key].el.classList.toggle('dim', gv === 0);
  }
  if (gains.original) gains.original.gain.setTargetAtTime(orig ? 1 : 0, t, 0.015);
}
$('chkOriginal').onchange = applyGains;

function position() {
  return playing ? Math.min(state.duration, startOffset + (ctx.currentTime - startCtxTime)) : startOffset;
}
function startSources(offset) {
  sources.forEach((s) => { try { s.onended = null; s.stop(); } catch (_) {} });
  sources = [];
  const when = ctx.currentTime + 0.03;
  for (const key of [...LAYERS.map((L) => L.key), 'original']) {
    const s = ctx.createBufferSource();
    s.buffer = buffers[key];
    s.connect(gains[key]);
    s.start(when, offset);
    sources.push(s);
  }
  startCtxTime = when;
  startOffset = offset;
}
function play() {
  if (!state.stems) return;
  getCtx().resume();
  if (startOffset >= state.duration - 0.05) startOffset = 0;
  startSources(startOffset);
  playing = true;
  setPlayIcon();
  tick();
}
function pause() {
  startOffset = position();
  sources.forEach((s) => { try { s.stop(); } catch (_) {} });
  sources = [];
  playing = false;
  setPlayIcon();
  cancelAnimationFrame(raf);
  updateHead();
}
function stopPlayback(reset) {
  if (playing) pause();
  if (reset) startOffset = 0;
  updateHead();
}
function seek(t) {
  t = Math.max(0, Math.min(state.duration, t));
  if (playing) startSources(t); else startOffset = t;
  updateHead();
}
function setPlayIcon() { $('icoPlay').hidden = playing; $('icoPause').hidden = !playing; }
function updateHead() {
  const p = state.duration ? position() / state.duration : 0;
  for (const L of LAYERS) {
    const st = state.layer[L.key];
    if (st && st.head) st.head.style.left = `calc(${(p * 100).toFixed(3)}% - 1px)`;
  }
  $('tNow').textContent = fmtTime(position());
}
function tick() {
  updateHead();
  if (playing && position() >= state.duration - 0.01) { pause(); startOffset = 0; updateHead(); return; }
  if (playing) raf = requestAnimationFrame(tick);
}
$('btnPlay').onclick = () => (playing ? pause() : play());
$('btnStop').onclick = () => stopPlayback(true);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && state.stems && !['INPUT', 'SELECT', 'BUTTON'].includes(document.activeElement.tagName)) {
    e.preventDefault(); playing ? pause() : play();
  }
});

/* ---------------- export ---------------- */
document.querySelectorAll('#fmtSeg button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#fmtSeg button').forEach((x) => x.classList.toggle('on', x === b));
    state.format = b.dataset.fmt;
    $('mp3Rate').disabled = state.format !== 'mp3';
    updateSizeHint();
  };
});
$('mp3Rate').onchange = (e) => { state.kbps = +e.target.value; updateSizeHint(); };

function bytesPerLayer() {
  return state.format === 'mp3' ? state.duration * state.kbps * 125 : state.duration * SR * 2 * 3;
}
function updateSizeHint() {
  if (!state.duration) return;
  const mb = bytesPerLayer() / 1048576;
  $('sizeHint').textContent = `≈ ${mb < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB per layer`;
}
function ext() { return state.format === 'mp3' ? 'mp3' : 'wav'; }
function sumLayers(keys, useMixer) {
  const n = state.original.left.length;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (const k of keys) {
    const g = useMixer ? effectiveGain(k) : 1;
    if (!g) continue;
    const d = layerData(k);
    for (let i = 0; i < n; i++) { l[i] += d.left[i] * g; r[i] += d.right[i] * g; }
  }
  return { left: l, right: r };
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function setExportBusy(on, msg) {
  ['btnAll', 'btnMix', 'btnMusicBed'].forEach((id) => ($(id).disabled = on));
  document.querySelectorAll('.layer .dl').forEach((b) => (b.disabled = on));
  $('exportBar').hidden = !on;
  if (!on) $('exportBar').firstElementChild.style.width = '0%';
  $('exportMsg').textContent = msg || '';
}
function exportProgress(i, total) {
  return (p) => { $('exportBar').firstElementChild.style.width = (((i + p) / total) * 100).toFixed(1) + '%'; };
}
async function runExport(label, items, zipName) {
  setExportBusy(true, `Preparing ${label}…`);
  try {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      $('exportMsg').textContent = `Encoding ${items[i].name}${items.length > 1 ? ` (${i + 1} of ${items.length})` : ''}…`;
      const d = items[i].data();
      const blob = await encode(d.left, d.right, exportProgress(i, items.length));
      out.push({ name: items[i].name, blob });
    }
    if (zipName) {
      $('exportMsg').textContent = 'Packing zip…';
      saveBlob(await makeZip(out), zipName);
    } else saveBlob(out[0].blob, out[0].name);
    setExportBusy(false, `Saved ${zipName || out[0].name}`);
  } catch (e) {
    setExportBusy(false, 'Export failed: ' + e.message);
  }
}
function exportLayer(L) {
  runExport(L.name, [{ name: `${state.baseName} - ${L.file}.${ext()}`, data: () => layerData(L.key) }]);
}
$('btnMusicBed').onclick = () => runExport('music bed', [{
  name: `${state.baseName} - Music Bed (no voice).${ext()}`, data: () => sumLayers(['drums', 'bass', 'other'], false)
}]);
$('btnMix').onclick = () => runExport('current mix', [{
  name: `${state.baseName} - Custom Mix.${ext()}`, data: () => sumLayers(LAYERS.map((L) => L.key), true)
}]);
$('btnAll').onclick = () => {
  const items = LAYERS.map((L, i) => ({ name: `${String(i + 1).padStart(2, '0')} ${state.baseName} - ${L.file}.${ext()}`, data: () => layerData(L.key) }));
  items.push({ name: `05 ${state.baseName} - Music Bed (no voice).${ext()}`, data: () => sumLayers(['drums', 'bass', 'other'], false) });
  runExport('all layers', items, `${state.baseName} - Layers (${ext().toUpperCase()}).zip`);
};

/* ---------------- tiny zip (store, no compression — audio doesn't compress) ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + (p.byteLength || p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

/* ---------------- go ---------------- */
startEngine(false);
