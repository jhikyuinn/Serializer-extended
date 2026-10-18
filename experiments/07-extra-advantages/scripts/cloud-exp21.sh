#!/bin/bash
# §86 실험 2·1 (Fabric VM 에서). 1,000 TPS, 배치 100, 워커 5, 30초(앞 5초 제외), 긴급 0, 사용자 지연 4.5/50/50/50/100 ms 흉내.
#   실험 2 (성공 tx 당 피어 자원·원장): A1·FPP·HTF·BE(1/0.75) × smallbank(s 1.0)·custom(0.2/0.1) × 2바퀴
#     실행 내내 2초마다 컨테이너 cgroup CPU 누적(usage_usec)과 org1 피어 블록 파일 크기를 남긴다: /opt/work/res-<부하>-<라벨>-rep<n>.txt
#   실험 1 (사용자별 접근 치우침): smallbank, User2 만 Zipf s 2.5(나머지 1.0) × A1·FPP·HTF·BE α 0/1/3 × 3바퀴
# 결과: results/res-<부하>-<라벨>, results/skew-<라벨>
set -u
cd /opt/work
export WORKERS=5 TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 REPS=1 REUSE_NETWORK=1 ZIPF_S=1.0 BATCH_SIZE=100 BATCH_TIMEOUT=2s EPS_URGENT=1 EPS_LOW=0.75 URGENT_LIST=0
F='^\| users|실패|건너뜀|재사용'
cg() { local id; id=$(sudo docker inspect -f '{{.Id}}' "$1" 2>/dev/null) || { echo 0; return; }; awk '/^usage_usec/{print $2}' /sys/fs/cgroup/system.slice/docker-$id.scope/cpu.stat 2>/dev/null || echo 0; }
sampler() { # 출력 파일
  while true; do
    bf=$(sudo docker exec zipfbench-peer0.org1.example.com-1 sh -c 'cat /var/hyperledger/production/ledgersData/chains/chains/mychannel/blockfile_* 2>/dev/null | wc -c' 2>/dev/null || echo 0)
    echo "$(date +%s%3N) $(cg zipfbench-peer0.org1.example.com-1) $(cg zipfbench-peer0.org2.example.com-1) $(cg zipfbench-orderer.example.com-1) $(cg zipfbench-cc) $bf"
    sleep 2
  done > "$1"
}
run() { # RUN_ID SYS MODE [env...]
  local id=$1 sys=$2 mode=$3; shift 3
  echo "### $id $(date +%H:%M:%S)"
  env RUN_ID=$id SYSTEMS=$sys MODE=$mode "$@" bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E "$F"
}
rm -f HLF/fabric-samples/zipfbench/results/.net-signature
# 실험 2
for rep in 1 2; do
  if [ $rep = 1 ]; then order="A1 FPP HTF BE"; else order="BE HTF FPP A1"; fi
  for s in $order; do
    lab=$s; [ $s = BE ] && lab=BE075
    for mode in smallbank custom; do
      sampler /opt/work/res-$mode-$lab-rep$rep.txt & sp=$!
      run res-$mode-$lab $s $mode REP_START=$rep
      kill $sp 2>/dev/null; wait $sp 2>/dev/null
    done
  done
done
# 실험 1
export USER_ZIPF='{"User2": 2.5}'
for rep in 1 2 3; do
  case $rep in 1) order="A1 FPP HTF BE-a0 BE-a1 BE-a3";; 2) order="BE-a3 BE-a1 BE-a0 HTF FPP A1";; 3) order="HTF BE-a1 A1 BE-a3 FPP BE-a0";; esac
  for s in $order; do
    case $s in BE-a*) run skew-$s BE smallbank REP_START=$rep PROCESSOR_ALPHA=${s#BE-a};; *) run skew-$s $s smallbank REP_START=$rep;; esac
  done
done
echo "ALL-DONE $(date +%H:%M:%S)"
