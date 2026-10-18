# 🌟 Watchdog s-node

## 다중 s-node 구성 (active-standby)

s-node pod를 여러 개 띄워 두고 그중 하나만 동작시킨다. 동작 중인 pod가 멈추면 대기 중인 pod가 이어받는다.

- 모든 pod가 Kubernetes Lease(`snode-active`)를 두고 경쟁한다. Lease를 잡은 pod가 활성 s-node다.
- 활성 pod만 libp2p 네트워크를 열고, 자기 pod의 라벨을 `snode-role=active`로 바꾼다. Service는 이 라벨이 붙은 pod로만 트래픽을 보내므로 w-node는 항상 활성 pod 하나에 연결된다.
- 대기 pod는 libp2p 포트를 열지 않고, gRPC 등록 요청은 `Unavailable`로 거절한다.
- 모든 pod는 Kafka `snode-keys` 토픽의 libp2p 키를 공유한다. 활성 pod가 바뀌어도 peer ID가 같아서 w-node는 같은 주소로 다시 접속하면 된다.
- 활성 pod가 Lease를 잃으면 프로세스를 종료한다. 연결돼 있던 w-node가 새 활성 pod로 옮겨 가게 하기 위해서다. Kubernetes가 컨테이너를 다시 띄우면 대기 상태로 돌아온다.
- w-node는 s-node와 연결이 끊기면 다시 접속하고, 접속되면 등록을 다시 보낸다. 새 활성 pod는 멤버 정보 없이 시작하기 때문이다.

설계 과정과 검토한 대안은 [docs/lab-notebook.md](../../docs/lab-notebook.md)에 있다.

## 이미지 빌드

```bash
docker build -t <registry>/s-node:<tag> .
docker push <registry>/s-node:<tag>
```

## Kubernetes 배포

`k8s/configmap.yaml`의 Kafka 주소와 `k8s/kustomization.yaml`의 이미지, pod 수(`replicas`)를 환경에 맞게 고친 뒤 적용한다.

```bash
kubectl apply -k k8s
kubectl -n watchdog get pods -l app=snode -L snode-role   # 활성 pod 확인
kubectl -n watchdog get lease snode-active                # Lease 보유 pod 확인
```

`configmap.yaml`의 기본값 `host.docker.internal`은 Docker Desktop의 Kubernetes에서 호스트 PC를 가리킨다. Kafka의 advertised listener도 pod에서 닿는 주소여야 한다.

### 코드를 고친 뒤 다시 배포할 때

이미지 태그를 매번 바꿔야 한다. 같은 태그(`latest`)로 다시 빌드하고 `rollout restart`만 하면, Kubernetes 노드가 전에 받아 둔 이미지를 그대로 써서 변경이 반영되지 않는다.

```bash
TAG=dev-$(date +%m%d-%H%M%S)
docker build -t watchdog/s-node:$TAG .
kubectl -n watchdog set image deploy/snode snode=watchdog/s-node:$TAG
kubectl -n watchdog rollout status deploy/snode
```

w-node는 `snode` Service의 외부 IP로 접속한다 (`-snode <IP>`, `-libp2p /ip4/<IP>/tcp/4001/p2p/<peer ID>`). peer ID는 `/status`에서 확인한다.

## 상태 확인

각 pod의 8080 포트에서 확인할 수 있다.

| 경로 | 내용 |
|---|---|
| `/healthz` | 프로세스 생존 |
| `/readyz` | 시작 완료 여부 (대기 pod도 200) |
| `/status` | 활성 여부, peer ID, 연결된 peer 수, 채널, 멤버 수 |

```bash
kubectl -n watchdog port-forward <pod> 8080 &
curl localhost:8080/status
```

## 실행 옵션

| 플래그 | 기본값 | 설명 |
|---|---|---|
| `-kafkaprocessor` | `127.0.0.1` | Kafka 프로세서 주소 (채널 목록 조회) |
| `-brokers` | `<kafkaprocessor>:9091,9092,9093` | Kafka 브로커 목록 |
| `-replication` | `3` | 키 토픽(`snode-keys`)의 복제 계수 |
| `-standalone` | `false` | Lease 없이 단일 노드로 실행 |
| `-status` | `:8080` | 상태 확인 HTTP 주소 |

Kubernetes 밖에서 실행하면(`KUBECONFIG`도 없고 pod 안도 아니면) 자동으로 단일 노드로 동작한다.

Lease 경쟁에는 환경 변수 `POD_NAME`, `POD_NAMESPACE`가 필요하다. `k8s/deployment.yaml`이 넣어 준다.
