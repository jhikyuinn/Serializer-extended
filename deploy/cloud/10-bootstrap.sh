#!/bin/bash
# [모든 VM, 01-push.sh 가 부른다] 공통 준비: Docker, 시간 동기화, 커널 설정, 이름 풀이, 이미지 불러오기.
#   bash 10-bootstrap.sh <역할>
set -euo pipefail
ROLE=${1:?역할}
cd "$(dirname "$0")"; . ./cluster.env

# Docker + compose 플러그인 (Ubuntu 22.04/24.04)
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$USER" || true
sudo apt-get update -qq && sudo apt-get install -y -qq rsync chrony jq >/dev/null

# 시간 동기화: Amazon Time Sync. 여러 VM 의 로그 시각으로 지연을 나눠 재므로 꼭 필요하다
grep -q 169.254.169.123 /etc/chrony/chrony.conf || echo "server 169.254.169.123 prefer iburst minpoll 4 maxpoll 4" | sudo tee -a /etc/chrony/chrony.conf >/dev/null
sudo systemctl restart chrony

# 많은 연결·파일을 쓰므로 한도를 올린다
sudo tee /etc/sysctl.d/90-serializer.conf >/dev/null <<EOF
net.core.somaxconn=4096
net.ipv4.ip_local_port_range=10240 65000
net.ipv4.tcp_tw_reuse=1
fs.file-max=1048576
vm.max_map_count=262144
EOF
sudo sysctl -q --system
echo "* soft nofile 1048576
* hard nofile 1048576" | sudo tee /etc/security/limits.d/90-serializer.conf >/dev/null

# 이름 풀이: 다른 VM 의 컨테이너에 이름으로 닿게 한다 (TLS 인증서 이름과 같아야 한다)
sudo sed -i '/# serializer-cloud/d' /etc/hosts
{
  echo "$FABRIC_IP orderer.example.com peer0.org1.example.com peer0.org2.example.com fabric-vm # serializer-cloud"
  echo "$KAFKA_IP kafka-vm # serializer-cloud"
  echo "$CLIENT_IP client-vm # serializer-cloud"
  [ -n "${WATCHDOG_IP:-}" ] && echo "$WATCHDOG_IP watchdog-vm # serializer-cloud"
} | sudo tee -a /etc/hosts >/dev/null

# 내 PC 에서 올린 이미지
if [ -f "/tmp/$ROLE-images.tar.gz" ]; then
  echo "== 이미지 불러오기"; sudo docker load < "/tmp/$ROLE-images.tar.gz" && rm -f "/tmp/$ROLE-images.tar.gz"
fi
echo "bootstrap($ROLE) 끝"
