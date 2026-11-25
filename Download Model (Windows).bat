@echo off
title Unmix - download model
cd /d "%~dp0"
echo Downloading the Unmix model (about 172 MB) into the models folder...
curl.exe -L --fail -o "models\htdemucs_embedded.onnx.part" "https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx" && move /y "models\htdemucs_embedded.onnx.part" "models\htdemucs_embedded.onnx" >nul && echo Done! Unmix now works fully offline.
pause
