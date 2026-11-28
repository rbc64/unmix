# Unmix

Split any audio or video into layers: a clean **Voice** layer, **Drums & hits**, **Bass**, and **Music & background**. Everything runs on your own computer, and your audio is never uploaded.

## Use it on this computer (offline)

1. **First time only:** double-click **Download Model (Windows).bat** (or **Download Model (Mac).command**). This puts the AI model (about 172 MB) into the `models` folder. After that, no internet is needed.
   *Alternative:* skip this step and click **Download model** inside the app. The browser then keeps its own copy.
2. Double-click **Start Unmix (Windows).bat** (or **Start Unmix (Mac).command**). A small window opens and Unmix opens in your browser. Keep that window open while you work, and close it when you're done.
3. Drop in a file, click **Separate into layers**, then listen, mix and export.

> Don't open `index.html` directly. Browsers block the AI engine on pages opened straight from a file, which is why the Start launcher exists.

**Mac note:** if macOS says the .command file can't be opened, right-click it, choose **Open**, then **Open** again. The Mac launcher uses Python 3. If it's missing, macOS offers to install it.

## Features
- **Layers:** Voice · Drums & hits · Bass · Music & background (instruments, ambience, SFX)
- **Voice clean-up slider:** silences low-level music bleed in the gaps between words
- **Mixer:** play/pause, click a waveform to jump, mute (M), solo (S), volume per layer, plus **Hear original** for A/B comparison. Spacebar plays/pauses.
- **Export:** WAV 24-bit or MP3 (128 / 192 / 320 kbps), per layer, **Music bed (no voice)**, **Current mix** (respects your mute/solo/volume), or **Download all layers (.zip)**

## Transcript & captions
Load a file, then open **Transcript & captions** (or click **Transcribe…**).
- **Transcribe from** the clean voice layer (best when there's music underneath; Unmix separates first if needed) or the original audio.
- **Pick a model.** Each card shows its download size on your device, speed, accuracy, word-timing quality and an estimated time for your file. The recommended one is picked from your hardware. Estimates get exact after your first run.
  - Tiny · Base · Small: precise word timing. Medium · Large-v3 Turbo: more accurate text, word timing estimated from each line.
- **Options:** language (or auto-detect), word-level timing for animated captions, translate to English.
- **Edit** any line by clicking it; click a time to jump the player there.
- **Export:** SRT, VTT (32 / 42 / 60 characters per line, 1 or 2 lines), TXT, or **Word timings (JSON)** with every word's start and end, for animated captions in After Effects.

### Where models are kept
Each model downloads once, then works offline.
- **Chrome / Edge:** click **Choose models folder…** and models are saved in that folder, surviving cleared browser data. On the offline version, choose `Unmix/models/whisper`: then any browser on this computer can use them through the Start launcher.
- **Firefox / Safari:** models stay in browser storage. **Manage models → Save a copy (.zip)** backs one up; **Load models folder…** loads it again.
- **Manage models** shows what's stored where, deletes models, moves browser copies into your folder, and asks the browser to protect its storage.

## Speed
Unmix uses your graphics card (WebGPU) when the browser supports it. Chrome and Edge work best. Without a GPU it falls back to the CPU, which works but is much slower. Files over about 20 minutes can run out of browser memory, so split very long recordings first.

## Put it on a website
The whole folder is a static site with no server code.
- **GitHub Pages:** push this folder to a repository, then open Settings → Pages and choose *Deploy from a branch → main → / (root)*. `coi-serviceworker.min.js` adds the security headers GitHub can't set (the page reloads once on a visitor's first visit; that's normal).
- **Netlify:** drag the folder onto app.netlify.com/drop. `netlify.toml` already sets the required headers.
- **Cloudflare Pages:** also works. The `_headers` file is included.
- Leave the `models` folder empty when hosting. Visitors download the model once from Hugging Face and their browser keeps it. Each visitor's own GPU does the processing, so hosting costs stay near zero.

## Credits
Demucs v4 (Meta, MIT) via demucs-web (MIT) · Whisper (OpenAI, MIT) via Transformers.js (Apache-2.0) · ONNX Runtime Web (MIT) · lamejs MP3 encoder (LGPL).
