#!/bin/bash
# [내 PC] 코드·설정·이미지를 각 VM 의 $WORK 로 보내고, 역할별 설치 스크립트를 실행한다.
#   ./01-push.sh            네 VM 모두 (cluster.env 에서 IP 가 빈 VM 은 건너뛴다)
#   ./01-push.sh kafka      한 역할만 (fabric | kafka | client | watchdog)
# 순서: kafka → fabric → client → watchdog. fabric 이 만든 SSH 키를 kafka·client 에 등록한다
# (실험을 Fabric VM 에서 구동하며 Docker over SSH 로 Kafka·Client VM 을 다루기 때문).
set -euo pipefail
cd "$(dirname "$0")"; . ./cluster.env
SER="$(cd ../.. && pwd)"                       # 저장소 루트
ZB="$SER/bench/zipfbench"
SSHO=(-i "${SSH_KEY/#\~/$HOME}" -o StrictHostKeyChecking=accept-new)
host_of() { case $1 in fabric) echo "$SSH_HOST_FABRIC";; kafka) echo "$SSH_HOST_KAFKA";; client) echo "$SSH_HOST_CLIENT";; watchdog) echo "$SSH_HOST_WATCHDOG";; esac; }
ip_of()   { case $1 in fabric) echo "$FABRIC_IP";; kafka) echo "$KAFKA_IP";; client) echo "$CLIENT_IP";; watchdog) echo "$WATCHDOG_IP";; esac; }
on() { ssh "${SSHO[@]}" "$SSH_USER@$(host_of "$1")" "${@:2}"; }

push_role() {
  local role=$1 h; h=$(host_of "$role")
  [ -n "$(ip_of "$role")" ] && [ -n "$h" ] || { echo "-- $role: 설정이 비어 건너뛴다"; return; }
  echo "=============== $role ($h)"
  on "$role" "sudo mkdir -p $WORK && sudo chown \$USER $WORK"
  # 코드: 역할에 필요한 것만. .git·결과·백업은 뺀다
  local ex=(--exclude=.git --exclude='*.bak-*' --exclude='results' --exclude='node_modules' --exclude='images/*.tar.gz')
  # VM 안에서는 예전 배치를 그대로 쓴다: $WORK/Serializer/{deploy,kafka,watchdog}, $WORK/HLF/fabric-samples/zipfbench
  tar czf - "${ex[@]}" --transform 's,^,Serializer/,' -C "$SER" deploy kafka watchdog | on "$role" "tar xzf - -C $WORK"
  if [ "$role" = fabric ] || [ "$role" = client ]; then
    tar czf - "${ex[@]}" --transform 's,^,fabric-samples/,' -C "$SER/bench" zipfbench | on "$role" "mkdir -p $WORK/HLF && tar xzf - -C $WORK/HLF"
  fi
  [ -f "images/$role.tar.gz" ] && { echo "== 이미지 올리기 (images/$role.tar.gz)"; on "$role" "cat > /tmp/$role-images.tar.gz" < "images/$role.tar.gz"; }
  on "$role" "bash $WORK/Serializer/deploy/cloud/10-bootstrap.sh $role && bash $WORK/Serializer/deploy/cloud/role-$role.sh"
}

roles=("${@:-kafka fabric client watchdog}"); roles=(${roles[*]})
for r in "${roles[@]}"; do
  push_role "$r"
  if [ "$r" = fabric ]; then
    # Fabric VM 의 키를 Kafka·Client VM 에 등록 (Docker over SSH 용)
    pub=$(on fabric "cat ~/.ssh/id_ed25519.pub")
    for t in kafka client; do [ -n "$(host_of $t)" ] && on "$t" "grep -qF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys"; done
  fi
done
echo "끝. 실험은 Fabric VM 에서: ssh $SSH_USER@$SSH_HOST_FABRIC  →  bash $WORK/Serializer/deploy/cloud/run.sh  (README 참고)"
