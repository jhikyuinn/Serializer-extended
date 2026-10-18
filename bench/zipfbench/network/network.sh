#!/bin/bash
# Zipf 실험용 Fabric 네트워크. 어떤 시스템을 띄울지는 SYSTEM 으로 고른다.
#
#   SYSTEM=B  ./network.sh up       수정된 Fabric (재정렬 모듈: Kafka → 프로세서)
#   SYSTEM=A1 ./network.sh up       같은 소스, 오더러의 Kafka 경로만 되돌린 것
#   SYSTEM=A2 ./network.sh up       공식 Fabric 2.5.10
#   ./network.sh deploy             zipf 체인코드 기동/설치/승인/커밋
#   CC=smallbank ./network.sh deploy smallbank 체인코드 (사용자·긴급 실험용, ../chaincode-smallbank)
#                                   invoke·query 도 같은 CC 로 부른다
#   ./network.sh invoke 함수 [인자...]
#   ./network.sh query  함수 [인자...]
#   ./network.sh down               컨테이너, 볼륨, 인증서까지 모두 삭제
#   BATCH_SIZE=1000 BATCH_TIMEOUT=5s ./network.sh up   배치 크기·시간을 바꿔 띄운다 (기본 100, 2s)
#   ./network.sh logs [서비스]
#
# B 를 띄우기 전에는 같은 Kafka 토픽을 소비하는 serializer-fabric 오더러를 멈춰 둬야 한다
# (같은 consumer group 'ackGroup' 이라 파티션을 나눠 가져간다). up 이 확인한다.
set -euo pipefail

cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1

SYSTEM="${SYSTEM:-B}"
case "$SYSTEM" in
  B)  export ORDERER_IMAGE=serializer/fabric-orderer:latest PEER_IMAGE=serializer/fabric-peer:latest TOOLS_IMAGE=serializer/fabric-tools:latest ;;
  A1) export ORDERER_IMAGE=zipfbench/fabric-orderer-vanilla:latest PEER_IMAGE=serializer/fabric-peer:latest TOOLS_IMAGE=serializer/fabric-tools:latest ;;
  A2) export ORDERER_IMAGE=hyperledger/fabric-orderer:2.5.10 PEER_IMAGE=hyperledger/fabric-peer:2.5.10 TOOLS_IMAGE=hyperledger/fabric-tools:2.5.10 ;;
  *)  echo "SYSTEM 은 B, A1, A2 중 하나다" >&2; exit 1 ;;
esac

# CLOUD=1 이면 compose.cloud.yaml 을 더한다: 오더러·피어 포트를 호스트에 열어 다른 VM 의 클라이언트가 붙게 한다 (deploy/cloud)
COMPOSE="docker compose -f compose.yaml${CLOUD:+ -f compose.cloud.yaml}"
NODES="orderer.example.com peer0.org1.example.com peer0.org2.example.com prometheus"
# 체인코드: zipf (기본, ../chaincode) 또는 smallbank (../chaincode-smallbank)
CC="${CC:-zipf}"
case "$CC" in
  zipf)      CC_NAME=zipf;      CC_DIR=../chaincode ;;
  smallbank) CC_NAME=smallbank; CC_DIR=../chaincode-smallbank ;;
  *)         echo "CC 는 zipf, smallbank 중 하나다" >&2; exit 1 ;;
esac
CC_IMAGE=zipfbench/chaincode-$CC_NAME:latest
CC_CONTAINER=zipfbench-cc
KAFKA=kafka-kafka1-1
# Kafka 가 다른 VM 에 있으면 그 VM 의 Docker 로 보낸다 (예: ssh://ubuntu@10.0.1.20)
kd() { if [ -n "${KAFKA_DOCKER_HOST:-}" ]; then DOCKER_HOST="$KAFKA_DOCKER_HOST" docker "$@"; else docker "$@"; fi; }

cli() { $COMPOSE exec -T -e CC_NAME="$CC_NAME" -e BATCH_SIZE="${BATCH_SIZE:-}" -e BATCH_TIMEOUT="${BATCH_TIMEOUT:-}" cli "$@"; }

# B: 이전 실행에서 남은 정렬 결과가 새 오더러로 흘러들지 않게 오더러 그룹을 끝으로 옮긴다
reset_kafka() {
  if docker ps --format '{{.Names}}' | grep -q '^serializer-fabric-orderer'; then
    echo "serializer-fabric 오더러가 떠 있다. 'docker stop serializer-fabric-orderer.example.com-1' 후 다시 한다." >&2
    exit 1
  fi
  echo "== Kafka ackGroup 오프셋을 mychannel-commit 의 끝으로"
  # 방금 멈춘 오더러가 그룹에서 빠지기(세션 만료)까지는 리셋이 거절되므로 기다렸다 다시 한다
  local i out=""
  for i in $(seq 1 30); do
    out=$(kd exec "$KAFKA" kafka-consumer-groups.sh --bootstrap-server kafka1:9090 --group ackGroup \
        --topic mychannel-commit --reset-offsets --to-latest --execute 2>&1 </dev/null || true)
    if grep -q 'NEW-OFFSET' <<<"$out"; then
      return
    fi
    sleep 5
  done
  echo "ackGroup 오프셋을 옮기지 못했다 (그룹에 아직 소비자가 있다). 마지막 응답:" >&2
  echo "$out" | tail -5 >&2
  exit 1
}

up() {
  for img in "$ORDERER_IMAGE" "$PEER_IMAGE" "$TOOLS_IMAGE"; do
    docker image inspect "$img" >/dev/null 2>&1 || { echo "이미지 $img 가 없다" >&2; exit 1; }
  done
  [ "$SYSTEM" = B ] && reset_kafka
  echo "== SYSTEM=$SYSTEM ($ORDERER_IMAGE, $PEER_IMAGE)"
  $COMPOSE up -d cli
  cli scripts/crypto.sh
  # shellcheck disable=SC2086
  $COMPOSE up -d $NODES
  cli scripts/channel.sh
}

# 체인코드는 서비스형(ccaas)이다. 컨테이너로 띄우고 피어에는 주소만 담긴 패키지를 설치한다.
deploy() {
  docker image inspect "$CC_IMAGE" >/dev/null 2>&1 || docker build -q -t "$CC_IMAGE" "$CC_DIR"

  cli scripts/package.sh
  local pkgid
  pkgid=$(cli cat "channel-artifacts/$CC_NAME.pkgid")
  pkgid=${pkgid//[[:space:]]/}

  echo "== 체인코드 서버 기동"
  docker rm -f "$CC_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CC_CONTAINER" --network zipf_fabric --network-alias "$CC_NAME.chaincode" \
    --log-driver json-file --log-opt max-size=20m \
    -e CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999 -e CHAINCODE_ID="$pkgid" "$CC_IMAGE" >/dev/null

  cli scripts/commit.sh
}

down() {
  docker rm -f "$CC_CONTAINER" >/dev/null 2>&1 || true
  $COMPOSE down --volumes --remove-orphans
  # 인증서는 컨테이너가 root 로 만들었으므로 컨테이너로 지운다
  docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/work" "$TOOLS_IMAGE" \
    rm -rf /work/organizations /work/channel-artifacts /work/configtx-run
}

case "${1:-}" in
  up)     up ;;
  deploy) deploy ;;
  invoke) shift; cli scripts/invoke.sh "$@" ;;
  query)  shift; cli scripts/query.sh "$@" ;;
  down)   down ;;
  logs)   shift; $COMPOSE logs --tail=100 "$@" ;;
  *)      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
