#!/bin/bash
# Zipf transfer 라운드 하나를 Caliper 로 돌린다. zipf 네트워크(../network)가 떠 있고
# 체인코드 init 이 끝나 있어야 한다.
#
#   ./run.sh <zipfS> <출력폴더>
#
# 환경변수: TX_NUMBER(10000) TPS(250) WORKERS(4) KEY_COUNT(1000) SEED(12345)
# 출력폴더에 benchconfig.yaml, caliper.log, report.html 을 남긴다.
set -euo pipefail

cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1

S="${1:?zipfS}"
OUT="${2:?출력 폴더}"
mkdir -p "$OUT"
OUT_ABS="$(cd "$OUT" && (pwd -W 2>/dev/null || pwd))"

IMAGE=serializer/caliper:latest
HERE="$(pwd -W 2>/dev/null || pwd)"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" .

sed -e "s/@ZIPF_S@/$S/g" \
    -e "s/@TX_NUMBER@/${TX_NUMBER:-10000}/g" \
    -e "s/@TPS@/${TPS:-250}/g" \
    -e "s/@WORKERS@/${WORKERS:-4}/g" \
    -e "s/@KEY_COUNT@/${KEY_COUNT:-1000}/g" \
    -e "s/@SEED@/${SEED:-12345}/g" \
    benchconfig.tmpl.yaml > "$OUT/benchconfig.yaml"

# 인증서는 네트워크를 띄울 때 만든 것을 읽기 전용으로 붙인다 (root 소유라 root 로 읽는다).
# docker 모니터가 컨테이너 자원을 읽도록 Docker 소켓도 붙인다.
docker rm -f zipfbench-caliper >/dev/null 2>&1 || true
docker run --rm --name zipfbench-caliper --network zipf_fabric --user root \
  -v "$HERE:/hyperledger/caliper/workspace" \
  -v "$HERE/../network/organizations:/hyperledger/caliper/workspace/organizations:ro" \
  -v "$OUT_ABS:/out" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e CALIPER_BENCHCONFIG=/out/benchconfig.yaml \
  -e CALIPER_REPORT_PATH=/out/report.html \
  "$IMAGE" launch manager 2>&1 | grep -v 'strategyFail: commit failure' > "$OUT/caliper.log"
# 실패 트랜잭션마다 찍히는 경고 줄은 너무 많아 버린다 (건수는 Prometheus 로 센다)
