# 클라우드 s 실험 세팅 (NOTES §54~§55, 2026-10-17 ~ 10-18)

## 1. 목적

- **목적:** Zipf s(혼잡도)와 Fabric 배치 크기를 바꿔 가며, 초당 1,000 tx에서 Serializer와 같은 소스 Fabric을 비교한다.
- **질문:** 어느 s에서 Serializer가 앞서는가(역전 지점), 그리고 배치 크기가 그 차이를 어떻게 바꾸는가.

## 2. 환경 (AWS 서울, VM 4대, 같은 VPC)

| VM | 역할 | 인스턴스 | 디스크 |
|---|---|---|---|
| ① client | Caliper(부하 생성, 사용자 5명) | c7i.4xlarge (16 vCPU / 32 GB) | 30 GB gp3 |
| ② fabric | 오더러 1(etcdraft), 피어 2(org1·org2), smallbank 체인코드(ccaas), 실험 구동 | c7i.4xlarge (16 vCPU / 32 GB) | 100 GB gp3, IOPS 6000 |
| ③ kafka | Kafka 브로커 3, ZooKeeper 3, 프로세서, MongoDB | c7i.2xlarge (8 vCPU / 16 GB) | 50 GB gp3 |
| ④ watchdog | k3s 위 s-node 3(활성 1 + 대기 2, Lease 2 s), w-node 10 | m7i.2xlarge (8 vCPU / 32 GB) | 80 GB gp3 |

- **시계:** Amazon Time Sync로 맞췄다.
- **배포:** `deploy/cloud/`

## 3. 비교 대상

| 이름 | 내용 |
|---|---|
| **Fabric (A1)** | 같은 소스로 빌드한 원래 Fabric 오더러. Kafka 경로를 거치지 않고, 배치를 그대로 블록으로 만든다 |
| **Serializer (BE)** | 오더러가 배치의 tx 메타데이터를 Kafka로 보낸다. 프로세서가 ε-정렬(ε_urgent 0.1 / ε_low 0.75)로 순서를 정하고 충돌 tx는 abort한다. 오더러는 그 순서로 블록을 만든다 |

**Serializer 경로의 세부 설정**
- 메타데이터만 전송한다(§46).
- abort 레코드는 별도 producer로 보낸다(`-abort-mode separate`, §38).
- 오더러는 배치 하나의 결과를 받은 뒤 다음 배치를 보낸다(lock-step).
- w-node 합의를 켰다(별도 VM).

## 4. 변수

| 변수 | 값 |
|---|---|
| Zipf s | 0, 0.5, 1.0, 1.5, 2.0 |
| 배치 크기 (MaxMessageCount) | 100, 500, 1000 |
| BatchTimeout | 2 s / 5 s / 10 s. 크기로 잘리도록 넉넉히 둔다 |

## 5. 고정 조건

| 항목 | 값 |
|---|---|
| 부하 | smallbank 6종. 쓰기 5종(TransactSavings, DepositChecking, SendPayment, WriteCheck, Amalgamate) 50%, 읽기 Query 50%(prw 0.5) |
| 계좌 | 100개. 계좌 선택은 Zipf(s) |
| 전송률 | 1,000 TPS fixed-rate. Caliper 워커 5개가 나눠 보낸다(사용자 1명 = 워커 1개) |
| 사용자 지연 | 4.5 / 50 / 50 / 50 / 100 ms. **보내기 전에 sleep하는 흉내다. 실제 망이 아니다(§61)** |
| 긴급 tx | 0 (VIP User3 긴급 비율 0) |
| abort 통보 | 켬. 클라이언트가 abort 토픽을 구독해 버려진 tx를 바로 끝낸다 |
| 실행 길이 | 30초. 앞 5초를 뺀 25초만 집계한다(`tallySteady`) |
| 커밋 대기 한도 | 30초(`CALIPER_TIMEOUT`). 실제 시간 초과는 0건 |
| 시드 | 바퀴마다 12345 + 1000 × 바퀴. 같은 바퀴의 두 시스템은 같은 tx 열을 보낸다 |

## 6. 반복과 순서

- **반복:** 3바퀴. 조건 15개 × 시스템 2개 × 3 = 90회이고, 모두 정상이었다.
- **순서 섞기:** 바퀴마다 (시스템, 배치) 묶음 6개의 순서를 섞고, 묶음 안에서도 s 순서를 섞었다(`HLF/bench-scripts/cloud-sb.sh`).
- **네트워크 재사용:** 같은 (시스템, 배치) 묶음 안에서는 Fabric 네트워크를 다시 쓴다(`REUSE_NETWORK=1`).
  - 새로 띄운 것은 18회, 재사용은 72회다.
  - 사전 점검에서 새로 띄운 것과 재사용의 차이는 0.3%였다.
  - 재사용 서명에는 배치, timeout, 알고리즘, ε, 계좌 수가 들어간다.

## 7. 측정값

| 지표 | 정의 |
|---|---|
| 성공 처리량 | 커밋에 성공한 tx 수 / 25초 |
| 성공률, Query 성공률 | 성공 / 보낸 tx (전체, 읽기 전용 tx만) |
| 커밋 지연 | 성공한 tx의 제출부터 커밋 통보까지(sleep 제외) |
| 결과까지 지연 | 실패를 포함해 모든 tx가 결과를 받기까지 |
| 실패 종류 | 통보 실패(프로세서 abort), 빠른 실패(피어 무효), 느린 실패(시간 초과) |
| 받은 TPS | 정상 구간에 보낸 tx 수 / 25초 |
| 사용자별 성공, 사용자 간 표준편차 | 사용자마다 성공 처리량 |
| 블록 시각 | 오더러·피어 로그(블록 생성, 원장 쓰기, 피어 커밋), 프로세서 `[Timing]` |

## 8. 추가: 저충돌 구간 (§55)

- **조건:** 계좌 1,000 / 10,000 × s 0, 0.5, 1.0 × 배치 100, 1000. 나머지는 위와 같다.
- **진행:** 3바퀴 72회로 시작했다. 사용자 요청으로 27회에서 멈췄다. 대부분 1회분이다.
- **결과 위치:** `results/cloud/cloud-a<계좌>-s<s>-b<배치>`

## 9. 결과와 그림

- **원자료:** `HLF/fabric-samples/zipfbench/results/cloud/cloud-s<s>-b<B>/{A1,BE}/u0/rep<n>`
- **요약:** `HLF/bench-scripts/cloudsummary.js`가 `cloud-summary.json`을 만든다.
- **그림:** 이 폴더의 그림 A·B, 그림 1~6. 각 그림의 설명은 `README.md`에 있다.

## 10. 밝혀 둘 한계

- **사용자 지연:** 보내기 전 sleep으로 흉내 냈다. 피어 왕복과 돌아오는 길에는 지연이 없다(§61).
- **받은 TPS:** Serializer는 혼잡할 때 1,000 TPS를 다 받지 못한다(867~986). 원인은 아직 나누지 못했다(§59).
- **비교 대상:** 클라우드에서는 같은 소스 Fabric과만 비교했다. Fabric++·HTFabric은 로컬에서만 비교했다.
- **구성:** 오더러 1대, 피어 2대의 단일 리전 구성이다.
