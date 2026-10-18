#!/bin/bash
# Serializer 논문 Figure 16·Table I 실험: 사용자 5명(지연 4.5/50/50/50/100 ms), User3 = VIP.
# 시스템 × 긴급 설정 × 반복. 매 실행마다 네트워크를 새로 띄우고 smallbank 체인코드를 배포·init 한다.
#
#   ./userbench.sh                                     전체 (A2 FPP B × 긴급 0/1 × 3회)
#   RUN_ID=u1 SYSTEMS="B" URGENT_LIST="1" REPS=1 DURATION=10 ./userbench.sh   일부만
#
# 환경변수
#   RUN_ID        결과 폴더 이름 (results/<RUN_ID>). 같은 RUN_ID 로 다시 돌리면 끝난 실행은 건너뛴다.
#   SYSTEMS       A2 FPP B (HTF, BE, A1 도 가능. bench.sh 와 같은 이름. BE = Serializer 논문의 ε-ordering)
#   EPS_URGENT 1  EPS_LOW 0.75   BE 의 ε (논문 설정: 긴급 1, 일반 0.75. 원 논문 Fig 16의 "0.1"은 긴급 tx 비율, 실험 노트 §83)
#   ABORT_NOTIFY  true  클라이언트가 abort 토픽을 읽어 버려진 트랜잭션을 바로 끝낸다 (false 면 커밋 대기 시간까지 기다림)
#   URGENT_LIST   0 1   User3 의 쓰기 중 긴급으로 보내는 비율. 프로세서를 쓰지 않는 A1·A2 는 0 만 돈다
#                       (긴급 여부를 보는 것은 Serializer 뿐이지만, 같은 부하에서의 비교를 위해 FPP·HTF 는 둘 다 돈다)
#   REPS          3
#   TPS 250 (다섯 사용자가 나눠 보낸다)  DURATION 30  ZIPF_S 1.15  PRW 0.5  ACCOUNT_COUNT 100
#   BATCH_SIZE 100  BATCH_TIMEOUT 2s   오더러 배치 (network.sh 로 넘어간다)
#   WORKERS 5       Caliper 워커 수 (사용자 수의 배수, 사용자 하나를 워커 여럿이 나눠 보낸다)
#   MODE smallbank | custom   custom = 보조 부하 (Fabric++ custom 워크로드): ITEM_COUNT 10000 RW 4 HR 0.2 HW 0.1 HOT_SHARE 0.01 QUERY_SHARE 0(custom 의 읽기 전용 비율)
#   KAFKA_DIR     프로세서 compose 가 있는 곳 (기본 ../../kafka)
#
# 논문 조건은 사용자마다 200 TPS(합 1000 TPS)이지만 이 PC 의 Fabric 은 250 TPS 언저리에서 포화되므로
# 합계를 TPS 로 정한다. 결과 정리는 node aggregate-users.js results/<RUN_ID>
set -euo pipefail

cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1

RUN_ID="${RUN_ID:-users-$(date +%Y%m%d-%H%M)}"
SYSTEMS="${SYSTEMS:-A2 FPP B}"
URGENT_LIST="${URGENT_LIST:-0 1}"
REPS="${REPS:-3}"
export TPS="${TPS:-250}" DURATION="${DURATION:-30}" ZIPF_S="${ZIPF_S:-1.15}" PRW="${PRW:-0.5}" ACCOUNT_COUNT="${ACCOUNT_COUNT:-100}"
INIT_VALUE="${INIT_VALUE:-1000000}"
USERS="User1,User2,User3,User4,User5"
VIPS="User3"
EPS_URGENT="${EPS_URGENT:-1}" EPS_LOW="${EPS_LOW:-0.75}"
ABORT_NOTIFY="${ABORT_NOTIFY:-true}"
export WORKERS="${WORKERS:-5}"
export MODE="${MODE:-smallbank}" ITEM_COUNT="${ITEM_COUNT:-10000}" RW="${RW:-4}" HR="${HR:-0.2}" HW="${HW:-0.1}" HOT_SHARE="${HOT_SHARE:-0.01}" QUERY_SHARE="${QUERY_SHARE:-0}"
KAFKA_DIR="${KAFKA_DIR:-$(cd ../../kafka 2>/dev/null && pwd)}"
# 클라우드처럼 Kafka·프로세서가 다른 VM 에 있으면 그 VM 의 Docker 로 보낸다 (예: ssh://ubuntu@10.0.1.20, deploy/cloud)
KAFKA_DOCKER_HOST="${KAFKA_DOCKER_HOST:-}"
kd() { if [ -n "$KAFKA_DOCKER_HOST" ]; then DOCKER_HOST="$KAFKA_DOCKER_HOST" docker "$@"; else docker "$@"; fi; }
OUT="results/$RUN_ID"
PROM="http://localhost:19090"
mkdir -p "$OUT"
LOG="$OUT/bench.log"

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

net_of() { case "$1" in B|BE|FPP|HTF) echo B ;; *) echo "$1" ;; esac; }
algo_of() { case "$1" in B) echo serializer ;; BE) echo epsilon ;; FPP) echo fabricpp ;; HTF) echo htfabric ;; esac; }
uses_processor() { [ "$(net_of "$1")" = B ]; }

# ---- 다른 부하 멈추기 / 되돌리기 (bench.sh 와 같다) ----
STOPPED_FILE="$OUT/stopped-containers.txt"
PROCESSOR_TOUCHED=""
set_processor_algo() {
  [ -n "$KAFKA_DIR" ] || { log "KAFKA_DIR 을 찾지 못했다"; return 1; }
  (cd "$KAFKA_DIR" && PROCESSOR_ALGO="$1" PROCESSOR_EPS_URGENT="$EPS_URGENT" PROCESSOR_EPS_LOW="$EPS_LOW" \
    kd compose -f docker-compose.yml -f docker-compose.processor.yml up -d --no-build --force-recreate processor)
}
pause_others() {
  docker ps --format '{{.Names}}' | grep -E '^(bz[0-9]+|wnode[0-9]+|serializer-fabric-orderer\.example\.com-1)$' >> "$STOPPED_FILE" || true
  if [ -s "$STOPPED_FILE" ]; then
    log "다른 부하를 멈춘다: $(sort -u "$STOPPED_FILE" | tr '\n' ' ')"
    sort -u "$STOPPED_FILE" | xargs -r docker stop >/dev/null
  fi
}
NET_SIG_FILE="results/.net-signature"
resume_others() {
  # REUSE_NETWORK=1 이면 다음 호출이 이어 쓰도록 네트워크와 프로세서를 그대로 둔다(끝나면 직접 내린다)
  [ "${REUSE_NETWORK:-0}" = 1 ] && return 0
  rm -f "$NET_SIG_FILE"
  SYSTEM=A2 network/network.sh down >/dev/null 2>&1 || true
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

snapshot() {
  curl -s -G "$PROM/api/v1/query" \
    --data-urlencode 'query={__name__=~"ledger_block_processing_time_sum|ledger_block_processing_time_count|ledger_transaction_count",channel="mychannel"}' \
    > "$1"
}

# 이전 실행에서 남은 incoming 배치(중단된 실행 등)를 새 프로세서가 처리하지 않도록, 프로세서의
# consumer group 을 incoming 토픽의 끝으로 옮긴다. 그룹에 소비자가 없어야 하므로 프로세서를 먼저 멈춘다.
reset_processor_offsets() {
  kd stop kafka-processor-1 >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 30); do
    # 출력을 받아 둔 뒤 찾는다. "kd ... | grep -q" 는 grep 이 먼저 끝나면 kd 가 SIGPIPE 로 실패하고, pipefail 때문에
    # 찾았어도 실패로 친다(Docker over SSH 에서 늘 그랬다, deploy/cloud)
    if grep -q 'NEW-OFFSET' <<<"$(kd exec kafka-kafka1-1 kafka-consumer-groups.sh --bootstrap-server kafka1:9090 --group mychannel-incoming-group \
        --topic mychannel-incoming --reset-offsets --to-latest --execute 2>&1 </dev/null || true)"; then
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
    local plog; plog=$(kd logs --since "$since" kafka-processor-1 2>&1 </dev/null || true)
    if grep -q 'setup generation' <<<"$plog"; then
      if ! grep -q "^Ordering algorithm: $algo\$" <<<"$plog"; then
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
  local sys=$1 urgent=$2 rep=$3
  local dir="$OUT/$sys/u$urgent/rep$rep"
  if [ -f "$dir/meta.json" ]; then
    log "건너뜀 $sys urgent=$urgent rep=$rep (이미 있음)"
    return
  fi
  rm -rf "$dir"; mkdir -p "$dir"
  log "== $sys urgent=$urgent rep=$rep"

  local net sig reused=0
  net=$(net_of "$sys")
  # REUSE_NETWORK=1: 직전 실행과 네트워크 서명(시스템 종류, 배치, 타임아웃, 정렬 알고리즘, ε)이 같고 오더러가 떠 있으면
  # 네트워크와 프로세서를 다시 띄우지 않는다(실행마다 약 1분 절약, NOTES §54). 사용자 통계는 실행마다 비운다.
  sig="$net|${BATCH_SIZE:-100}|${BATCH_TIMEOUT:-2s}|$(algo_of "$sys")|$EPS_URGENT|$EPS_LOW|acct=$ACCOUNT_COUNT"
  if [ "${REUSE_NETWORK:-0}" = 1 ] && [ "$(cat "$NET_SIG_FILE" 2>/dev/null)" = "$sig" ] \
      && docker ps --format '{{.Names}}' | grep -q '^zipfbench-orderer.example.com-1$'; then
    log "네트워크 재사용 ($sig)"; reused=1
    echo "reused network $sig" > "$dir/network.log"
    uses_processor "$sys" && { kd exec kafka-mongo-1 mongosh User --quiet --eval 'db.abortTransaction.drop()' >> "$dir/network.log" 2>&1 </dev/null || true; }
    sleep 5   # 앞 실행에서 남은 트랜잭션이 끝나도록
  else
    rm -f "$NET_SIG_FILE"
    SYSTEM=$net network/network.sh down > "$dir/network.log" 2>&1 || true
    if uses_processor "$sys"; then
      kd exec kafka-mongo-1 mongosh User --quiet --eval 'db.abortTransaction.drop()' >> "$dir/network.log" 2>&1 </dev/null || true
      restart_processor "$(algo_of "$sys")" || return 1
    fi
    local step
    for step in up deploy; do
      CC=smallbank SYSTEM=$net network/network.sh $step >> "$dir/network.log" 2>&1 || { log "실패: $step ($dir/network.log)"; return 1; }
    done
    CC=smallbank SYSTEM=$net network/network.sh invoke init "$ACCOUNT_COUNT" "$INIT_VALUE" "$USERS" "$VIPS" >> "$dir/network.log" 2>&1 \
      || { log "실패: init ($dir/network.log)"; return 1; }
    echo "$sig" > "$NET_SIG_FILE"
    sleep 5
  fi

  snapshot "$dir/prom-before.json"
  local start end
  start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local seed=$((12345 + 1000 * rep))
  # 프로세서를 쓰지 않는 시스템은 abort 토픽이 없으므로 구독하지 않는다 (워커마다 Kafka 소비자가 CPU 를 쓴다)
  local notify=$ABORT_NOTIFY
  uses_processor "$sys" || notify=false
  SEED=$seed URGENT_RATIO=$urgent ABORT_NOTIFY=$notify caliper/run-users.sh "$(pwd)/$dir" || log "caliper 가 0 이 아닌 값으로 끝났다 ($sys urgent=$urgent rep=$rep)"
  sleep 6
  end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  snapshot "$dir/prom-after.json"

  if uses_processor "$sys"; then
    kd logs --since "$start" --until "$end" kafka-processor-1 2>&1 \
      | grep -E '^\[Total Ordering Time\]|^ABORT tx|^\[Batch\]|^\[Timing\]|^\[Fabric\+\+\]|^\[Epsilon\]' > "$dir/processor.log" || true
  fi
  docker logs --since "$start" --until "$end" zipfbench-peer0.org1.example.com-1 2>&1 \
    | grep 'Committed block' > "$dir/peer-commits.log" || true
  # 커밋 경로 분해용 (aggregate-path.js). -t 로 줄마다 도커 시각을 붙인다([COMMITDATA] 줄은 자체 시각이 없다)
  docker logs -t --since "$start" --until "$end" zipfbench-orderer.example.com-1 2>&1 | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -E 'COMMITDATA|Delivered message to topic|Created block|Writing block|ORDSTAT|ORDBATCH' > "$dir/orderer.log" || true

  printf '{"system":"%s","network":"%s","algo":"%s","epsUrgent":%s,"epsLow":%s,"abortNotify":%s,"urgentRatio":%s,"rep":%s,"seed":%s,"start":"%s","end":"%s","tps":%s,"duration":%s,"zipfS":%s,"prw":%s,"accountCount":%s,"batchSize":"%s","batchTimeout":"%s","mode":"%s","itemCount":%s,"rw":%s,"hr":%s,"hw":%s,"hotShare":%s,"queryShare":%s,"workers":%s,"warmupSec":%s,"reused":%s}\n' \
    "$sys" "$net" "$(algo_of "$sys")" "$EPS_URGENT" "$EPS_LOW" "$ABORT_NOTIFY" "$urgent" "$rep" "$seed" "$start" "$end" "$TPS" "$DURATION" "$ZIPF_S" "$PRW" "$ACCOUNT_COUNT" \
    "${BATCH_SIZE:-100}" "${BATCH_TIMEOUT:-2s}" "$MODE" "$ITEM_COUNT" "$RW" "$HR" "$HW" "$HOT_SHARE" "$QUERY_SHARE" "$WORKERS" "${WARMUP_SEC:-0}" "$reused" > "$dir/meta.json"
  grep -E '^\| users' "$dir/caliper.log" | head -1 | tee -a "$LOG" || true
}

log "RUN_ID=$RUN_ID SYSTEMS=[$SYSTEMS] URGENT=[$URGENT_LIST] REPS=$REPS TPS=$TPS DURATION=$DURATION s=$ZIPF_S prw=$PRW eps=$EPS_URGENT/$EPS_LOW abortNotify=$ABORT_NOTIFY"
pause_others
for rep in $(seq "${REP_START:-1}" $(( ${REP_START:-1} + REPS - 1 ))); do  # REP_START: 반복 번호를 이어 붙일 때 (순서를 섞어 돌릴 때)
  for urgent in $URGENT_LIST; do
    for sys in $SYSTEMS; do
      # 프로세서를 쓰지 않는 시스템은 긴급 여부를 보지 않으므로 긴급 0 만 돈다
      if ! uses_processor "$sys" && [ "$urgent" != 0 ]; then
        continue
      fi
      run_one "$sys" "$urgent" "$rep" || log "건너뜀: $sys urgent=$urgent rep=$rep 실패"
    done
  done
done
log "끝. 정리: node aggregate-users.js $OUT"
