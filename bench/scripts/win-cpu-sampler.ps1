# Windows 쪽 CPU 를 3초마다 기록한다: PC 전체 %, Docker Desktop VM(vmmem*) % (100 = 코어 1개)
# 사용: win-cpu-sampler.ps1 <출력파일> <멈춤 표시 파일>
param([string]$Out, [string]$Stop)
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
"cores $cores" | Out-File -FilePath $Out -Encoding utf8
while (-not (Test-Path $Stop)) {
  $c = Get-Counter '\Processor(_Total)\% Processor Time', '\Process(vmmem*)\% Processor Time' -ErrorAction SilentlyContinue
  $total = ($c.CounterSamples | Where-Object { $_.Path -like '*processor(_total)*' }).CookedValue
  $vm = ($c.CounterSamples | Where-Object { $_.Path -like '*vmmem*' } | Measure-Object CookedValue -Sum).Sum
  "{0} total={1:N1} vm={2:N1}" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $total, $vm | Out-File -FilePath $Out -Append -Encoding utf8
  Start-Sleep -Seconds 2
}
