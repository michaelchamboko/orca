$ports = 4096, 4097, 4098, 4099, 5317, 8080, 8000, 3000, 5173, 5174, 7777
foreach ($port in $ports) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/global/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    if ($response.StatusCode -in 200, 401) {
      Write-Host "FOUND: OpenCode at http://127.0.0.1:$port (HTTP $($response.StatusCode))"
      break
    }
  } catch { }
}
Write-Host "Scan complete."