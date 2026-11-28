// Unmix — transcript helpers shared by the page and the transcription worker.
// Pure functions only (no DOM), so they also run in tests.

export const TX_SR = 16000;

/* ---------- planning chunks ----------
   Whisper listens to at most 30 s at a time. We cut the audio into pieces of up to ~29 s,
   choosing the quietest moment near each cut so words are not split in half. */
export function planChunks(audio, sr = TX_SR, { maxLen = 29, minLen = 18 } = {}) {
  const frame = Math.round(sr * 0.02);                 // 20 ms frames
  const nFrames = Math.ceil(audio.length / frame);
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    const a = f * frame, b = Math.min(audio.length, a + frame);
    for (let i = a; i < b; i++) s += audio[i] * audio[i];
    rms[f] = Math.sqrt(s / Math.max(1, b - a));
  }
  const win = 15; // smooth over 300 ms when looking for a pause
  const smooth = (f) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, f - win); k <= Math.min(nFrames - 1, f + win); k++) { s += rms[k]; n++; }
    return s / n;
  };
  const chunks = [];
  const totalSec = audio.length / sr;
  let start = 0;
  while (start < totalSec - 0.05) {
    if (totalSec - start <= maxLen) { chunks.push([start, totalSec]); break; }
    const f0 = Math.floor((start + minLen) / 0.02), f1 = Math.floor((start + maxLen) / 0.02);
    let best = f1, bestV = Infinity;
    for (let f = f0; f <= f1; f += 2) {
      const v = smooth(f);
      if (v < bestV) { bestV = v; best = f; }
    }
    const end = Math.min(totalSec, best * 0.02);
    chunks.push([start, end]);
    start = end;
  }
  // loudness of each chunk, so silent pieces can be skipped (Whisper invents words in silence)
  return chunks.map(([s, e]) => {
    let peak = 0;
    for (let f = Math.floor(s / 0.02); f < Math.min(nFrames, Math.ceil(e / 0.02)); f++) peak = Math.max(peak, rms[f]);
    return { start: s, end: e, peak };
  });
}

/* ---------- words -> segments ---------- */
const SENT_END = /[.!?…。！？]["')\]]?$/;
export function wordsToSegments(words, { maxChars = 90, maxGap = 0.8, maxDur = 9 } = {}) {
  const segs = [];
  let cur = null;
  for (const w of words) {
    const text = w.word.trim();
    if (!text) continue;
    if (cur) {
      const gap = w.start - cur.end;
      const len = cur.text.length + 1 + text.length;
      if (gap > maxGap || len > maxChars || w.end - cur.start > maxDur || SENT_END.test(cur.text)) {
        segs.push(cur); cur = null;
      }
    }
    if (!cur) cur = { start: w.start, end: w.end, text: text, words: [] };
    else { cur.text += ' ' + text; cur.end = w.end; }
    cur.words.push({ word: text, start: w.start, end: w.end });
  }
  if (cur) segs.push(cur);
  return segs;
}

/* Estimate word times inside a segment, in proportion to word length.
   Used when the chosen model cannot report real word timings, or after edits. */
export function estimateWords(text, start, end) {
  const toks = text.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  const weights = toks.map((t) => Math.max(1, t.replace(/[^\p{L}\p{N}]/gu, '').length) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const dur = Math.max(0.05, end - start);
  let t = start;
  return toks.map((word, i) => {
    const d = (weights[i] / total) * dur;
    const w = { word, start: round3(t), end: round3(t + d), estimated: true };
    t += d;
    return w;
  });
}

/* After the user edits a segment's text, keep its word timings in step with the new words. */
export function retimeWords(seg) {
  const toks = seg.text.trim().split(/\s+/).filter(Boolean);
  if (seg.words && seg.words.length === toks.length) {
    return seg.words.map((w, i) => ({ ...w, word: toks[i] }));
  }
  return estimateWords(seg.text, seg.start, seg.end);
}

/* Remove empty segments and Whisper's "stuck" loops (the same line repeated back to back). */
export function cleanSegments(segs) {
  const out = [];
  for (const s of segs) {
    const t = s.text.trim();
    if (!t) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text.trim().toLowerCase() === t.toLowerCase() && s.start - prev.end < 1.5) {
      prev.end = Math.max(prev.end, s.end);
      continue;
    }
    if (s.end <= s.start) s.end = s.start + 0.3;
    out.push({ ...s, text: t });
  }
  return out;
}

/* ---------- caption cues ---------- */
function wrapLines(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > maxChars) { lines.push(line); line = w; }
    else line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines;
}
function balanceTwo(text, maxChars) {
  // split into two lines of similar length when it doesn't fit on one
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    if (a.length > maxChars || b.length > maxChars) continue;
    const score = Math.abs(a.length - b.length);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best ? best.lines : wrapLines(text, maxChars);
}

/* Build subtitle cues: each cue holds at most `maxLines` lines of `maxChars`.
   Long lines are shared out evenly across cues, so no cue ends up with a lonely word. */
export function buildCues(segments, { maxChars = 42, maxLines = 2, maxDur = 6.5 } = {}) {
  const fits = (ws) => {
    const text = ws.map((x) => x.word).join(' ');
    return (maxLines > 1 ? balanceTwo(text, maxChars) : wrapLines(text, maxChars)).length <= maxLines;
  };
  const okCue = (ws) => fits(ws) && ws[ws.length - 1].end - ws[0].start <= maxDur;
  const greedy = (words) => {
    const groups = [];
    let cur = [];
    for (const w of words) {
      if (cur.length && (!okCue([...cur, w]) || w.start - cur[cur.length - 1].end > 0.7)) { groups.push(cur); cur = []; }
      cur.push(w);
    }
    if (cur.length) groups.push(cur);
    return groups;
  };
  const even = (words, n) => {
    const len = (w) => w.word.length + 1;
    const total = words.reduce((a, w) => a + len(w), 0);
    const groups = [];
    let cur = [], acc = 0, k = 1;
    for (const w of words) {
      if (cur.length && k < n && acc + len(w) / 2 > (k * total) / n) { groups.push(cur); cur = []; k++; }
      cur.push(w); acc += len(w);
    }
    groups.push(cur);
    return groups;
  };
  const cues = [];
  for (const seg of segments) {
    const words = seg.words && seg.words.length ? seg.words : estimateWords(seg.text, seg.start, seg.end);
    if (!words.length) continue;
    // split at sentence ends first, then share each sentence out over as few cues as possible
    const sentences = [];
    let cur = [];
    for (const w of words) { cur.push(w); if (/[.!?…]["')\]]?$/.test(w.word)) { sentences.push(cur); cur = []; } }
    if (cur.length) sentences.push(cur);
    // keep short sentences together when they fit in one cue
    const blocks = [];
    for (const snt of sentences) {
      const last = blocks[blocks.length - 1];
      if (last && okCue([...last, ...snt]) && snt[0].start - last[last.length - 1].end < 0.7) last.push(...snt);
      else blocks.push(snt);
    }
    for (const blk of blocks) {
      let groups = greedy(blk);
      if (groups.length > 1) {
        const ev = even(blk, groups.length);
        if (ev.every(okCue)) groups = ev;
      }
      for (const g of groups) {
        const text = g.map((w) => w.word).join(' ');
        cues.push({ start: g[0].start, end: g[g.length - 1].end, lines: maxLines > 1 ? balanceTwo(text, maxChars) : [text] });
      }
    }
  }
  // no overlaps, and a minimum on-screen time
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    if (cues[i].end - cues[i].start < 0.7) cues[i].end = cues[i].start + 0.7;
    if (next && cues[i].end > next.start) cues[i].end = Math.max(cues[i].start + 0.2, next.start - 0.01);
  }
  return cues;
}

/* Join lines that a chunk boundary cut in the middle of a sentence. */
export function joinBrokenLines(segs, { maxChars = 110 } = {}) {
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && !SENT_END.test(prev.text) && s.start - prev.end < 0.45 && (prev.text + ' ' + s.text).length <= maxChars) {
      prev.text += ' ' + s.text;
      prev.end = s.end;
      if (prev.words && s.words) prev.words = prev.words.concat(s.words);
      continue;
    }
    out.push({ ...s, words: s.words ? s.words.slice() : s.words });
  }
  return out;
}

/* ---------- formats ---------- */
function stamp(t, sep) {
  t = Math.max(0, t);
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}
export function toSRT(cues) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}\n`).join('\n');
}
export function toVTT(cues) {
  return 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}\n`).join('\n');
}
export function clock(t) {
  t = Math.max(0, Math.floor(t + 1e-6));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}
export function toTXT(segments, withTimes = true) {
  return segments.map((s) => (withTimes ? `[${clock(s.start)}] ` : '') + s.text).join('\n') + '\n';
}
export function toJSON(segments, meta) {
  return JSON.stringify({
    ...meta,
    segments: segments.map((s) => ({
      start: round3(s.start), end: round3(s.end), text: s.text,
      words: (s.words && s.words.length ? s.words : estimateWords(s.text, s.start, s.end))
        .map((w) => ({ word: w.word, start: round3(w.start), end: round3(w.end), ...(w.estimated ? { estimated: true } : {}) }))
    }))
  }, null, 2);
}
function round3(x) { return Math.round(x * 1000) / 1000; }
