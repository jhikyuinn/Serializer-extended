#!/bin/bash
# §84 실험 4 사전 점검 (Fabric VM 에서): FPP·HTF 가 지금 경로(메타데이터 전송, SDK 우회)에서 도는지, α 가 프로세서에 들어가는지.
set -u
cd /opt/work
. /opt/work/cloud-run.env
export MODE=smallbank WORKERS=5 TPS=1000 DURATION=30 WARMUP_SEC=5 CALIPER_TIMEOUT=30 URGENT_LIST=0 REPS=1 REUSE_NETWORK=1 ZIPF_S=1.0 BATCH_SIZE=100 BATCH_TIMEOUT=2s EPS_URGENT=1 EPS_LOW=0.75
rm -f HLF/fabric-samples/zipfbench/results/.net-signature
for sys in FPP HTF; do echo "### $sys"; env RUN_ID=fsmoke-$sys SYSTEMS=$sys bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E '^\| users|실패|재사용'; done
echo "### BE alpha 0"; env RUN_ID=fsmoke-BE-a0 SYSTEMS=BE PROCESSOR_ALPHA=0 bash Serializer/deploy/cloud/run.sh 2>&1 | grep -E '^\| users|실패|재사용'
DOCKER_HOST="$KAFKA_DOCKER_HOST" docker inspect kafka-processor-1 --format '{{json .Args}}'
echo "ALL-DONE"
