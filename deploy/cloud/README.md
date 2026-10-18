# 클라우드(AWS) 실행: 1,000 TPS 실험용

로컬 PC 한 대에서는 약 400 TPS가 한계다(NOTES §27, §51). 역할을 VM 4대로 나눠 같은 실험 스크립트를 그대로 돌린다.
구성은 논문 테스트베드("Fabric, Kafka, w-node를 각각 다른 호스트에 두고 LAN으로 연결")와 같다.

## 1. AWS에서 만들 것

| VM | 역할 | 인스턴스 | 디스크 |
|---|---|---|---|
| ① client | Caliper(부하 생성) | c7i.4xlarge (16 vCPU / 32 GB) | 30 GB gp3 |
| ② fabric | 오더러, 피어 2개, 체인코드. **실험 구동도 여기서** | c7i.4xlarge (16 vCPU / 32 GB) | 100 GB gp3, IOPS 6000 |
| ③ kafka | 브로커 3, ZooKeeper 3, 프로세서, MongoDB | c7i.2xlarge (8 vCPU / 16 GB) | 50 GB gp3 |
| ④ watchdog | k3s(s-node 3), w-node 10 | m7i.2xlarge (8 vCPU / 32 GB) | 80 GB gp3 |

- **지역과 네트워크**
  - 서울(ap-northeast-2), VPC 1개, **같은 가용 영역**에 둔다.
  - OS는 Ubuntu 22.04 또는 24.04다.
- **보안 그룹**
  - 같은 보안 그룹끼리는 모든 포트를 허용한다.
  - 밖에서는 **내 IP의 22번만** 연다. Kafka와 피어 포트는 밖에 열지 않는다.
- **vCPU 한도:** 합계 약 48 vCPU다. 새 계정의 기본 한도는 이보다 작으므로 **"Running On-Demand Standard instances"를 64 이상으로 미리 신청**한다.
- **키 페어:** 하나 만들어 내 PC에 둔다(예: `~/.ssh/serializer-aws.pem`).
- **④ watchdog은 처리량만 잴 때 빼도 된다.** `cluster.env`의 `WATCHDOG_IP`를 비우면 건너뛴다. 단, w-node 합의 비용(§51)까지 넣으려면 필요하다.
- **비용:** 서울 온디맨드 기준 4대 합계 약 시간당 3~3.5달러다. 실험할 때만 켜고, 끝나면 **중지(stop)**한다.

## 2. 순서

```bash
# [내 PC] 1) cluster.env 에 VM 사설 IP, 공인 IP(SSH), 키 경로를 적는다
vi cluster.env

# [내 PC] 2) 직접 만든 이미지를 저장한다 (약 2 GB. w-node 는 VM 에서 빌드한다)
./00-export-images.sh

# [내 PC] 3) 코드·이미지를 보내고 각 VM 을 설치한다 (kafka → fabric → client → watchdog)
./01-push.sh            # 한 역할만: ./01-push.sh kafka

# [Fabric VM] 4) 연결 확인
ssh -i ~/.ssh/serializer-aws.pem ubuntu@<fabric 공인 IP>
bash /opt/work/Serializer/deploy/cloud/run.sh check

# [Fabric VM] 5) 기준선: Fabric 만 1,000 TPS 로 돌려 각 VM CPU 가 70% 아래인지 본다 (top / docker stats)
RUN_ID=cloud-base SYSTEMS=A1 URGENT_LIST=0 REPS=1 TPS=1000 DURATION=60 bash /opt/work/Serializer/deploy/cloud/run.sh

# [Fabric VM] 6) 본 실험 — 로컬과 같은 변수를 그대로 쓴다. 예: 배치 크기
for b in 100 500 1000; do
  RUN_ID=cloud-batch-b$b SYSTEMS="A1 BE" URGENT_LIST=0 REPS=3 TPS=1000 DURATION=60 \
    BATCH_SIZE=$b BATCH_TIMEOUT=5s bash /opt/work/Serializer/deploy/cloud/run.sh
done

# [내 PC] 7) 결과 가져오기
scp -r -i ~/.ssh/serializer-aws.pem ubuntu@<fabric 공인 IP>:/opt/work/HLF/fabric-samples/zipfbench/results/cloud-* \
    ../../bench/zipfbench/results/
```

긴 실험은 SSH가 끊겨도 돌도록 `nohup ... &` 또는 `tmux` 안에서 돌린다.

## 3. 무엇이 어디서 도는가

- **실험 구동:** `userbench.sh`가 Fabric VM에서 돈다. Fabric 네트워크는 실험마다 새로 띄운다(`CLOUD=1` → `network/compose.cloud.yaml`로 오더러 7050, 피어 7051·9051을 연다).
- **Kafka·프로세서:** `KAFKA_DOCKER_HOST=ssh://ubuntu@<kafka IP>`로 Kafka VM의 Docker를 직접 다룬다. 프로세서 재시작, 오프셋 초기화, 로그 수집을 여기서 한다.
- **Caliper:** `CALIPER_DOCKER_HOST=ssh://ubuntu@<client IP>`로 Client VM에서 돈다.
  - 실행마다 설정과 인증서를 rsync로 보내고 결과를 가져온다.
  - 오더러·피어 이름은 `--add-host`로 Fabric VM IP에 연결한다.
  - org2 피어는 9051로 붙는다(`connection-org1.cloud.yaml`).
- **주소:** 모두 `cluster.env`에서 나온다. `role-fabric.sh`가 Fabric VM에 `/opt/work/cloud-run.env`를 만든다(`KAFKA_BROKERS`, `KAFKA_DOCKER_HOST`, `CALIPER_DOCKER_HOST`, `CALIPER_KAFKA_BROKERS`, `FABRIC_IP` 등).
- **시간 동기화:** 모든 VM이 Amazon Time Sync(chrony)를 쓴다. 여러 VM의 로그 시각으로 구간을 나눠 재기(`aggregate-path.js`) 때문이다.

## 4. 로컬에서 바꾼 것 (클라우드를 위해, 로컬 동작은 그대로)

| 파일 | 내용 |
|---|---|
| `zipfbench/userbench.sh` | Kafka 쪽 Docker 명령을 `kd()`로 감쌌다. `KAFKA_DOCKER_HOST`가 없으면 예전과 같다 |
| `zipfbench/network/network.sh` | `CLOUD=1`이면 `compose.cloud.yaml`을 얹는다. Kafka 오프셋 초기화도 `KAFKA_DOCKER_HOST`를 따른다 |
| `zipfbench/network/compose.cloud.yaml` (신규) | 오더러·피어 포트 공개 |
| `zipfbench/caliper/run-users.sh` | `CALIPER_DOCKER_HOST`가 있으면 원격 실행. `CALIPER_TIMEOUT`(커밋 대기 시간) |
| `zipfbench/caliper/*.cloud.yaml` (신규) | org2 피어 9051 |
| `watchdog/w-node/run_local.sh` | `SNODE_HOST`, `BROKER_HOST`(기본 `HOST`), IP면 `/ip4` 주소 |

## 5. 확인하지 못한 것

- AWS에서 실제로 돌려 보지 않았다. 로컬(Windows + Docker Desktop)에서는 바꾼 스크립트가 예전처럼 도는 것만 확인했다(`results/cloudpatch-smoke`).
- 처음 돌릴 때는 다음 순서로 하나씩 확인하는 것을 권한다.
  1. `run.sh check`
  2. 짧은 실행 하나(`DURATION=15 REPS=1 SYSTEMS=A1`)
  3. `SYSTEMS=BE` 하나
  4. w-node 합의
- 문제가 생기기 쉬운 곳
  - **Kafka 접속 주소:** Kafka VM의 `.env`가 사설 IP여야 다른 VM이 붙는다.
  - **Docker 그룹:** 첫 SSH 세션에서는 docker 그룹이 아직 적용되지 않는다. `01-push.sh`가 끝난 뒤 새로 접속한다.
  - **포트 충돌:** k3s servicelb와 다른 서비스의 포트가 겹치는 경우.
