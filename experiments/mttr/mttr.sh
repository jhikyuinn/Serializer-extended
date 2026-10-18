#!/bin/bash
# s-node 장애에서 w-node 재등록까지의 MTTR 을 잰다 (NOTES §48).
#
#   OUT=<결과 폴더> CONFIG=new|old TRIALS=10 ./mttr.sh
#
# 활성 s-node 에 장애를 넣고(SIGTERM = pod 삭제, SIGKILL = 프로세스 강제 종료, SIGSTOP = 멈춤),
# 넣은 시각부터 w-node 10개가 모두 새 커미티를 적용(로그 "CommitteeMsg Round: N 적용됨")할 때까지를 잰다.
# 시각은 모두 Docker VM 시계로 잰다(장애를 넣는 시각은 kind 노드 컨테이너의 date, 로그는 docker/kubectl 시각).
#   new: Lease 2s/1.5s/0.5s, 커미티 즉시 생성, w-node 확인 1s·재시도 0.2s·등록 대기 1s (§48 기본값)
#   old: Lease 6s/4s/1s, 커미티 3초 대기, w-node 확인 3s·재접속 대기 5s·재시도 1s·등록 대기 5s (예전 값)
set -u
export MSYS_NO_PATHCONV=1
OUT="${OUT:?OUT=<결과 폴더>}"; CONFIG="${CONFIG:-new}"; TRIALS="${TRIALS:-10}"; NODES="${NODES:-10}"
KNODE=desktop-control-plane
K="kubectl -n watchdog"
WIMAGE="${WIMAGE:-watchdog/w-node:mttr-1017f}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
log() { echo "$(date '+%H:%M:%S') $*" | tee -a "$OUT/run.log"; }

vm_ms() { docker exec $KNODE date +%s%3N; }
active_pod() { $K get pods -l snode-role=active -o name 2>/dev/null | head -1 | cut -d/ -f2; }
pid_of() { docker exec $KNODE sh -c "for p in \$(pgrep -x validator); do tr '\0' '\n' </proc/\$p/environ 2>/dev/null | grep -qx 'HOSTNAME=$1' && echo \$p; done" | head -1; }

wait_ready() { # 3 pod 가 Ready, 활성 1개
  for i in $(seq 1 120); do
    local ready act
    ready=$($K get pods -l app=snode --no-headers 2>/dev/null | awk '$2=="1/1" && $3=="Running"' | wc -l)
    act=$($K get pods -l snode-role=active --no-headers 2>/dev/null | wc -l)
    [ "$ready" = 3 ] && [ "$act" = 1 ] && return 0
    sleep 1
  done
  log "s-node 가 120초 안에 준비되지 않았다"; return 1
}


start_wnodes() {
  local extra=()
  [ "$CONFIG" = old ] && extra=(-snodeping 3s -snodedial 5s -regretry 1s -regtimeout 5s)
  ( cd "$HERE/../../w-node" && IMAGE="$WIMAGE" NAME_PREFIX=mt ./run_local.sh "$NODES" mychannel -padding 1000000 "${extra[@]}" )
}

set_snode_config() {
  if [ "$CONFIG" = old ]; then
    $K set env deploy/snode SNODE_LEASE_DURATION=6s SNODE_RENEW_DEADLINE=4s SNODE_RETRY_PERIOD=1s SNODE_EARLY_COMMITTEE=0 >/dev/null
  else
    $K set env deploy/snode SNODE_LEASE_DURATION- SNODE_RENEW_DEADLINE- SNODE_RETRY_PERIOD- SNODE_EARLY_COMMITTEE- SNODE_EARLY_GRACE- >/dev/null
    # 그 밖의 CONFIG 이름은 새 설정에 SNODE_ENV(예: "SNODE_EARLY_GRACE=1s")를 더한다
    [ -n "${SNODE_ENV:-}" ] && $K set env deploy/snode $SNODE_ENV >/dev/null
  fi
  $K rollout status deploy/snode --timeout=240s >/dev/null
  wait_ready
}

log "CONFIG=$CONFIG TRIALS=$TRIALS NODES=$NODES"
set_snode_config
start_wnodes
sleep 25
echo "config,type,trial,t0,takeover_ms,mttr_ms,applied,victim" > "$OUT/trials.csv"

for type in ${TYPES:-term kill stop}; do
  for n in $(seq 1 "$TRIALS"); do
    wait_ready || break
    sleep 8
    victim=$(active_pod); pid=$(pid_of "$victim")
    [ -n "$victim" ] && [ -n "$pid" ] || { log "활성 pod 또는 pid 를 찾지 못했다 ($victim/$pid)"; continue; }
    case $type in
      term) t0=$(vm_ms); $K delete pod "$victim" --wait=false >/dev/null ;;
      kill) t0=$(docker exec $KNODE sh -c "date +%s%3N; kill -9 $pid" | head -1) ;;
      stop) t0=$(docker exec $KNODE sh -c "date +%s%3N; kill -STOP $pid" | head -1) ;;
    esac
    # 끝: w-node 가 모두 새 커미티를 적용 (실제 시간 60초 상한). 찾은 노드는 다시 묻지 않는다
    declare -A seen=(); start=$SECONDS
    since_s=$(awk -v t="$t0" 'BEGIN{printf "%.3f", t/1000}')
    while [ ${#seen[@]} -lt "$NODES" ] && [ $((SECONDS - start)) -lt 60 ]; do
      for i in $(seq 1 "$NODES"); do
        [ -n "${seen[$i]:-}" ] && continue
        t=$(docker logs -t --since "$since_s" "mt$i" 2>&1 | grep -m1 "CommitteeMsg Round: .* 적용됨" | cut -d' ' -f1)
        [ -n "$t" ] && seen[$i]=$(date -d "$t" +%s%3N)
      done
      [ ${#seen[@]} -lt "$NODES" ] && sleep 0.3
    done
    cnt=${#seen[@]}; mttr=""
    [ "$cnt" -ge "$NODES" ] && mttr=$(( $(printf '%s\n' "${seen[@]}" | sort -n | tail -1) - t0 ))
    unset seen
    # 다른 pod(또는 다시 뜬 같은 pod)가 활성이 된 시각
    since=$(date -u -d "@$(awk -v t="$t0" 'BEGIN{printf "%.3f", t/1000}')" +%Y-%m-%dT%H:%M:%S.%3NZ)
    tk=$($K logs -l app=snode --timestamps --since-time="$since" --tail=-1 2>/dev/null | grep "is now the active s-node" | head -1 | cut -d' ' -f1)
    takeover=""; [ -n "$tk" ] && takeover=$(( $(date -d "$tk" +%s%3N) - t0 ))
    [ "$type" = stop ] && docker exec $KNODE kill -CONT "$pid" 2>/dev/null
    # 같은 pod 를 여러 번 죽이면 Kubernetes 가 재시작을 점점 늦춘다(CrashLoopBackOff). 다음 시도 전에 새 pod 로 바꾼다
    [ "$type" != term ] && $K delete pod "$victim" --wait=false >/dev/null 2>&1
    log "$CONFIG $type #$n victim=$victim takeover=${takeover:-?}ms mttr=${mttr:-timeout}ms applied=$cnt/$NODES"
    echo "$CONFIG,$type,$n,$t0,$takeover,$mttr,$cnt,$victim" >> "$OUT/trials.csv"
  done
done
log "끝"
