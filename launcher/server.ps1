# Unmix local server for Windows (no installs needed). Serves the app on http://localhost
# with the headers the AI engine needs. Keep the window open while using Unmix.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript'; '.mjs'='text/javascript'; '.css'='text/css'
  '.wasm'='application/wasm'; '.onnx'='application/octet-stream'; '.json'='application/json'
  '.svg'='image/svg+xml'; '.png'='image/png'; '.ico'='image/x-icon'; '.txt'='text/plain'; '.md'='text/plain'
}
$listener = $null
$port = 8765
for ($i = 0; $i -lt 20; $i++) {
  try {
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$port/")
    $listener.Start()
    break
  } catch { $listener = $null; $port++ }
}
if (-not $listener) { Write-Host 'Could not start the server (no free port).'; Read-Host 'Press Enter to close'; exit 1 }
$url = "http://localhost:$port/"
Write-Host ""
Write-Host "  Unmix is running at $url" -ForegroundColor Yellow
Write-Host "  Keep this window open while you use it. Close it to stop."
Write-Host ""
Start-Process $url
while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
    $res.Headers.Add('Cross-Origin-Opener-Policy', 'same-origin')
    $res.Headers.Add('Cross-Origin-Embedder-Policy', 'require-corp')
    $res.Headers.Add('Cross-Origin-Resource-Policy', 'same-origin')
    $res.Headers.Add('Cache-Control', 'no-cache')
    if ($full.StartsWith($root) -and (Test-Path $full -PathType Leaf)) {
      $ext = [IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $fs = [IO.File]::OpenRead($full)
      $res.ContentLength64 = $fs.Length
      $fs.CopyTo($res.OutputStream)
      $fs.Close()
    } else {
      $res.StatusCode = 404
    }
  } catch { try { $res.StatusCode = 500 } catch {} }
  finally { try { $res.OutputStream.Close() } catch {} }
}
