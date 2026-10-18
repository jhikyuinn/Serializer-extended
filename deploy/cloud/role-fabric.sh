#!/bin/bash
# [② Fabric VM] 오더러·피어 이미지 준비, 실험 구동 환경(cloud-run.env), Kafka·Client VM 으로 가는 SSH 키.
# Fabric 네트워크 자체는 실험마다 userbench.sh 가 network.sh 로 새로 띄운다(CLOUD=1 → 포트를 연다).
set -euo pipefail
cd "$(dirname "$0")"; . ./cluster.env
D="sudo docker"
$D tag "$ORDERER_IMAGE" serializer/fabric-orderer:latest
# A2 (공식 Fabric 2.5.10) 와 Prometheus 는 Docker Hub 에서 받는다
for i in hyperledger/fabric-orderer:2.5.10 hyperledger/fabric-peer:2.5.10 hyperledger/fabric-tools:2.5.10 prom/prometheus:v2.53.0; do
  $D image inspect "$i" >/dev/null 2>&1 || $D pull -q "$i"
done
# compose.yaml 은 오더러를 kafka_default 망에도 붙인다. 이 VM 에는 Kafka 가 없으니 빈 망을 만들어 둔다
$D network inspect kafka_default >/dev/null 2>&1 || $D network create kafka_default >/dev/null
# 프로세서를 다시 띄울 때 쓰는 compose 설정(.env)은 Kafka VM 과 같아야 한다
printf 'KAFKA_BROKER1=%s:9091\nKAFKA_BROKER2=%s:9092\nKAFKA_BROKER3=%s:9093\n' "$KAFKA_IP" "$KAFKA_IP" "$KAFKA_IP" > "$WORK/Serializer/kafka/.env"

# Docker over SSH 용 키 (01-push.sh 가 공개키를 Kafka·Client VM 에 등록한다)
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519
grep -q "# serializer-cloud" ~/.ssh/config 2>/dev/null || cat >> ~/.ssh/config <<EOF
# serializer-cloud
Host $KAFKA_IP $CLIENT_IP kafka-vm client-vm
  User $SSH_USER
  StrictHostKeyChecking accept-new
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
EOF
chmod 600 ~/.ssh/config

# 실험 구동 환경. run.sh 가 읽는다
cat > "$WORK/cloud-run.env" <<EOF
export CLOUD=1
export FABRIC_IP=$FABRIC_IP
export KAFKA_BROKERS=$KAFKA_IP:9091,$KAFKA_IP:9092,$KAFKA_IP:9093
export KAFKA_DOCKER_HOST=ssh://$SSH_USER@$KAFKA_IP
export KAFKA_DIR=$WORK/Serializer/kafka
export CALIPER_DOCKER_HOST=ssh://$SSH_USER@$CLIENT_IP
export CALIPER_REMOTE_DIR=$WORK/zipfbench-client
export CALIPER_KAFKA_BROKERS="$KAFKA_IP:9091, $KAFKA_IP:9092, $KAFKA_IP:9093"
export WORKERS=${WORKERS:-$WORKERS}
export CALIPER_TIMEOUT=${CALIPER_TIMEOUT:-$CALIPER_TIMEOUT}
EOF
echo "role-fabric 끝. 실험 환경: $WORK/cloud-run.env"
