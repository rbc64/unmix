@echo off
title Unmix
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "launcher\server.ps1"
