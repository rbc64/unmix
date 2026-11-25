// Unmix — audio encoder worker (WAV 24-bit / MP3). Keeps exports from freezing the page.
importScripts('./vendor/lamejs/lamejs.iife.js');

function clamp(v) { return v > 1 ? 1 : (v < -1 ? -1 : v); }

function encodeWav24(left, right, sampleRate) {
  const n = left.length, ch = 2, bps = 3;
  const dataLen = n * ch * bps;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * bps, true);
  v.setUint16(32, ch * bps, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, dataLen, true);
  const u8 = new Uint8Array(buf);
  let o = 44;
  const step = Math.max(1, Math.floor(n / 50));
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 2; c++) {
      let s = Math.round(clamp(c ? right[i] : left[i]) * 8388607);
      if (s < 0) s += 0x1000000;
      u8[o++] = s & 255; u8[o++] = (s >> 8) & 255; u8[o++] = (s >> 16) & 255;
    }
    if (i % step === 0) self.postMessage({ type: 'progress', progress: i / n });
  }
  return [u8];
}

function encodeMp3(left, right, sampleRate, kbps) {
  const enc = new lamejs.Mp3Encoder(2, sampleRate, kbps);
  const block = 1152 * 20;
  const l16 = new Int16Array(block), r16 = new Int16Array(block);
  const parts = [];
  const n = left.length;
  for (let i = 0; i < n; i += block) {
    const len = Math.min(block, n - i);
    for (let j = 0; j < len; j++) {
      l16[j] = clamp(left[i + j]) * 32767;
      r16[j] = clamp(right[i + j]) * 32767;
    }
    const out = enc.encodeBuffer(l16.subarray(0, len), r16.subarray(0, len));
    if (out.length) parts.push(new Uint8Array(out));
    self.postMessage({ type: 'progress', progress: i / n });
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return parts;
}

self.onmessage = (ev) => {
  const { id, left, right, sampleRate, format, kbps } = ev.data;
  try {
    const L = new Float32Array(left), R = new Float32Array(right);
    const parts = format === 'mp3' ? encodeMp3(L, R, sampleRate, kbps || 192) : encodeWav24(L, R, sampleRate);
    self.postMessage({ type: 'done', id, parts, mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' }, parts.map(p => p.buffer));
  } catch (e) {
    self.postMessage({ type: 'error', id, message: e && e.message ? e.message : String(e) });
  }
};
