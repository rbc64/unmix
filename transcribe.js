// Unmix — transcription UI: model picker, model storage, transcript editor and caption export.
import { MODELS, modelById, LANGUAGES } from './transcript-models.js';
import {
  TX_SR, wordsToSegments, estimateWords, retimeWords, cleanSegments, joinBrokenLines,
  buildCues, toSRT, toVTT, toTXT, toJSON, clock
} from './transcript-utils.js';

const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem('unmix.tx.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('unmix.tx.' + k, JSON.stringify(v)); } catch (_) {} }
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = (bytes) => {
  const mb = bytes / 1048576;
  return mb >= 1000 ? (mb / 1024).toFixed(1) + ' GB' : (mb >= 100 ? Math.round(mb / 10) * 10 : Math.round(mb)) + ' MB';
};
const fmtDur = (s) => {
  if (s < 45) return 'under a minute';
  if (s < 90) return '~1 min';
  if (s < 3600) return '~' + Math.round(s / 60) + ' min';
  return '~' + (s / 3600).toFixed(1).replace('.0', '') + ' h';
};

/* ---------------- browser detection (for the storage notice) ---------------- */
function detectBrowser() {
  const ua = navigator.userAgent;
  const mobile = (navigator.userAgentData && navigator.userAgentData.mobile) || /Android|iPhone|iPad|iPod|Mobi/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let key = 'other', name = 'this browser';
  if (/Edg\//.test(ua)) { key = 'chromium'; name = 'Edge'; }
  else if (/Firefox\/|FxiOS/.test(ua)) { key = 'firefox'; name = /LibreWolf/i.test(ua) ? 'LibreWolf' : 'Firefox'; }
  else if (/OPR\//.test(ua)) { key = 'chromium'; name = 'Opera'; }
  else if (/Chrome\/|CriOS/.test(ua)) { key = 'chromium'; name = navigator.brave ? 'Brave' : 'Chrome'; }
  else if (/Safari\//.test(ua)) { key = 'safari'; name = 'Safari'; }
  return { key, name, mobile, folderApi: typeof window.showDirectoryPicker === 'function' };
}

const NOTICE = [
  { key: 'chromium', title: 'Chrome / Edge (recommended)',
    text: 'You can save models to a folder on your computer and reuse them in every session, even after clearing browser data. You’ll only be asked to allow folder access each time.' },
  { key: 'firefox', title: 'Firefox',
    text: 'Models are saved in the browser and reload automatically. Clearing site data removes them. There’s no folder option, but you can load saved model files manually with “Load models folder…”.' },
  { key: 'safari', title: 'Safari',
    text: 'Same as Firefox, but Safari may delete stored data for sites you haven’t visited in a while. For heavy use, keep a copy of the model files (Manage models → Save a copy) and load them with “Load models folder…”.' },
  { key: 'mobile', title: 'Phones and tablets',
    text: 'Stick to Tiny or Base. Larger models may not fit in memory, and mobile browsers clear storage more often.' }
];

/* ---------------- tiny IndexedDB store for the folder handle ---------------- */
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('unmix', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const idbGet = (k) => idb('readonly', (s) => s.get(k)).catch(() => null);
const idbSet = (k, v) => idb('readwrite', (s) => (v == null ? s.delete(k) : s.put(v, k))).catch(() => null);

/* ---------------- audio prep ---------------- */
async function to16kMono(data, srcRate) {
  const n = data.left.length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (data.left[i] + data.right[i]) * 0.5;
  let out;
  try {
    const oc = new OfflineAudioContext(1, Math.ceil((n * TX_SR) / srcRate), TX_SR);
    const b = oc.createBuffer(1, n, srcRate);
    b.copyToChannel(mono, 0);
    const s = oc.createBufferSource();
    s.buffer = b; s.connect(oc.destination); s.start();
    out = (await oc.startRendering()).getChannelData(0).slice();
  } catch (_) {
    // simple fallback: averaging decimation
    const ratio = srcRate / TX_SR, len = Math.floor(n / ratio);
    out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio));
      let s = 0; for (let k = a; k < b; k++) s += mono[k];
      out[i] = s / Math.max(1, b - a);
    }
  }
  // bring quiet recordings up to a healthy level so silence detection works the same for everyone
  let peak = 0;
  for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > peak) peak = v; }
  if (peak > 0) { const g = Math.min(12, 0.9 / peak); if (g > 1.05) for (let i = 0; i < out.length; i++) out[i] *= g; }
  return out;
}

/* ====================================================================== */
export function initTranscriber(api) {
  const browser = detectBrowser();
  const st = {
    device: null, kind: 'cpu', ready: false, localhost: false,
    selected: LS.get('model', null), recommended: null,
    status: {}, sizes: LS.get('sizes', {}), dtypeIdx: LS.get('dtypeIdx', {}), speed: LS.get('speed', {}),
    folder: null, folderPerm: null, memCount: 0,
    src: 'voice', busy: false, phase: '', segments: [], wordsWanted: true, wordsReal: true,
    run: null, audioURL: null, hintResolve: null, usage: {}
  };

  let worker;
  try { worker = new Worker('./transcriber-worker.js', { type: 'module' }); }
  catch (e) { $('txDevice').textContent = 'Transcription is not available in this browser.'; return { onFile() {}, sync() {} }; }
  worker.onerror = (e) => {
    e.preventDefault && e.preventDefault();
    $('txDevice').textContent = 'The transcription engine could not start in this browser. Chrome or Edge work best.';
    setBusy(false);
  };
  const send = (msg, transfer) => worker.postMessage(msg, transfer || []);

  /* ---------- static bits ---------- */
  $('txLang').innerHTML = LANGUAGES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  $('txLang').value = LS.get('lang', '');
  $('txWords').checked = LS.get('words', true);
  $('txTranslate').checked = false;
  $('txLang').onchange = () => LS.set('lang', $('txLang').value);
  $('txWords').onchange = () => { LS.set('words', $('txWords').checked); renderCards(); };
  $('txLine').value = String(LS.get('line', 42));
  $('txLines').value = String(LS.get('lines', 2));
  $('txLine').onchange = () => LS.set('line', +$('txLine').value);
  $('txLines').onchange = () => LS.set('lines', +$('txLines').value);

  document.querySelectorAll('#txSrc button').forEach((b) => {
    b.onclick = () => { st.src = b.dataset.src; syncSrc(); renderCards(); };
  });
  $('btnToTranscript').onclick = (e) => {
    e.stopPropagation();
    $('txCard').hidden = false;
    $('txCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /* ---------- storage notice ---------- */
  function renderNotice() {
    const mine = [browser.key, browser.mobile ? 'mobile' : null];
    const lines = [...NOTICE].sort((a, b) => (mine.includes(b.key) ? 1 : 0) - (mine.includes(a.key) ? 1 : 0));
    $('txNoticeList').innerHTML = lines.map((l) =>
      `<li class="${mine.includes(l.key) ? 'mine' : ''}"><span class="nt"><b>${l.title}</b>${mine.includes(l.key) ? '<span class="badge you">You</span>' : ''}</span>${l.text}</li>`).join('');
    $('txYou').textContent = `You're using ${browser.name}${browser.mobile ? ' on a phone or tablet' : ''}`;
    if (browser.key === 'chromium' && !browser.folderApi) {
      $('txNoticeList').insertAdjacentHTML('afterbegin', `<li class="mine"><span class="nt"><b>${browser.name}</b><span class="badge you">You</span></span>Folder access is switched off in this browser, so models are kept in the browser. Use “Load models folder…” to load files you saved earlier.</li>`);
    }
  }
  renderNotice();
  if (!LS.get('noticeSeen', false)) { $('txNotice').open = true; LS.set('noticeSeen', true); }

  /* ---------- models folder ---------- */
  function renderStore() {
    let text;
    if (st.folder && st.folderPerm === 'granted') text = `Models are saved in your folder <b>“${esc(st.folder.name)}”</b>. They load from there in every session.`;
    else if (st.folder) text = `Your models folder <b>“${esc(st.folder.name)}”</b> needs permission again for this session.`;
    else if (st.memCount) text = `Using ${st.memCount} model files loaded from a folder (this session). New downloads are saved in this browser.`;
    else if (browser.folderApi) text = 'Models are saved in this browser. Choose a models folder to keep them safe outside the browser.';
    else text = 'Models are saved in this browser and reload automatically next time.';
    $('txStoreText').innerHTML = text;
    $('txPickFolder').hidden = !browser.folderApi;
    $('txPickFolder').textContent = st.folder ? 'Change folder…' : 'Choose models folder…';
    $('txAllowFolder').hidden = !(st.folder && st.folderPerm !== 'granted');
    $('txLoadFolderBtn').hidden = browser.folderApi;
  }
  async function restoreFolder() {
    if (!browser.folderApi) return;
    const h = await idbGet('whisperFolder');
    if (!h) return;
    st.folder = h;
    try { st.folderPerm = await h.queryPermission({ mode: 'readwrite' }); } catch (_) { st.folderPerm = 'prompt'; }
    if (st.folderPerm === 'granted') send({ type: 'setFolder', handle: h });
  }
  async function askFolderPermission() {
    if (!st.folder) return false;
    try { st.folderPerm = await st.folder.requestPermission({ mode: 'readwrite' }); } catch (_) { st.folderPerm = 'denied'; }
    if (st.folderPerm === 'granted') { send({ type: 'setFolder', handle: st.folder }); refreshStatus(); }
    renderStore();
    return st.folderPerm === 'granted';
  }
  async function pickFolder() {
    let h;
    try { h = await window.showDirectoryPicker({ id: 'unmix-models', mode: 'readwrite', startIn: 'documents' }); }
    catch (_) { return false; } // cancelled
    st.folder = h; st.folderPerm = 'granted';
    await idbSet('whisperFolder', h);
    send({ type: 'setFolder', handle: h });
    renderStore();
    refreshStatus();
    // offer to move models already kept in the browser
    send({ type: 'usage' });
    const u = await once('usage');
    const inBrowser = Object.values(u.usage).reduce((s, v) => s + v.browser, 0);
    if (inBrowser > 5e6 && confirm(`Move the models already saved in this browser (${fmtSize(inBrowser)}) into “${h.name}”? This frees the browser's storage.`)) {
      flashStore('Moving models into your folder…');
      send({ type: 'migrate' });
      await once('migrated');
      refreshStatus();
      flashStore(null);
    }
    return true;
  }
  function forgetFolder() {
    st.folder = null; st.folderPerm = null;
    idbSet('whisperFolder', null);
    send({ type: 'setFolder', handle: null });
    renderStore(); refreshStatus();
  }
  function flashStore(text) { if (text) $('txStoreText').textContent = text; else renderStore(); }
  $('txPickFolder').onclick = pickFolder;
  $('txAllowFolder').onclick = askFolderPermission;
  $('txLoadFolder').onchange = (e) => {
    const files = [...e.target.files].filter((f) => f.size > 0).map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
    e.target.value = '';
    if (!files.length) return;
    send({ type: 'memFiles', files });
  };

  // wait for one message of a given type from the worker
  const waiters = [];
  function once(type) { return new Promise((resolve) => waiters.push({ type, resolve })); }

  /* ---------- model cards ---------- */
  const kindKey = () => (st.kind === 'cpu' ? 'cpu' : 'gpu');
  function sizeOf(m) {
    const b = st.sizes[m.id + '.' + st.kind];
    return b || m.est[kindKey()] * 1048576;
  }
  function rtfOf(m) {
    const meas = st.speed[m.id + '.' + st.kind];
    return { rtf: meas || m.rtf[kindKey()], measured: !!meas };
  }
  function whereLabel(w) {
    return {
      folder: 'In your models folder ✓', browser: 'Downloaded ✓', local: 'In the Unmix models folder ✓',
      loaded: 'Loaded from folder ✓', mixed: 'Downloaded ✓', partial: 'Partly downloaded'
    }[w] || null;
  }
  function isReady(m) { const w = st.status[m.id] && st.status[m.id].where; return !!w && w !== 'partial'; }
  function estimate(m) {
    const dur = api.duration();
    if (!dur) return null;
    const { rtf, measured } = rtfOf(m);
    const loadS = (sizeOf(m) / 1048576) / (isReady(m) ? 400 : 1e9) + (st.kind === 'cpu' ? 2 : 6);
    return { secs: dur / rtf + loadS, measured };
  }
  function dots(n) { return '<i class="dots">' + [1, 2, 3, 4, 5].map((i) => `<b class="${i <= n ? 'on' : ''}"></b>`).join('') + '</i>'; }

  function renderCards() {
    const host = $('txModels');
    const words = $('txWords').checked;
    host.innerHTML = MODELS.map((m) => {
      const where = st.status[m.id] && st.status[m.id].where;
      const ready = isReady(m);
      const rec = st.recommended === m.id;
      const est = estimate(m);
      const heavy = browser.mobile && (m.id === 'medium' || m.id === 'turbo');
      const speed = st.kind === 'cpu' && m.speed > 1 ? m.speed - 1 : m.speed;
      return `<button class="mcard${st.selected === m.id ? ' on' : ''}" data-id="${m.id}" aria-pressed="${st.selected === m.id}">
        <span class="mtop"><strong>${m.name}</strong>${rec ? '<span class="badge rec">Recommended</span>' : ''}</span>
        <span class="msize ${ready ? 'ok' : ''}">${ready ? whereLabel(where) : (where === 'partial' ? 'Partly downloaded · ' : '') + fmtSize(sizeOf(m)) + ' · downloads once'}</span>
        <span class="meter"><span>Speed</span>${dots(speed)}</span>
        <span class="meter"><span>Accuracy</span>${dots(m.accuracy)}</span>
        <span class="mdesc">${m.blurb}</span>
        ${heavy ? '<span class="mwarn">May not fit in this device’s memory.</span>' : ''}
        <span class="mfoot">
          <span>${words ? (m.words === 'precise' ? 'Word timing: precise' : 'Word timing: estimated') : 'Line timing'}</span>
          <span>${est ? fmtDur(est.secs) + (est.measured ? ' · from your last run' : '') : ''}</span>
        </span>
      </button>`;
    }).join('');
    host.querySelectorAll('.mcard').forEach((c) => {
      c.onclick = () => { st.selected = c.dataset.id; LS.set('model', st.selected); renderCards(); };
    });
    syncGo();
  }

  function recommend() {
    const d = st.device || {};
    if (st.kind === 'cpu') return browser.mobile ? 'tiny' : 'base';
    if (browser.mobile) return 'base';
    const v = `${d.vendor} ${d.architecture} ${d.description}`.toLowerCase();
    const strong = st.kind === 'gpu16' && (/nvidia|apple/.test(v) || (/amd/.test(v) && !/integrated/.test(v)));
    return strong ? 'turbo' : 'small';
  }
  function deviceText() {
    const d = st.device || {};
    if (st.kind === 'cpu') return 'No usable graphics card found, so models run on the processor (slower).';
    const VEND = { nvidia: 'NVIDIA', amd: 'AMD', apple: 'Apple', intel: 'Intel', qualcomm: 'Qualcomm', arm: 'Arm' };
    const name = [VEND[(d.vendor || '').toLowerCase()] || d.vendor, d.architecture].filter(Boolean).join(' ');
    return `Runs on your graphics card${name ? ' (' + name + ')' : ''}.` + (st.kind === 'gpu' ? ' No half-precision support, so the big models use a smaller format.' : '');
  }

  function syncSrc() {
    document.querySelectorAll('#txSrc button').forEach((b) => b.classList.toggle('on', b.dataset.src === st.src));
    let note = '';
    if (st.src === 'voice' && !api.hasStems()) note = api.canSeparate() ? 'Unmix separates the voice first. Takes longer, but music and noise won’t confuse the transcript.' : 'The voice layer isn’t ready yet, so the original audio will be used.';
    if (st.src === 'voice' && api.hasStems()) note = 'Uses the voice layer above, including your clean-up setting.';
    if (st.src === 'original') note = 'Fine for clean recordings. Pick the voice layer if there’s music underneath.';
    $('txSrcNote').textContent = note;
  }

  function syncGo() {
    const m = modelById(st.selected);
    const can = st.ready && !!m && api.duration() > 0 && !st.busy && !api.isBusy();
    $('txGo').disabled = !can;
    const est = m && estimate(m);
    let note = '';
    if (!st.ready) note = 'Starting the transcription engine…';
    else if (!m) note = 'Pick a model above.';
    else if (api.isBusy()) note = 'Waiting for the separation to finish…';
    else {
      note = isReady(m) ? `${m.name} is ready.` : `${m.name} downloads once (${fmtSize(sizeOf(m))}), then works offline.`;
      if (est) note += ` Takes ${fmtDur(est.secs)} for this file${est.measured ? '' : ' (a rough guess until your first run)'}.`;
    }
    $('txGoNote').textContent = note;
    $('txGo').textContent = st.segments.length && !st.busy ? 'Transcribe again' : 'Transcribe';
  }

  function refreshStatus() {
    const models = MODELS.map((m) => ({ id: m.id, dtypeIndex: st.dtypeIdx[m.id + '.' + st.kind] || 0 }));
    send({ type: 'status', models });
  }
  function refreshSizes() {
    if (!navigator.onLine) return;
    const models = MODELS.filter((m) => !st.sizes[m.id + '.' + st.kind]).map((m) => ({ id: m.id, dtypeIndex: st.dtypeIdx[m.id + '.' + st.kind] || 0 }));
    if (models.length) send({ type: 'sizes', models });
  }

  /* ---------- worker messages ---------- */
  let loadStartedAt = 0;
  worker.onmessage = (ev) => {
    const m = ev.data;
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].type === m.type) { waiters[i].resolve(m); waiters.splice(i, 1); }
    switch (m.type) {
      case 'hello': send({ type: 'init' }); break;
      case 'device':
        st.device = m.device; st.kind = m.device.kind; st.localhost = m.localhost; st.ready = true;
        st.recommended = recommend();
        if (!st.selected || !modelById(st.selected)) st.selected = st.recommended;
        $('txDevice').textContent = deviceText();
        if (st.localhost) $('txLocalTip').textContent = ' On this offline version, choose the Unmix › models › whisper folder: then any browser on this computer can load the models, even without folder access.';
        restoreFolder().then(() => { renderStore(); refreshStatus(); refreshSizes(); });
        renderCards();
        break;
      case 'status': st.status = m.status; renderCards(); if ($('txDialog').open) renderDialog(); break;
      case 'size':
        st.sizes[m.id + '.' + m.kind] = m.bytes; LS.set('sizes', st.sizes); renderCards(); break;
      case 'folderSet': break;
      case 'memLoaded':
        st.memCount += m.count;
        renderStore(); refreshStatus();
        if (!m.count) showWarn('No Whisper model files were found in that folder. Pick the folder that contains “onnx-community” (or “Xenova”).');
        break;
      case 'note': if (st.busy) $('txText').textContent = m.text; else showWarn(m.text); break;
      case 'loadStart': loadStartedAt = performance.now(); break;
      case 'loadProgress': onLoadProgress(m); break;
      case 'loaded':
        st.dtypeIdx[st.run.id + '.' + st.kind] = m.dtypeIndex; LS.set('dtypeIdx', st.dtypeIdx);
        $('txText').textContent = 'Model ready. Starting…';
        break;
      case 'txStart':
        st.phase = 'work';
        $('txFill').style.width = '0%';
        $('txText').textContent = `Transcribing on your ${m.device === 'webgpu' ? 'graphics card' : 'processor'}…`;
        break;
      case 'chunk': onChunk(m); break;
      case 'txProgress': onTxProgress(m); break;
      case 'txDone': onTxDone(m); break;
      case 'usage': st.usage = m.usage; if ($('txDialog').open) renderDialog(); break;
      case 'removed': refreshStatus(); send({ type: 'usage' }); break;
      case 'migrate': $('txStoreText').textContent = `Moving models into your folder… ${m.done + 1} of ${m.total} files`; break;
      case 'zipProgress': $('txDlgMsg').textContent = `Preparing the copy… ${m.done + 1} of ${m.total} files`; break;
      case 'zip': {
        const mm = modelById(m.id);
        saveBlob(m.blob, `Unmix model - ${mm.name}.zip`);
        $('txDlgMsg').textContent = 'Saved. Unzip it into a folder you keep, then use “Load models folder…” next time.';
        break;
      }
      case 'error':
        if (m.during === 'transcribe') {
          setBusy(false);
          $('txProg').hidden = true;
          showWarn(/Could not locate|404|Failed to fetch|NetworkError|network/i.test(m.message)
            ? 'Couldn’t download the model files. Check your internet connection and try again. (' + m.message + ')'
            : 'Transcription failed: ' + m.message + (/memory|alloc|OOM|buffer/i.test(m.message) ? ' This model may be too big for this device: try a smaller one.' : ''));
          refreshStatus();
        } else if (m.during === 'exportZip') {
          $('txDlgMsg').textContent = m.message;
        } else console.warn('[Unmix transcriber]', m.during, m.message);
        break;
    }
  };

  /* ---------- running ---------- */
  function showWarn(t) { $('txWarn').textContent = t || ''; $('txWarn').hidden = !t; }
  function setBusy(on) {
    st.busy = on;
    $('txSetup').classList.toggle('locked', on);
    api.onTxBusy && api.onTxBusy(on);
    syncGo();
  }

  function onLoadProgress(m) {
    const name = modelById(st.run.id).name;
    const pct = m.total ? m.loaded / m.total : 0;
    $('txFill').style.width = (pct * 100).toFixed(1) + '%';
    if (m.source === 'download' || m.source === 'download-or-local') {
      $('txText').textContent = `Downloading ${name} (one time only)… ${fmtSize(m.loaded)} of ${fmtSize(Math.max(m.total, sizeOf(modelById(st.run.id))))}`;
    } else {
      $('txText').textContent = `Loading ${name} from ${m.source === 'folder' ? 'your models folder' : 'this browser'}…`;
    }
    if (pct >= 0.999) $('txText').textContent = `Preparing ${name}${st.kind === 'cpu' ? '' : ' on your graphics card'} (the first run can take a minute)…`;
  }

  function onChunk(m) {
    let segs;
    if (m.kind === 'words') {
      const words = m.items.map((w) => ({ word: w.text.trim(), start: w.start, end: w.end })).filter((w) => w.word);
      segs = wordsToSegments(words);
    } else {
      segs = m.items.map((it) => {
        const text = it.text.trim();
        return { start: it.start, end: it.end, text, words: st.wordsWanted ? estimateWords(text, it.start, it.end) : null };
      });
      if (m.estimatedWords) st.wordsReal = false;
    }
    segs = cleanSegments(segs);
    for (const s of segs) { st.segments.push(s); appendSeg(s, st.segments.length - 1); }
    $('txResult').hidden = false;
    $('txCount').textContent = `${st.segments.length} line${st.segments.length === 1 ? '' : 's'}`;
  }

  function onTxProgress(m) {
    $('txFill').style.width = (m.progress * 100).toFixed(1) + '%';
    $('txText').textContent = `Transcribing… ${(m.progress * 100).toFixed(0)}%`;
    if (m.progress > 0.04 && m.elapsed > 1) {
      const remain = m.elapsed / m.progress - m.elapsed;
      $('txEta').textContent = `about ${clock(remain)} left · ${(m.audioDone / m.elapsed).toFixed(1)}× real-time`;
    }
  }

  function onTxDone(m) {
    setBusy(false);
    $('txProg').hidden = true;
    st.segments = joinBrokenLines(cleanSegments(st.segments));
    renderSegs();
    if (!m.stopped && m.workSeconds > 2) {
      st.speed[st.run.id + '.' + st.kind] = m.audioSeconds / m.workSeconds;
      LS.set('speed', st.speed);
    }
    st.wordsReal = st.wordsReal && m.wordsReal;
    const mm = modelById(st.run.id);
    $('txInfo').textContent = `${mm.name} · ${m.device === 'webgpu' ? 'GPU' : 'CPU'} · ${clock(m.workSeconds + m.loadSeconds)}` +
      (st.wordsWanted ? ` · word timing ${st.wordsReal ? 'measured' : 'estimated'}` : '');
    if (m.stopped) showWarn('Stopped. The lines done so far are below.');
    else if (!st.segments.length) showWarn('No speech was found. If there is speech, try the original audio, a bigger model, or set the language.');
    refreshStatus();
    renderCards();
    $('txResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function start() {
    const m = modelById(st.selected);
    if (!m || st.busy) return;
    showWarn('');
    if (st.segments.some((s) => s.edited) && !confirm('Start a new transcript? Your edits to the current one will be replaced.')) return;

    // 1) folder permission (needs this click) and the one-time folder hint
    if (st.folder && st.folderPerm !== 'granted') await askFolderPermission();
    if (!isReady(m) && browser.folderApi && !st.folder && !LS.get('hintNever', false)) {
      const choice = await showHint(m);
      if (choice === 'cancel') return;
      if (choice === 'folder' && !(await pickFolder())) return;
    }
    if (!isReady(m) && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    st.run = { id: m.id };
    st.wordsWanted = $('txWords').checked;
    st.wordsReal = true;
    setBusy(true);
    $('txProg').hidden = false;
    $('txFill').style.width = '0%';
    $('txEta').textContent = '';
    st.segments = [];
    $('txSegs').innerHTML = '';
    $('txResult').hidden = true;

    // 2) the audio: voice layer (separating first if needed) or the original
    let data = null;
    if (st.src === 'voice') {
      if (!api.hasStems() && api.canSeparate()) {
        $('txText').textContent = 'Separating the voice first (see progress above)…';
        try { await api.separate(); } catch (e) { setBusy(false); $('txProg').hidden = true; showWarn('Separation failed, so nothing was transcribed: ' + e.message); return; }
      }
      data = api.getVoice();
      if (!data) showWarn('Using the original audio, because the voice layer isn’t available.');
    }
    if (!data) data = api.getOriginal();
    if (!data) { setBusy(false); $('txProg').hidden = true; return; }

    $('txText').textContent = 'Preparing audio…';
    const audio = await to16kMono(data, api.sampleRate());
    st.phase = 'load';
    $('txText').textContent = `Loading ${m.name}…`;
    send({
      type: 'transcribe', id: m.id, dtypeIndex: st.dtypeIdx[m.id + '.' + st.kind] || 0, audio: audio.buffer,
      language: $('txLang').value, translate: $('txTranslate').checked, words: st.wordsWanted
    }, [audio.buffer]);
  }
  $('txGo').onclick = start;
  $('txStop').onclick = () => { send({ type: 'stop' }); $('txText').textContent = 'Stopping after the current part…'; };

  function showHint(m) {
    $('txHintText').innerHTML = `<b>${m.name}</b> downloads once (${fmtSize(sizeOf(m))}). You're on ${esc(browser.name)}: pick a models folder first so you never download it again, even after clearing browser data. Tip: a folder like Documents › Unmix models.`;
    $('txHint').hidden = false;
    $('txGo').disabled = true;
    $('txHint').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return new Promise((resolve) => {
      const done = (v) => {
        if ($('txHintNever').checked) LS.set('hintNever', true);
        $('txHint').hidden = true; syncGo(); resolve(v);
      };
      $('txHintFolder').onclick = () => done('folder');
      $('txHintBrowser').onclick = () => done('browser');
    });
  }

  /* ---------- transcript editor ---------- */
  function segRow(s, i) {
    const row = document.createElement('div');
    row.className = 'srow';
    row.dataset.i = i;
    row.innerHTML = `<button class="ts" title="Jump here">${clock(s.start)}</button><div class="stext" spellcheck="true"></div>`;
    const t = row.querySelector('.stext');
    t.textContent = s.text;
    t.contentEditable = 'plaintext-only';
    if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    t.addEventListener('input', () => { s.text = t.textContent.replace(/\s+/g, ' ').trim(); s.edited = true; });
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } });
    row.querySelector('.ts').onclick = () => jump(s.start);
    return row;
  }
  function appendSeg(s, i) { $('txSegs').appendChild(segRow(s, i)); }
  function renderSegs() {
    const host = $('txSegs');
    host.innerHTML = '';
    st.segments.forEach((s, i) => host.appendChild(segRow(s, i)));
    $('txCount').textContent = `${st.segments.length} line${st.segments.length === 1 ? '' : 's'}`;
    $('txResult').hidden = !st.segments.length;
    syncPlayer();
  }

  /* ---------- playback & highlight ---------- */
  const audioEl = $('txAudio');
  function syncPlayer() { $('txPlayer').hidden = api.hasStems() || !st.audioURL; }
  function jump(t) {
    if (api.hasStems()) { audioEl.pause(); api.seekPlay(t); }
    else if (st.audioURL) { audioEl.currentTime = t; audioEl.play().catch(() => {}); }
  }
  let lastActive = -1;
  function tick() {
    requestAnimationFrame(tick);
    if ($('txResult').hidden || !st.segments.length) return;
    let t = null;
    if (!audioEl.paused) t = audioEl.currentTime;
    else if (api.isPlaying()) t = api.position();
    if (t == null) return;
    let idx = -1;
    for (let i = 0; i < st.segments.length; i++) {
      if (st.segments[i].start <= t + 0.05) idx = i; else break;
    }
    if (idx >= 0 && t > st.segments[idx].end + 1.5) idx = -1;
    if (idx === lastActive) return;
    const host = $('txSegs');
    const prev = host.querySelector('.srow.now');
    if (prev) prev.classList.remove('now');
    lastActive = idx;
    if (idx < 0) return;
    const row = host.children[idx];
    if (!row) return;
    row.classList.add('now');
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#txSegs')) return; // don't scroll while editing
    const top = row.offsetTop - host.offsetTop;
    if (top < host.scrollTop || top > host.scrollTop + host.clientHeight - row.clientHeight) host.scrollTop = top - host.clientHeight / 3;
  }
  requestAnimationFrame(tick);

  /* ---------- export ---------- */
  function finalSegments() {
    return st.segments.filter((s) => s.text).map((s) => {
      if (!s.edited) return s;
      return { ...s, words: s.words && s.words.length ? retimeWords(s) : estimateWords(s.text, s.start, s.end) };
    });
  }
  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  function saveText(text, name, type) {
    saveBlob(new Blob([text], { type: type + ';charset=utf-8' }), name);
    $('txExportMsg').textContent = 'Saved ' + name;
  }
  const cueOpts = () => ({ maxChars: +$('txLine').value, maxLines: +$('txLines').value });
  $('txSrt').onclick = () => saveText(toSRT(buildCues(finalSegments(), cueOpts())), `${api.baseName()}.srt`, 'application/x-subrip');
  $('txVtt').onclick = () => saveText(toVTT(buildCues(finalSegments(), cueOpts())), `${api.baseName()}.vtt`, 'text/vtt');
  $('txTxt').onclick = () => saveText(toTXT(finalSegments()), `${api.baseName()} - transcript.txt`, 'text/plain');
  $('txJson').onclick = () => {
    const m = modelById(st.run ? st.run.id : st.selected);
    saveText(toJSON(finalSegments(), {
      app: 'Unmix', file: api.fileName(), model: m ? 'Whisper ' + m.name : '', language: $('txLang').value || 'auto',
      wordTiming: st.wordsWanted && st.wordsReal ? 'measured' : 'estimated', created: new Date().toISOString()
    }), `${api.baseName()} - word timings.json`, 'application/json');
  };
  $('txCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(toTXT(finalSegments(), false)); $('txExportMsg').textContent = 'Transcript copied.'; }
    catch (_) { $('txExportMsg').textContent = 'Copy was blocked by the browser. Use TXT instead.'; }
  };

  /* ---------- manage models dialog ---------- */
  $('txManage').onclick = () => { renderDialog(); $('txDialog').showModal(); send({ type: 'usage' }); refreshStatus(); };
  $('txDlgClose').onclick = () => $('txDialog').close();
  $('txDialog').addEventListener('click', (e) => { if (e.target === $('txDialog')) $('txDialog').close(); });

  async function renderDialog() {
    const u = st.usage || {};
    $('txDlgList').innerHTML = MODELS.map((m) => {
      const x = u[m.repo] || { browser: 0, folder: 0 };
      const w = st.status[m.id] && st.status[m.id].where;
      const parts = [];
      if (x.folder) parts.push(`<span>Models folder: ${fmtSize(x.folder)} <button class="linkbtn" data-act="del-folder" data-id="${m.id}">Delete</button></span>`);
      if (x.browser) parts.push(`<span>This browser: ${fmtSize(x.browser)} <button class="linkbtn" data-act="del-browser" data-id="${m.id}">Delete</button> · <button class="linkbtn" data-act="zip" data-id="${m.id}">Save a copy (.zip)</button></span>`);
      if (w === 'local') parts.push('<span>In the Unmix models folder on this computer</span>');
      if (w === 'loaded') parts.push('<span>Loaded from a folder for this session</span>');
      return `<div class="dlg-row"><strong>${m.name}</strong><span class="muted small">${parts.length ? parts.join('') : 'Not downloaded · ' + fmtSize(sizeOf(m))}</span></div>`;
    }).join('');
    $('txDlgList').querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = () => {
        const m = modelById(b.dataset.id);
        if (b.dataset.act === 'zip') { $('txDlgMsg').textContent = 'Preparing the copy…'; send({ type: 'exportZip', id: m.id }); return; }
        const where = b.dataset.act === 'del-folder' ? 'folder' : 'browser';
        if (confirm(`Delete ${m.name} from ${where === 'folder' ? 'your models folder' : 'this browser'}? You can download it again any time.`)) send({ type: 'remove', id: m.id, where });
      };
    });

    const inBrowser = Object.values(u).reduce((s, v) => s + v.browser, 0);
    let f = '<h3>Models folder</h3>';
    if (browser.folderApi) {
      if (st.folder) {
        f += `<p>Saving to <b>“${esc(st.folder.name)}”</b>${st.folderPerm === 'granted' ? '' : ' (needs permission this session)'}.</p>
          <div class="dlg-actions"><button class="btn ghost sm" data-f="change">Change folder…</button><button class="btn ghost sm" data-f="forget">Stop using this folder</button>
          ${inBrowser > 5e6 && st.folderPerm === 'granted' ? `<button class="btn ghost sm" data-f="move">Move browser models into the folder (${fmtSize(inBrowser)})</button>` : ''}</div>`;
      } else {
        f += `<p>Keep models in a folder on your computer so they survive clearing browser data, and can be shared with the offline version.</p>
          <div class="dlg-actions"><button class="btn ghost sm" data-f="change">Choose models folder…</button></div>`;
      }
    } else {
      f += `<p>${esc(browser.name)} can’t save into folders, so downloads are kept in the browser. To use model files you saved before, load their folder each session.</p>
        <div class="dlg-actions"><button class="btn ghost sm" data-f="load">Load models folder…</button></div>`;
    }
    $('txDlgFolder').innerHTML = f;
    $('txDlgFolder').querySelectorAll('button[data-f]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.f === 'change') { await pickFolder(); send({ type: 'usage' }); }
        if (b.dataset.f === 'forget') forgetFolder();
        if (b.dataset.f === 'move') { send({ type: 'migrate' }); await once('migrated'); refreshStatus(); send({ type: 'usage' }); renderStore(); }
        if (b.dataset.f === 'load') $('txLoadFolder').click();
        renderDialog();
      };
    });

    let s = '<h3>Browser storage</h3>';
    try {
      const [est, persisted] = await Promise.all([
        navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : null,
        navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : false
      ]);
      if (est) s += `<p>Unmix is using ${fmtSize(est.usage || 0)} of this browser's storage (about ${fmtSize(est.quota || 0)} allowed).</p>`;
      s += persisted
        ? '<p>✓ Protected: the browser won’t clear it automatically when space runs low.</p>'
        : '<p>Not protected: the browser may clear it when space runs low. <button class="linkbtn" id="txPersist">Ask the browser to keep it</button></p>';
    } catch (_) {}
    $('txDlgStorage').innerHTML = s;
    const p = $('txPersist');
    if (p) p.onclick = async () => {
      const ok = await navigator.storage.persist().catch(() => false);
      $('txDlgMsg').textContent = ok ? 'Done: storage is now protected.' : 'The browser declined. Chrome usually agrees once you use the site more, or after you bookmark or install it.';
      renderDialog();
    };
  }

  /* ---------- hooks from the main app ---------- */
  return {
    onFile(file) {
      $('txCard').hidden = false;
      if (st.audioURL) URL.revokeObjectURL(st.audioURL);
      st.audioURL = file ? URL.createObjectURL(file) : null;
      audioEl.src = st.audioURL || '';
      st.segments = [];
      $('txSegs').innerHTML = '';
      $('txResult').hidden = true;
      showWarn('');
      syncSrc(); syncPlayer(); renderCards();
    },
    sync() { syncSrc(); syncPlayer(); syncGo(); },
    isBusy: () => st.busy
  };
}
