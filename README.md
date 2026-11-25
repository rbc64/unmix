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

## Speed
Unmix uses your graphics card (WebGPU) when the browser supports it. Chrome and Edge work best. Without a GPU it falls back to the CPU, which works but is much slower. Files over about 20 minutes can run out of browser memory, so split very long recordings first.

## Put it on a website
The whole folder is a static site with no server code.
- **GitHub Pages:** push this folder to a repository, then open Settings → Pages and choose *Deploy from a branch → main → / (root)*. `coi-serviceworker.min.js` adds the security headers GitHub can't set (the page reloads once on a visitor's first visit; that's normal).
- **Netlify:** drag the folder onto app.netlify.com/drop. `netlify.toml` already sets the required headers.
- **Cloudflare Pages:** also works. The `_headers` file is included.
- Leave the `models` folder empty when hosting. Visitors download the model once from Hugging Face and their browser keeps it. Each visitor's own GPU does the processing, so hosting costs stay near zero.

## Credits
Demucs v4 (Meta, MIT) via demucs-web (MIT) · ONNX Runtime Web (MIT) · lamejs MP3 encoder (LGPL).
