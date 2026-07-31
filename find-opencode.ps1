$ports = 4096, 4097, 4098, 4099, 4100, 4101, 4102, 4103, 4104, 4105,
          5317, 5318, 5320, 5400,
          8080, 8081, 8082, 8083, 8084, 8085,
          3000, 3001, 5173, 5174, 5175,
          7777, 7778, 7779, 8888, 9999
foreach ($port in $ports) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/global/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    Write-Host "FOUND: OpenCode at http://127.0.0.1:$port (HTTP $($response.StatusCode))"
    if ($response.StatusCode -eq 401) {
      Write-Host "  (401 = OpenCode is up but needs Basic Auth; set OPENCODE_SERVER_USERNAME/_PASSWORD)"
    }
    exit 0
  } catch { }
}
Write-Host "Scan complete. No OpenCode server found on the scanned ports."
Write-Host "If OpenCode is running on a custom port, find it via:"
Write-Host "  Get-NetTCPConnection -State Listen | Where-Object { `$_.LocalAddress -in '0.0.0.0','127.0.0.1','::' } | Format-Table LocalAddress,LocalPort,OwningProcess"