#!/bin/bash
# Serializer 논문 Figure 16·Table I 실험 라운드 하나를 Caliper 로 돌린다 (사용자 5명).
# zipf 네트워크(../network)가 떠 있고 smallbank 체인코드 배포·init 이 끝나 있어야 한다.
#
#   ./run-users.sh <출력폴더>
#
# 환경변수
#   TPS(250, 다섯 워커가 나눠 보낸다)  DURATION(30 초)  ZIPF_S(1.15)  PRW(0.5)  ACCOUNT_COUNT(100)
#   URGENT_RATIO(0, User3 의 쓰기 중 긴급 비율)  LATENCIES("4.5, 50, 50, 50, 100")  SEED(12345)
#   ABORT_NOTIFY(true: abort 토픽을 읽어 버려진 트랜잭션을 바로 끝낸다)
#   WORKERS(5, 사용자 수의 배수. 사용자 하나를 워커 여럿이 나눠 보낸다)
#   CALIPER_CPU_PROF(1 이면 원격 실행에서 워커마다 CPU 프로파일을 출력폴더/prof 에 남긴다, §68)
#   MODE(smallbank | custom)  custom 일 때: ITEM_COUNT(10000) RW(4) HR(0.2) HW(0.1) HOT_SHARE(0.01)
# 출력폴더에 benchconfig.yaml, caliper.log, report.html, user-User*.json 을 남긴다.
set -euo pipefail

cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1

OUT="${1:?출력 폴더}"
mkdir -p "$OUT"
OUT_ABS="$(cd "$OUT" && (pwd -W 2>/dev/null || pwd))"

IMAGE=serializer/caliper:latest
HERE="$(pwd -W 2>/dev/null || pwd)"

# 클라우드: CALIPER_DOCKER_HOST(예: ssh://ubuntu@10.0.1.30)가 있으면 Caliper 를 그 VM 에서 돌린다(deploy/cloud).
#   설정·인증서를 CALIPER_REMOTE_DIR(기본 /opt/zipfbench)로 복사하고, 끝나면 결과를 이쪽 출력 폴더로 가져온다.
#   그 VM 에서는 FABRIC_IP 로 오더러·피어 이름을 풀고(--add-host), connection-org1.cloud.yaml(org2 → 9051)을 쓴다.
REMOTE="${CALIPER_DOCKER_HOST:-}"
cdk() { if [ -n "$REMOTE" ]; then DOCKER_HOST="$REMOTE" docker "$@"; else docker "$@"; fi; }
if [ -n "$REMOTE" ]; then
  SSH_TARGET="${REMOTE#ssh://}"
  RDIR="${CALIPER_REMOTE_DIR:-/opt/zipfbench}"
  ROUT="$RDIR/runs/$(echo "$OUT_ABS" | tr '/:' '__')"
  : "${FABRIC_IP:?FABRIC_IP 가 필요하다 (오더러·피어가 있는 VM)}"
fi
cdk image inspect "$IMAGE" >/dev/null 2>&1 || { [ -z "$REMOTE" ] && docker build -t "$IMAGE" .; } || { echo "$IMAGE 이미지가 없다" >&2; exit 1; }

sed -e "s/@TPS@/${TPS:-250}/g" \
    -e "s/@DURATION@/${DURATION:-30}/g" \
    -e "s/@ZIPF_S@/${ZIPF_S:-1.15}/g" \
    -e "s/@PRW@/${PRW:-0.5}/g" \
    -e "s/@ACCOUNT_COUNT@/${ACCOUNT_COUNT:-100}/g" \
    -e "s/@URGENT_RATIO@/${URGENT_RATIO:-0}/g" \
    -e "s/@LATENCIES@/${LATENCIES:-4.5, 50, 50, 50, 100}/g" \
    -e "s/@SEED@/${SEED:-12345}/g" \
    -e "s/@ABORT_NOTIFY@/${ABORT_NOTIFY:-true}/g" \
    -e "s/@WORKERS@/${WORKERS:-5}/g" \
    -e "s/@MODE@/${MODE:-smallbank}/g" \
    -e "s/@ITEM_COUNT@/${ITEM_COUNT:-10000}/g" \
    -e "s/@RW@/${RW:-4}/g" \
    -e "s/@HR@/${HR:-0.2}/g" \
    -e "s/@HW@/${HW:-0.1}/g" \
    -e "s/@HOT_SHARE@/${HOT_SHARE:-0.01}/g" \
    -e "s/@QUERY_SHARE@/${QUERY_SHARE:-0}/g" \
    -e "s/@TIMEOUT_SEC@/${CALIPER_TIMEOUT:-10}/g" \
    -e "s/@WARMUP_SEC@/${WARMUP_SEC:-0}/g" \
    -e "s/@KAFKA_BROKERS@/${CALIPER_KAFKA_BROKERS:-kafka1:9090, kafka2:9090, kafka3:9090}/g" \
    benchconfig.users.tmpl.yaml > "$OUT/benchconfig.yaml"

if [ -n "$REMOTE" ]; then
  # 클라이언트 VM 에서 돌린다: 작업 폴더·인증서·benchconfig 를 보내고, 그 VM 의 Docker 로 띄운다
  ssh "$SSH_TARGET" "mkdir -p '$RDIR/caliper' '$RDIR/network/organizations' '$ROUT'"
  # 인증서는 network.sh 의 컨테이너가 root 로 만들어 개인키를 다른 사용자가 못 읽는다. 보내기 전에 읽게 한다
  # (실행마다 새로 만드는 실험용 인증서다)
  docker run --rm -v "$HERE/../network/organizations:/o" alpine:3.20 chmod -R a+rX /o
  rsync -a --delete --exclude node_modules "$HERE/" "$SSH_TARGET:$RDIR/caliper/"
  rsync -a --delete "$HERE/../network/organizations/" "$SSH_TARGET:$RDIR/network/organizations/"
  rsync -a "$OUT_ABS/benchconfig.yaml" "$SSH_TARGET:$ROUT/"
  cdk rm -f zipfbench-caliper >/dev/null 2>&1 || true
  cdk create --name zipfbench-caliper --user root \
    --add-host "orderer.example.com:$FABRIC_IP" \
    --add-host "peer0.org1.example.com:$FABRIC_IP" \
    --add-host "peer0.org2.example.com:$FABRIC_IP" \
    -v "$RDIR/caliper:/hyperledger/caliper/workspace" \
    -v "$RDIR/network/organizations:/hyperledger/caliper/workspace/organizations:ro" \
    -v "$ROUT:/out" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e CALIPER_BENCHCONFIG=/out/benchconfig.yaml \
    -e CALIPER_FABRIC_TIMEOUT_INVOKEORQUERY=${CALIPER_TIMEOUT:-10} \
    ${CALIPER_CPU_PROF:+-e WORKLOAD_CPU_PROF=1} \
    -e CALIPER_NETWORKCONFIG=networkconfig-users.cloud.yaml \
    -e CALIPER_REPORT_PATH=/out/report.html \
    "$IMAGE" launch manager >/dev/null
  cdk start -a zipfbench-caliper 2>&1 | grep -v 'strategyFail: commit failure\|Failed to perform submit transaction' > "$OUT/caliper.log"
  cdk rm -f zipfbench-caliper >/dev/null 2>&1 || true
  rsync -a "$SSH_TARGET:$ROUT/" "$OUT_ABS/"
  exit 0
fi

docker rm -f zipfbench-caliper >/dev/null 2>&1 || true
# Kafka(abort 통보)에는 도커 내부망으로 직접 붙는다(Serializer NOTES §45~§46). 그래서 create → 망 연결 → start 로 띄운다
docker create --name zipfbench-caliper --network zipf_fabric --user root \
  -v "$HERE:/hyperledger/caliper/workspace" \
  -v "$HERE/../network/organizations:/hyperledger/caliper/workspace/organizations:ro" \
  -v "$OUT_ABS:/out" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e CALIPER_BENCHCONFIG=/out/benchconfig.yaml \
  -e CALIPER_FABRIC_TIMEOUT_INVOKEORQUERY=${CALIPER_TIMEOUT:-10} \
  -e CALIPER_NETWORKCONFIG=networkconfig-users.yaml \
  -e CALIPER_REPORT_PATH=/out/report.html \
  "$IMAGE" launch manager >/dev/null
docker network connect kafka_default zipfbench-caliper 2>/dev/null || echo "kafka_default 망이 없다: abort 통보 구독이 실패할 수 있다" >&2
docker start -a zipfbench-caliper 2>&1 | grep -v 'strategyFail: commit failure\|Failed to perform submit transaction' > "$OUT/caliper.log"
docker rm -f zipfbench-caliper >/dev/null 2>&1 || true
