#!/bin/bash
# [② Fabric VM] 실험 구동. cloud-run.env 를 읽고 zipfbench/userbench.sh 를 그대로 부른다.
# 로컬과 같은 환경 변수를 그대로 쓴다. 예:
#   RUN_ID=cloud-base SYSTEMS="A1 BE" URGENT_LIST=0 REPS=1 TPS=1000 DURATION=60 BATCH_SIZE=1000 BATCH_TIMEOUT=5s bash run.sh
# 결과: $WORK/HLF/fabric-samples/zipfbench/results/<RUN_ID>  (내 PC 로는 scp 로 가져온다)
#
# 처음 한 번은 연결을 확인한다:  bash run.sh check
set -euo pipefail
cd "$(dirname "$0")"; . ./cluster.env
. "$WORK/cloud-run.env"
cd "$WORK/HLF/fabric-samples/zipfbench"
if [ "${1:-}" = check ]; then
  echo "== Kafka VM Docker";  DOCKER_HOST="$KAFKA_DOCKER_HOST" docker ps --format '{{.Names}}' | grep -E 'kafka|processor|mongo'
  echo "== Client VM Docker"; DOCKER_HOST="$CALIPER_DOCKER_HOST" docker image inspect serializer/caliper:latest --format '{{.Id}}'
  echo "== 시계 (chrony)";    chronyc tracking | grep -E 'System time|Leap'
  exit 0
fi
exec ./userbench.sh
