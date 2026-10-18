#!/bin/bash
# Zipf 실험 전체를 돌린다: 시스템 × s 값 × 반복. 매 실행마다 네트워크를 새로 띄우고 init 한다.
#
#   ./bench.sh                         전체 (B A1 A2 × 10개 s × 3회, 약 3~5시간)
#   SYSTEMS="B A2" S_LIST="0 1.2" REPS=1 TX_NUMBER=1000 ./bench.sh    일부만
#   SYSTEMS="B FPP HTF A2" ./bench.sh   정렬 알고리즘 비교
#
# 환경변수
#   RUN_ID     결과 폴더 이름 (results/<RUN_ID>). 같은 RUN_ID 로 다시 돌리면 끝난 실행은 건너뛴다.
#   SYSTEMS    B A1 A2 (FPP, HTF 도 가능)
#              B   = 재정렬 Fabric + Serializer 스케줄러
#              FPP = 같은 네트워크, 프로세서만 Fabric++ 재정렬 (-algo fabricpp)
#              HTF = 같은 네트워크, 프로세서만 HTFabric WARD 정렬 (-algo htfabric, 재실행 없음)
#              BE  = 같은 네트워크, 프로세서만 Serializer 논문의 ε-ordering (-algo epsilon)
#   EPS_URGENT 1   EPS_LOW 1   BE 의 ε
#   KAFKA_DIR  프로세서 compose 가 있는 곳 (기본 ../../kafka)
#   S_LIST     0 0.4 0.6 0.8 1.0 1.1 1.15 1.2 1.4 1.6
#   REPS       3
#   TX_NUMBER  10000    TPS 250    WORKERS 4    KEY_COUNT 1000    INIT_VALUE 1000000
#
# 실행 중에는 같은 PC 의 다른 부하를 멈춘다: w-node(bz*, wnode*) 와 serializer-fabric 오더러.
# (serializer-fabric 오더러는 B 와 같은 Kafka consumer group 을 쓴다.) 끝나면 멈췄던 것을 다시 켠다.
# 결과 정리는 node aggregate.js results/<RUN_ID>
set -euo pipefail

cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M)}"
SYSTEMS="${SYSTEMS:-B A1 A2}"
S_LIST="${S_LIST:-0 0.4 0.6 0.8 1.0 1.1 1.15 1.2 1.4 1.6}"
REPS="${REPS:-3}"
export TX_NUMBER="${TX_NUMBER:-10000}" TPS="${TPS:-250}" WORKERS="${WORKERS:-4}" KEY_COUNT="${KEY_COUNT:-1000}"
INIT_VALUE="${INIT_VALUE:-1000000}"
EPS_URGENT="${EPS_URGENT:-1}" EPS_LOW="${EPS_LOW:-1}"
KAFKA_DIR="${KAFKA_DIR:-$(cd ../../kafka 2>/dev/null && pwd)}"
OUT="results/$RUN_ID"
PROM="http://localhost:19090"
mkdir -p "$OUT"
LOG="$OUT/bench.log"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# ---- 다른 부하 멈추기 / 되돌리기 ----
STOPPED_FILE="$OUT/stopped-containers.txt"
pause_others() {
  docker ps --format '{{.Names}}' | grep -E '^(bz[0-9]+|wnode[0-9]+|serializer-fabric-orderer\.example\.com-1)$' >> "$STOPPED_FILE" || true
  if [ -s "$STOPPED_FILE" ]; then
    log "다른 부하를 멈춘다: $(sort -u "$STOPPED_FILE" | tr '\n' ' ')"
    sort -u "$STOPPED_FILE" | xargs -r docker stop >/dev/null
  fi
}
resume_others() {
  SYSTEM=A2 network/network.sh down >/dev/null 2>&1 || true
  # FPP/HTF 로 바꿔 둔 프로세서를 기본(Serializer)으로 되돌린다
  if [ -n "${PROCESSOR_TOUCHED:-}" ]; then
    log "프로세서를 serializer 로 되돌린다"
    set_processor_algo serializer >/dev/null 2>&1 || true
  fi
  if [ -s "$STOPPED_FILE" ]; then
    log "멈췄던 컨테이너를 다시 켠다"
    sort -u "$STOPPED_FILE" | xargs -r docker start >/dev/null || true
  fi
}
trap resume_others EXIT

# ---- Prometheus 스냅샷 ----
# 블록 처리 시간 합/개수와 검증 결과별 트랜잭션 수. 실행 전후 값의 차이로 이번 라운드만 센다.
snapshot() {
  curl -s -G "$PROM/api/v1/query" \
    --data-urlencode 'query={__name__=~"ledger_block_processing_time_sum|ledger_block_processing_time_count|ledger_transaction_count",channel="mychannel"}' \
    > "$1"
}

# ---- 시스템 → 네트워크 / 프로세서 정렬 알고리즘 ----
# FPP, HTF 는 B 와 같은 네트워크(재정렬 Fabric + Kafka 프로세서)를 쓰고 정렬 알고리즘만 다르다.
net_of() { case "$1" in B|BE|FPP|HTF) echo B ;; *) echo "$1" ;; esac; }
algo_of() { case "$1" in B) echo serializer ;; BE) echo epsilon ;; FPP) echo fabricpp ;; HTF) echo htfabric ;; esac; }
uses_processor() { [ "$(net_of "$1")" = B ]; }

PROCESSOR_TOUCHED=""
# 프로세서를 주어진 알고리즘으로 새로 띄운다 (compose 의 PROCESSOR_ALGO). 컨테이너를 다시 만들어야
# 명령줄 인자가 바뀐다.
set_processor_algo() {
  [ -n "$KAFKA_DIR" ] || { log "KAFKA_DIR 을 찾지 못했다"; return 1; }
  (cd "$KAFKA_DIR" && PROCESSOR_ALGO="$1" PROCESSOR_EPS_URGENT="$EPS_URGENT" PROCESSOR_EPS_LOW="$EPS_LOW" \
    docker compose -f docker-compose.yml -f docker-compose.processor.yml up -d --no-build --force-recreate processor)
}

# 프로세서의 goka consumer group 은 Kafka 연결이 한 번 끊기면 다시 붙지 못하고 멈춰 있는 일이 있다.
# 프로세서를 쓰는 실행마다 새로 띄우고, 파티션을 할당받았다는 줄("setup generation")이 나올 때까지 기다린다.
# 띄운 프로세서가 실제로 그 알고리즘으로 도는지("Ordering algorithm: ...")도 확인한다.
# 이전 실행에서 남은 incoming 배치(중단된 실행 등)를 새 프로세서가 처리하지 않도록, 프로세서의
# consumer group 을 incoming 토픽의 끝으로 옮긴다. 그룹에 소비자가 없어야 하므로 프로세서를 먼저 멈춘다.
reset_processor_offsets() {
  docker stop kafka-processor-1 >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 30); do
    if docker exec kafka-kafka1-1 kafka-consumer-groups.sh --bootstrap-server kafka1:9090 --group mychannel-incoming-group \
        --topic mychannel-incoming --reset-offsets --to-latest --execute 2>&1 | grep -q 'NEW-OFFSET'; then
      return
    fi
    sleep 5
  done
  log "프로세서 그룹 오프셋을 옮기지 못했다"
  return 1
}

restart_processor() {
  local algo=$1 since
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  PROCESSOR_TOUCHED=1
  reset_processor_offsets || return 1
  set_processor_algo "$algo" >/dev/null 2>&1 || { log "프로세서를 $algo 로 띄우지 못했다"; return 1; }
  local i
  for i in $(seq 1 60); do
    if docker logs --since "$since" kafka-processor-1 2>&1 | grep -q 'setup generation'; then
      if ! docker logs --since "$since" kafka-processor-1 2>&1 | grep -q "^Ordering algorithm: $algo\$"; then
        log "프로세서가 $algo 로 뜨지 않았다"
        return 1
      fi
      return
    fi
    sleep 2
  done
  log "프로세서가 2분 안에 파티션을 할당받지 못했다"
  return 1
}

run_one() {
  local sys=$1 s=$2 rep=$3
  local dir="$OUT/$sys/s$s/rep$rep"
  if [ -f "$dir/meta.json" ]; then
    log "건너뜀 $sys s=$s rep=$rep (이미 있음)"
    return
  fi
  rm -rf "$dir"; mkdir -p "$dir"
  log "== $sys s=$s rep=$rep"

  local net
  net=$(net_of "$sys")
  SYSTEM=$net network/network.sh down > "$dir/network.log" 2>&1 || true
  if uses_processor "$sys"; then
    # 프로세서의 사용자별 실패 기록(희생자 선택에 쓰인다)을 실행마다 비운다
    docker exec kafka-mongo-1 mongosh User --quiet --eval 'db.abortTransaction.drop()' >> "$dir/network.log" 2>&1 || true
    restart_processor "$(algo_of "$sys")" || return 1
  fi
  local step
  for step in up deploy; do
    SYSTEM=$net network/network.sh $step >> "$dir/network.log" 2>&1 || { log "실패: $step ($dir/network.log)"; return 1; }
  done
  SYSTEM=$net network/network.sh invoke init "$KEY_COUNT" "$INIT_VALUE" >> "$dir/network.log" 2>&1 \
    || { log "실패: init ($dir/network.log)"; return 1; }
  sleep 5

  snapshot "$dir/prom-before.json"
  local start end
  start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local seed=$((12345 + 1000 * rep))
  SEED=$seed caliper/run.sh "$s" "$(pwd)/$dir" || log "caliper 가 0 이 아닌 값으로 끝났다 ($sys s=$s rep=$rep)"
  sleep 6
  end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  snapshot "$dir/prom-after.json"

  if uses_processor "$sys"; then
    # 배치마다의 재정렬 시간과 프로세서가 버린 트랜잭션 ([Batch] 는 알고리즘과 무관한 요약 줄)
    docker logs --since "$start" --until "$end" kafka-processor-1 2>&1 \
      | grep -E '^\[Total Ordering Time\]|^ABORT tx|^\[Batch\]|^\[Timing\]|^\[Fabric\+\+\]|^\[Epsilon\]|^Ordering algorithm' > "$dir/processor.log" || true
  fi
  # 블록 커밋 시각 (원장 기준 라운드 시간 계산용)
  docker logs --since "$start" --until "$end" zipfbench-peer0.org1.example.com-1 2>&1 \
    | grep 'Committed block' > "$dir/peer-commits.log" || true
  docker logs --tail 200 zipfbench-orderer.example.com-1 > "$dir/orderer-tail.log" 2>&1 || true

  printf '{"system":"%s","network":"%s","algo":"%s","s":%s,"rep":%s,"seed":%s,"start":"%s","end":"%s","txNumber":%s,"tps":%s,"workers":%s,"keyCount":%s}\n' \
    "$sys" "$net" "$(algo_of "$sys")" "$s" "$rep" "$seed" "$start" "$end" "$TX_NUMBER" "$TPS" "$WORKERS" "$KEY_COUNT" > "$dir/meta.json"
  grep -E '^\| transfer' "$dir/caliper.log" | head -1 | tee -a "$LOG" || true
}

log "RUN_ID=$RUN_ID SYSTEMS=[$SYSTEMS] S=[$S_LIST] REPS=$REPS TX=$TX_NUMBER TPS=$TPS"
pause_others
# 시스템 사이의 시간에 따른 차이(열, 백그라운드 부하)가 한쪽에 몰리지 않게 시스템을 번갈아 돌린다
for rep in $(seq 1 "$REPS"); do
  for s in $S_LIST; do
    for sys in $SYSTEMS; do
      # 실패한 실행은 meta.json 이 없으므로 같은 RUN_ID 로 다시 돌리면 그것만 다시 한다
      run_one "$sys" "$s" "$rep" || log "건너뜀: $sys s=$s rep=$rep 실패"
    done
  done
done
log "끝. 정리: node aggregate.js $OUT"
