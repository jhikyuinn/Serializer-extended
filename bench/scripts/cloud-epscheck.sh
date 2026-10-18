#!/bin/bash
# §77 ε 시뮬레이션(§74~§76)의 클라우드 실제 경로 확인 (Fabric VM 에서). BE, custom 부하(인기 키 0.2/0.1), 긴급 끔, 워커 30.
#   1) 이득: 배치 1000 × ε (0,0)/(1,1) × TPS 1000/3000, 30초(앞 5초 제외), 3바퀴. 바퀴마다 ε 묶음 순서를 바꾼다.
#   2) 비용: 배치 10000 × ε (0,0)/(1,1) × TPS 2000, 60초(앞 5초 제외), 1회.
set -u
cd /opt/work
export MODE=custom WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 SYSTEMS=BE WORKERS=30
F='^\| users|실패|건너뜀|재사용'
one() { # 이름 epsU epsL tps batch timeout dur rep
  echo "### $1 eps=$2/$3 tps=$4 b=$5 rep=$8 $(date +%H:%M:%S)"
  env RUN_ID=$1 EPS_URGENT=$2 EPS_LOW=$3 TPS=$4 BATCH_SIZE=$5 BATCH_TIMEOUT=$6 DURATION=$7 REP_START=$8 \
    bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E "$F"
}
grp() { # epsU epsL rep
  for t in 1000 3000; do one epsc-e$1-t$t-b1000 $1 $2 $t 1000 5s 30 $3; done
}
rm -f HLF/fabric-samples/zipfbench/results/.net-signature
grp 0 0 1; grp 1 1 1
grp 1 1 2; grp 0 0 2
grp 0 0 3; grp 1 1 3
one epsc-e0-t2000-b10000 0 0 2000 10000 15s 60 1
one epsc-e1-t2000-b10000 1 1 2000 10000 15s 60 1
echo "ALL-DONE $(date +%H:%M:%S)"
