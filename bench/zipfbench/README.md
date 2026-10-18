# zipfbench — Zipf 키 편중에서 기본 Fabric vs 재정렬 Fabric

## 비교 대상 (`SYSTEM`)
| 이름 | 오더러 | 피어/도구 | 설명 |
|---|---|---|---|
| B  | serializer/fabric-orderer | serializer/fabric-peer, -tools | 오더러 → Kafka `mychannel-incoming` → 프로세서(의존 그래프 + 위상 정렬, 고리면 희생자 abort) → `mychannel-commit` → 오더러가 블록 생성 |
| FPP | serializer/fabric-orderer | serializer/fabric-peer, -tools | B 와 같은 네트워크, 프로세서만 Fabric++ 재정렬 (`-algo fabricpp`: 버전 불일치 조기 abort + 모든 고리 나열 후 가장 많은 고리의 트랜잭션부터 abort). 고리 나열에 상한이 있다 (논문과 다른 점) |
| HTF | serializer/fabric-orderer | serializer/fabric-peer, -tools | B 와 같은 네트워크, 프로세서만 HTFabric WARD 정렬 (`-algo htfabric`). 버리지 않고 순서만 정한다. TSP·병렬 재실행은 제외 (피어 측 기법, 보증 없는 결과를 커밋) |
| A1 | zipfbench/fabric-orderer-vanilla | serializer/fabric-peer, -tools | 같은 소스에서 오더러 chain.go 의 Kafka 경로만 upstream 으로 되돌린 것 (`images/`) |
| A2 | hyperledger/fabric-orderer:2.5.10 | hyperledger/fabric-peer, -tools:2.5.10 | 공식 이미지 |

공통: 채널 1개, Org1/Org2 피어 1대씩, LevelDB, 오더러 1대(etcdraft), BatchTimeout 2s, MaxMessageCount 100,
보증 정책 `OR('Org1MSP.peer','Org2MSP.peer')` (Caliper 는 Org1 피어에서만 보증받는다), Prometheus(호스트 19090).

## 구성
```
chaincode/          Go 체인코드 init(keyCount, initValue) / transfer(keyA, keyB, amount) / read(key)  → zipfbench/chaincode-zipf
network/            compose.yaml, network.sh(up/deploy/down, SYSTEM 선택), prometheus.yml, configtx, peercfg, scripts
caliper/            networkconfig, connection-org1, caliper.yaml(타임아웃 10s), benchconfig.tmpl.yaml, workload/zipf.js, run.sh
bench.sh            시스템 × s × 반복 실행
aggregate.js        runs.csv, summary.csv, block-delay.svg, committed-tps.svg, overall-tps.svg
images/             A1 오더러 이미지 (vanilla chain.go)
```

## 실행
```bash
# 전체 (B A1 A2 × s 10개 × 3회, 10000 tx @ 250 TPS, 4 workers, N=1000) — 수 시간
RUN_ID=full1 ./bench.sh
node aggregate.js results/full1

# 일부만
RUN_ID=try SYSTEMS="B A2" S_LIST="0 1.2" REPS=1 TX_NUMBER=1000 ./bench.sh
```
- 같은 `RUN_ID` 로 다시 돌리면 `meta.json` 이 있는 실행은 건너뛴다 (중단 후 이어 돌리기).
- 매 실행: 네트워크 down → (B 면 Mongo `User.abortTransaction` 삭제, Kafka `ackGroup` 오프셋을 끝으로) → up → deploy →
  `init(N, 1000000)` → Prometheus 스냅샷 → Caliper transfer 라운드 → 스냅샷 → (B) 프로세서 로그.
- 실행 중 `bz*`, `wnode*`, `serializer-fabric-orderer` 컨테이너를 멈추고 끝나면 다시 켠다.
  serializer-fabric 오더러는 B 오더러와 같은 Kafka consumer group(`ackGroup`)이라 같이 떠 있으면 커밋 배치를 나눠 가져간다.
- 반복 r 의 워커 w 씨앗 = 12345 + 1000·r + w (재현 가능, 반복마다 다른 키 수열).

## 지표 (aggregate.js)
- **roundTime** = (Succ+Fail) / Caliper Throughput. Caliper 0.6 의 Throughput 은 끝난 트랜잭션 전체(성공+실패)를 라운드 시간으로 나눈 값이다.
- **Committed TPS** = Succ / roundTime.
- **충돌 실패** = MVCC_READ_CONFLICT (피어 메트릭 `ledger_transaction_count{validation_code}` 증가분) + B 에서 프로세서가 버린 수(`ABORT tx` 줄).
- **기타 실패** = Fail − 충돌 실패 (타임아웃·보증 실패). Overall TPS 에 넣지 않는다.
- **Overall TPS** = (Succ + 충돌 실패) / roundTime.
- **블록 처리 지연** = 피어 `ledger_block_processing_time` 증가분 합/개수(두 피어 평균) + (B) 배치당 `[Total Ordering Time]` 평균.

## 주의
- transfer 는 두 키를 읽고 쓰므로, 같은 블록에서 키를 공유하는 두 트랜잭션은 서로 읽은 키를 쓰는 관계가 되어 항상 고리가 된다.
  B 의 프로세서는 순서를 바꿔 살릴 수 없고 하나를 버린다(A 에서는 MVCC 로 무효). 블록 사이의 충돌(앞 블록 커밋 전에 보증)은 B 에서도 MVCC 로 나온다.
- B 오더러는 커밋 배치를 `[COMMITDATA]` 로 통째로 출력한다. 로그는 compose 에서 50MB×2 로 묶었다.

## 정렬 알고리즘 비교 (B / FPP / HTF)
- `SYSTEMS="B FPP HTF A2" ./bench.sh`. FPP·HTF 실행 전에 bench.sh 가 `PROCESSOR_ALGO` 를 바꿔 프로세서를 다시 만들고
  (`docker compose ... up -d --force-recreate processor`), 로그의 `Ordering algorithm: <algo>` 로 확인한다. 끝나면 serializer 로 되돌린다.
- 프로세서 위치는 `KAFKA_DIR` (기본 `../../../Serializer/kafka`).
- 프로세서가 버린 수는 알고리즘과 무관한 `[Batch] n= ordered= aborted=` 줄로 센다 (그 줄이 없는 예전 결과는 `ABORT tx` 줄).
- **Caliper 처리량·지연으로 비교하지 않는다.** 프로세서가 버린 트랜잭션은 블록에 들어가지 않아 Caliper 가 타임아웃(10s)까지
  기다린다. HTF 는 버리지 않으므로 이 대기가 없어 Caliper 처리량이 크게 다르게 나온다 (예: s=1.2 에서 B·FPP 71, HTF 237).
  비교에는 원장 기준 지표(committed-tps.svg, overall-tps.svg)를 쓴다.

## 사용자별 실험 (Serializer 논문 Figure 16·Table I)
사용자 5명이 각자 다른 네트워크 지연(4.5 / 50 / 50 / 50 / 100 ms)으로 smallbank 트랜잭션을 보내고, User3(VIP)은 긴급 트랜잭션을 보낸다.
```bash
RUN_ID=users1 ./userbench.sh          # A2 FPP B × 긴급 0/1 × 3회 (30초 라운드)
node aggregate-users.js results/users1  # users-table.md, users-summary.csv, users-runs.csv
```
- 체인코드 `chaincode-smallbank/` (`CC=smallbank network/network.sh deploy`). 모든 호출의 앞 두 인자는 (호출 사용자, 긴급 "1"/"0").
  체인코드는 `info_<사용자>` 를 읽고, 긴급이면 VIP 인지 확인한 뒤 `flag_urgent` 를 읽는다. 두 키는 init 말고는 아무도 쓰지 않아
  충돌을 만들지 않는다. 프로세서는 읽기 집합의 이 두 키로 사용자와 긴급 여부를 안다 (논문 Figure 7 의 방식을 표준 읽기 집합으로 구현).
- Caliper `caliper/run-users.sh` + `workload/users.js`: 워커 하나 = 사용자 하나, 보내기 전에 사용자 지연만큼 기다린다.
  쓰기 비율 PRW(0.5) 로 쓰기 5종 중 하나, 나머지는 Query (Query 도 블록에 들어가도록 제출). 계좌 Zipf(ZIPF_S=1.15), 100개.
- 사용자별 성공·실패를 `user-User*.json` 으로 남긴다. Caliper 에 실패 사유가 없어 걸린 시간으로 나눈다:
  커밋 대기 시간(10 s) 가까이 걸린 실패 = 블록에 들어가지 않음(프로세서가 버림), 더 빨리 끝난 실패 = 피어 무효(MVCC 등).
- 논문은 사용자당 200 TPS(합 1000)지만 이 PC 는 250 TPS 언저리에서 포화되므로 합계 TPS(기본 250)를 다섯 사용자가 나눈다.
