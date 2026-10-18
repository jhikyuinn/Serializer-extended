# 실행 방법

[← README](../README.md)

## 저장소 구조

```
├── fabric-patch/   Fabric 오더러 수정분(바꾼 파일만)과 적용 방법
├── kafka/          정렬 프로세서(Go), Kafka·MongoDB compose
├── watchdog/
│   ├── s-node/     커미티 구성, Kubernetes 매니페스트(k8s/)
│   └── w-node/     BFT 합의, 감사 원장, QUIC 전송 (MP2BTP 전송은 비공개)
├── bench/          Caliper 워크로드, 실행·집계·그림 스크립트
├── deploy/cloud/   AWS 4 VM 배포 스크립트
├── experiments/    클라우드 그림·데이터, MTTR 측정 스크립트
└── docs/
    ├── summary.md       문제 → 원인 → 해결 → 결과, 전체 수치 표
    └── lab-notebook.md  실험 노트(§1~§67), 모든 수치의 근거
```

## 실행 (로컬)

Windows + Docker Desktop(Kubernetes 켬)과 AWS의 Ubuntu에서 돌렸습니다. Go 빌드는 모두 Docker 안에서 하고, 명령은 저장소 루트에서 실행합니다.

```bash
# 1) 수정된 Fabric 이미지 (자세히: fabric-patch/README.md)
git clone https://github.com/hyperledger/fabric.git fabric && git -C fabric checkout 08cd8a667
cp -r fabric-patch/files/. fabric/
#    → fabric-patch/README.md 의 docker build 명령으로 serializer/fabric-{orderer,peer,tools} 빌드

# 2) Kafka + 프로세서 + MongoDB
cd kafka && cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.processor.yml up -d && cd ..

# 3) s-node (Kubernetes) — 태그는 k8s/kustomization.yaml 의 newTag 와 같게
docker build -t watchdog/s-node:mttr-1017g watchdog/s-node
kubectl apply -k watchdog/s-node/k8s

# 4) w-node 4개 (커미티 최소 4명)
docker build -t watchdog/w-node:latest watchdog/w-node
watchdog/w-node/run_local.sh 4 mychannel -padding 1000000

# 5) 벤치마크: 같은 소스 Fabric(A1) 대 Serializer(BE)
cd bench/zipfbench
RUN_ID=demo SYSTEMS="A1 BE" URGENT_LIST=0 REPS=1 ./userbench.sh
node aggregate-users.js results/demo
```

클라우드(1,000 TPS) 실행은 [deploy/cloud/README.md](../deploy/cloud/README.md)에 있습니다.
