#!/bin/bash
cd "$(dirname "$0")"
echo "Downloading the Unmix model (about 172 MB) into the models folder..."
curl -L --fail -o models/htdemucs_embedded.onnx.part "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx" \
  && mv models/htdemucs_embedded.onnx.part models/htdemucs_embedded.onnx \
  && echo "Done! Unmix now works fully offline."
read -n 1 -s -r -p "Press any key to close"
