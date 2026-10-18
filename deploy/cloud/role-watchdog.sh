#!/bin/bash
# [④ Watchdog VM] k3s 위에 s-node 3개(§48 설정), Docker 로 w-node 10개.
# s-node Service(LoadBalancer)는 이 VM 의 IP 로 열린다(16220, 11730, 4001). w-node 는 이 VM 에서 돈다.
set -euo pipefail
cd "$(dirname "$0")"; . ./cluster.env
D="sudo docker"

# k3s (가벼운 Kubernetes). servicelb 가 LoadBalancer 를 노드 IP 로 열어 준다
if ! command -v k3s >/dev/null; then
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik --write-kubeconfig-mode 644 --node-ip $WATCHDOG_IP" sh -
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
mkdir -p ~/.kube && cp $KUBECONFIG ~/.kube/config

# s-node 이미지를 k3s 의 containerd 로 옮긴다
$D save "$SNODE_IMAGE" | sudo k3s ctr images import -

# s-node 배포: Kafka 주소만 바꾼 사본으로 적용한다
T=$(mktemp -d); cp "$WORK"/Serializer/watchdog/s-node/k8s/*.yaml "$T"/
sed -i "s#KAFKA_PROCESSOR_ADDR: .*#KAFKA_PROCESSOR_ADDR: \"$KAFKA_IP\"#; s#KAFKA_BROKERS: .*#KAFKA_BROKERS: \"$KAFKA_IP:9091,$KAFKA_IP:9092,$KAFKA_IP:9093\"#" "$T/configmap.yaml"
sed -i "s#image: watchdog/s-node:.*#image: $SNODE_IMAGE#; s#imagePullPolicy: .*#imagePullPolicy: Never#" "$T/deployment.yaml"
# kustomization 의 images 가 태그를 덮어쓰므로 거기도 맞춘다
sed -i "s#newTag: .*#newTag: ${SNODE_IMAGE##*:}#" "$T/kustomization.yaml"
kubectl apply -k "$T"
kubectl -n watchdog rollout status deploy/snode --timeout=300s

# w-node: 4 GB 라 올리지 않고 여기서 소스로 빌드한다
$D image inspect "$WNODE_IMAGE" >/dev/null 2>&1 || $D build -q -t "$WNODE_IMAGE" "$WORK/Serializer/watchdog/w-node"
cd "$WORK/Serializer/watchdog/w-node"
sudo -E env "PATH=$PATH" KUBECONFIG=$KUBECONFIG IMAGE="$WNODE_IMAGE" NAME_PREFIX=mt SNODE_HOST="$WATCHDOG_IP" BROKER_HOST="$KAFKA_IP" \
  ./run_local.sh "$WNODE_COUNT" mychannel -padding 1000000
echo "role-watchdog 끝: s-node 3개, w-node $WNODE_COUNT 개"
