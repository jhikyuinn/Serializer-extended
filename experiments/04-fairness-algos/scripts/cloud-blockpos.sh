#!/bin/bash
# §85 tx 별 블록 안 위치 (Fabric VM 에서): A1·FPP·BE(1/0.75) 를 smallbank s 1.0, 1,000 TPS, 배치 100, 긴급 0 으로 1회씩 돌리고
# 실행 직후 피어 원장의 블록을 모두 꺼내 tx 마다 (블록, 자리, 블록 크기, 함수, 사용자, 긴급, 유효, 클라이언트 시각) 을 남긴다.
# 결과: /opt/work/blockpos-<sys>.csv (+ results/bpos-<sys>)
set -u
cd /opt/work
export MODE=smallbank WORKERS=5 TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 ZIPF_S=1.0 BATCH_SIZE=100 BATCH_TIMEOUT=2s EPS_URGENT=1 EPS_LOW=0.75
CLI="sudo docker exec zipfbench-cli-1 bash -c"
for sys in A1 FPP BE; do
  rm -f HLF/fabric-samples/zipfbench/results/.net-signature
  echo "### $sys $(date +%H:%M:%S)"
  env RUN_ID=bpos-$sys SYSTEMS=$sys bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E '^\| users|실패'
  h=$($CLI 'source /work/scripts/env.sh >/dev/null 2>&1; setOrg 1; peer channel getinfo -c mychannel 2>/dev/null' | grep -o '"height":[0-9]*' | tr -dc 0-9)
  echo "height=$h"
  : > blockpos-$sys.csv
  for ((n=1; n<h; n++)); do
    # 피어에서 꺼낸다: 오더러가 주는 블록에는 피어가 붙이는 유효 표시(TRANSACTIONS_FILTER)가 없다
    $CLI "source /work/scripts/env.sh >/dev/null 2>&1; setOrg 1; peer channel fetch $n /tmp/b.block -c mychannel >/dev/null 2>&1 && cat /tmp/b.block" | python3 blockpos-extract.py >> blockpos-$sys.csv
  done
  echo "$sys rows $(wc -l < blockpos-$sys.csv)"
done
echo "ALL-DONE $(date +%H:%M:%S)"
