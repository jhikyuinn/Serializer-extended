#!/bin/bash
# §81 2번 실험의 빈칸 채우기 (Fabric VM 에서). BE, 워커 30, 30초(앞 5초 제외).
#   A) 경계 TPS: custom(인기 키 0.2/0.1), 배치 1000, 긴급 끔, ε 0/0.5/1 × TPS 1500/2000/2500 × 3바퀴 (바퀴마다 ε 순서 바꿈)
#   B) 긴급 ε: custom, 배치 1000, 긴급 1(User3 의 쓰기), 1000 TPS, (ε_u, ε_l) = (0.1,0.75)/(1,0.75) × 3바퀴
#   C) 고부하 반복: smallbank s 1.0, 3000 TPS × 배치 100/1000 × 3바퀴, 4000 TPS × 배치 1000/5000 × 2바퀴(rep 2~3; rep1 은 §70·§71)
set -u
cd /opt/work
export WORKERS=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 REPS=1 REUSE_NETWORK=1 SYSTEMS=BE DURATION=30
F='^\| users|실패|건너뜀|재사용'
to() { case $1 in 100) echo 2s;; 1000) echo 5s;; 5000) echo 10s;; esac; }
one() { # 이름 mode urgent epsU epsL tps batch rep [s]
  echo "### $1 rep=$8 $(date +%H:%M:%S)"
  env RUN_ID=$1 MODE=$2 URGENT_LIST=$3 EPS_URGENT=$4 EPS_LOW=$5 TPS=$6 BATCH_SIZE=$7 BATCH_TIMEOUT=$(to $7) REP_START=$8 ZIPF_S=${9:-1.15} \
    bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E "$F"
}
rm -f HLF/fabric-samples/zipfbench/results/.net-signature
# A
for rep in 1 2 3; do
  case $rep in 1) order="0 0.5 1";; 2) order="1 0 0.5";; 3) order="0.5 1 0";; esac
  for e in $order; do for t in 1500 2000 2500; do one gapA-e$e-t$t custom 0 $e $e $t 1000 $rep; done; done
done
# B
for rep in 1 2 3; do
  if [ $rep = 2 ]; then order="1 0.1"; else order="0.1 1"; fi
  for eu in $order; do one gapB-eu$eu custom 1 $eu 0.75 1000 1000 $rep; done
done
# C
for rep in 1 2 3; do for b in 100 1000; do one gapC-t3000-b$b smallbank 0 0.1 0.75 3000 $b $rep 1.0; done; done
for rep in 2 3; do for b in 1000 5000; do one gapC-t4000-b$b smallbank 0 0.1 0.75 4000 $b $rep 1.0; done; done
echo "ALL-DONE $(date +%H:%M:%S)"
