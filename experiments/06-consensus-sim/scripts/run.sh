#!/bin/bash
# Figure 5.7: s-node replica 수와 pod별 장애 확률에 따른 합의 성공률을 실제 스택에서 잰다.
#
#   OUT=<결과 폴더> ./run.sh
#
# 환경 변수
#   REPLICAS="1 2 3 4 5"   s-node pod 수
#   PROBS="15 10 5 1"      pod별 장애 확률(%)
#   ROUNDS=500             설정마다 세는 라운드 수
#   PERIOD=10              라운드 간격(초). 라운드마다 abort 기록 하나를 넣는다
#   WARMUP=6               세지 않는 준비 라운드 수
#   DOWN_ROUNDS=1          멈춘 pod가 멈춰 있는 라운드 수
#   SEED=57                장애 일정의 난수 시드
#   FREEZE_ACTIVE_EVERY=0  0보다 크면 확률을 쓰지 않고 이 라운드 수마다 활성 pod를 멈춘다
#                          (인계 시간 시험용. 결과는 failover.js로 본다)
#
# 라운드가 시작될 때 떠 있는 각 pod를 확률 p로 멈춘다(SIGSTOP). 멈춘 pod는 DOWN_ROUNDS 라운드
# 뒤에 풀린다. 멈춰 있는 동안에는 다시 뽑지 않는다.
# 성공 여부는 analyze.js가 w-node 로그에서 계산한다(기록부터 블록까지의 시간).
#
# 미리 띄워 둘 것: Kafka, s-node(Deployment snode), w-node 컨테이너 bz1..bz10.
# 끝난 설정은 <OUT>/<설정>/done 으로 표시하므로, 중간에 끊겨도 다시 실행하면 이어서 한다.
set -u
export MSYS_NO_PATHCONV=1

OUT="${OUT:?OUT=<결과 폴더> 를 지정한다}"
REPLICAS="${REPLICAS:-1 2 3 4 5}"
PROBS="${PROBS:-15 10 5 1}"
ROUNDS="${ROUNDS:-500}"
PERIOD="${PERIOD:-10}"
WARMUP="${WARMUP:-6}"
DOWN_ROUNDS="${DOWN_ROUNDS:-1}"
SEED="${SEED:-57}"
FREEZE_ACTIVE_EVERY="${FREEZE_ACTIVE_EVERY:-0}"
MAX_SLOTS=5
PREFIX="${PREFIX:-bz}"
NODES="${NODES:-10}"
KNODE="${KNODE:-desktop-control-plane}"
KAFKA="${KAFKA:-kafka-kafka1-1}"
K="kubectl --context docker-desktop -n watchdog"
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$OUT"
log() { echo "$(date '+%m-%d %H:%M:%S') $*" | tee -a "$OUT/run.log"; }

# s-node 프로세스 목록: "pid pod이름"
snode_pids() {
  docker exec "$KNODE" sh -c 'for p in $(pgrep -x validator); do h=$(tr "\0" "\n" </proc/$p/environ 2>/dev/null | sed -n "s/^HOSTNAME=//p"); case "$h" in snode-*) echo "$p $h";; esac; done' 2>/dev/null
}
send_signal() { # send_signal STOP|CONT pid...
  [ $# -gt 1 ] || return 0
  docker exec "$KNODE" sh -c "kill -$1 ${*:2}" 2>/dev/null
}
resume_all() { send_signal CONT $(snode_pids | cut -d' ' -f1); }

wait_snodes() { # pod가 n개 모두 Ready이고 활성 pod가 하나일 때까지
  local n=$1 i lines
  for i in $(seq 1 90); do
    lines=$($K get pods -l app=snode --no-headers -L snode-role 2>/dev/null)
    if [ "$(echo "$lines" | grep -c .)" = "$n" ] &&
       [ "$(echo "$lines" | grep -c '1/1 *Running')" = "$n" ] &&
       [ "$(echo "$lines" | grep -c ' active$')" = "1" ]; then
      return 0
    fi
    sleep 2
  done
  log "WARNING: s-node pods did not settle at $n replica(s)"
  return 1
}

ensure_wnodes() {
  local i
  for i in $(seq 1 "$NODES"); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$PREFIX$i" 2>/dev/null)" != "true" ]; then
      log "WARNING: $PREFIX$i is not running, starting it"
      docker start "$PREFIX$i" >/dev/null
    fi
  done
}

sleep_until_ns() {
  local rem=$(( ($1 - $(date +%s%N)) / 1000000 ))
  if [ "$rem" -gt 0 ]; then sleep "$((rem / 1000)).$(printf %03d $((rem % 1000)))"; fi
}

# 마지막 블록이 담은 가장 오래된 기록의 timestamp(ms). 블록이 없으면 0.
last_block_oldest() {
  local line iso el
  line=$(docker logs -t --since "$1" "$PREFIX$NODES" 2>&1 | grep 'consensus elapsed time' | tail -1)
  [ -n "$line" ] || { echo 0; return; }
  iso=${line%% *}
  el=$(echo "$line" | sed -n 's/.*elapsed time: \([0-9.]*\) seconds.*/\1/p' | awk '{printf "%d", $1 * 1000}')
  echo $(( $(date -d "$iso" +%s%3N) - el ))
}

# 표식 tag의 기록보다 뒤에 올린 기록이 블록에 들어갈 때까지 채움 기록을 넣으며 기다린다.
# 그래야 tag의 기록이 어느 블록에 들어갔는지 정해진다.
drain_after() { # drain_after 설정이름 tag 시작시각
  local id=$1 tag=$2 since=$3 ts i
  ts=$(docker exec "$KAFKA" sh -c "grep '^$tag ' /tmp/fig57_$id.rec | cut -d' ' -f2")
  [ -n "$ts" ] || { log "WARNING: record $tag was not produced"; return 1; }
  for i in $(seq 1 30); do
    echo "f$tag.$i" >&3
    sleep "$PERIOD"
    if [ "$(last_block_oldest "$since")" -gt "$ts" ]; then return 0; fi
  done
  log "WARNING: records after $tag were not recorded within $((30 * PERIOD))s"
  return 1
}

run_setting() {
  local n=$1 p=$2 id="n${1}_p${2}" dir="$OUT/n${1}_p${2}"
  if [ -f "$dir/done" ]; then log "$id: already done"; return; fi
  rm -rf "$dir"; mkdir -p "$dir"
  log "$id: start (replicas=$n, failure probability=$p%)"

  resume_all
  $K scale deploy/snode --replicas="$n" >/dev/null
  wait_snodes "$n"
  ensure_wnodes

  local since; since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  exec 3> >(docker exec -i "$KAFKA" bash /tmp/fig57_produce.sh "$id")
  sleep 5

  local i
  for i in $(seq 1 "$WARMUP"); do echo "w$i" >&3; sleep "$PERIOD"; done
  drain_after "$id" "w$WARMUP" "$since"

  # pod를 이름순으로 1..n번 자리에 둔다. 자리마다 남은 멈춤 라운드 수를 센다.
  local slots=() down=() s
  mapfile -t slots < <($K get pods -l app=snode --no-headers -o custom-columns=N:.metadata.name | sort)
  for s in $(seq 0 $((MAX_SLOTS - 1))); do down[$s]=0; done
  # 장애 일정은 확률과 시드로만 정해진다. 라운드마다 자리 수와 상관없이 MAX_SLOTS개를 뽑으므로
  # replica 수가 달라도 같은 라운드에 같은 자리의 pod가 멈춘다.
  RANDOM=$(( SEED + p ))

  echo "round,host_ms,pods,active,frozen" > "$dir/events.csv"
  local t0 r target list roles active stop cont names draw pid
  t0=$(date +%s%N)
  for r in $(seq 1 "$ROUNDS"); do
    target=$(( t0 + (r - 1) * PERIOD * 1000000000 ))
    sleep_until_ns "$target"

    list=$(snode_pids)
    roles=$($K get pods -l app=snode --no-headers -L snode-role 2>/dev/null)
    active=$(echo "$roles" | awk '$NF == "active" {print $1}' | tr '\n' ';')
    stop=""; cont=""; names=""
    for s in $(seq 0 $((MAX_SLOTS - 1))); do
      draw=$(( (RANDOM * 32768 + RANDOM) % 10000 ))
      [ "$s" -lt "${#slots[@]}" ] || continue
      pid=$(echo "$list" | awk -v h="${slots[$s]}" '$2 == h {print $1}')
      if [ "${down[$s]}" -gt 0 ]; then
        down[$s]=$(( ${down[$s]} - 1 ))
        [ "${down[$s]}" -gt 0 ] || cont="$cont $pid"
      elif [ "$FREEZE_ACTIVE_EVERY" -gt 0 ]; then
        # 인계 시간 시험: 확률 대신 정해진 라운드마다 활성 pod를 멈춘다
        if [ $(( r % FREEZE_ACTIVE_EVERY )) -eq 0 ] && [ "${slots[$s]};" = "$active" ]; then
          down[$s]=$DOWN_ROUNDS
        fi
      elif [ "$draw" -lt $(( p * 100 )) ]; then
        down[$s]=$DOWN_ROUNDS
      fi
      # 멈춰 있어야 할 pod에는 매번 다시 보낸다(재시작 중이라 놓친 경우를 메운다)
      if [ "${down[$s]}" -gt 0 ]; then stop="$stop $pid"; names="$names${slots[$s]};"; fi
    done
    send_signal CONT $cont
    send_signal STOP $stop
    echo "$r,$(date +%s%3N),$(echo "$list" | grep -c .),$active,$names" >> "$dir/events.csv"

    echo "r$r" >&3
    if [ $(( r % 50 )) -eq 0 ]; then log "$id: round $r/$ROUNDS"; ensure_wnodes; fi
  done
  sleep $(( PERIOD * DOWN_ROUNDS ))
  resume_all
  drain_after "$id" "r$ROUNDS" "$since"
  exec 3>&-

  docker exec "$KAFKA" cat "/tmp/fig57_$id.rec" > "$dir/records.txt"
  for i in $(seq 1 "$NODES"); do
    docker logs -t --since "$since" "$PREFIX$i" 2>&1 |
      grep -E 'consensus elapsed time|Byzantine leader|Leader consensus node|CommitteeMsg Round' > "$dir/$PREFIX$i.log"
  done
  touch "$dir/done"
  node "$(cygpath -w "$HERE/analyze.js")" "$(cygpath -w "$OUT")" > "$OUT/results.csv"
  log "$id: done -> $(grep "^$n,$p," "$OUT/results.csv")"
}

docker cp "$(cygpath -w "$HERE/produce.sh")" "$KAFKA:/tmp/fig57_produce.sh" >/dev/null || exit 1
log "experiment start: replicas=[$REPLICAS] probs=[$PROBS] rounds=$ROUNDS period=${PERIOD}s down=$DOWN_ROUNDS round(s) seed=$SEED"
for p in $PROBS; do
  for n in $REPLICAS; do
    run_setting "$n" "$p"
  done
done
resume_all
log "experiment finished"
