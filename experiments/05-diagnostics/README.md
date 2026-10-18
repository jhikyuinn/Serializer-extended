# 05. 진단: 병목은 어디인가 (NOTES §59, §67~§71, §80)

이 폴더의 실험은 성능을 비교하는 실험이 아니다. "결과가 왜 이렇게 나왔는가"를 확인한 실험이다. 그중 두 가지가 다른 실험의 해석을 바꿨다.

## 1. Serializer가 1,000 TPS를 다 받지 못한 원인 → 측정 도구 (§67~§68)

- **처음 결과:** 클라우드 1,000 TPS에서 Serializer만 받은 TPS가 867~986이었다(01의 v1).
- **오더러 계측** (`orderer/consensus/etcdraft/profile.go`, 이미지 `serializer/fabric-orderer:prof`)
  - 1초마다 `[ORDSTAT]`, 배치마다 `[ORDBATCH]`를 남긴다. 요약은 `scripts/ordstat.js`다.
  - run loop가 1초 중 약 900 ms를 쉬고 있었다. 오더러는 병목이 아니다.
- **원인:** Caliper 워커가 tx를 덜 보내고 있었다.
  - 워커 CPU 프로파일(`CALIPER_CPU_PROF=1`, `scripts/cpuprof-top.js`)을 보면 Fabric SDK(fabric-common 2.2.20)의 `_callTransactionListener` 경로가 문제였다.
  - 이 함수는 블록의 tx마다 등록된 리스너를 전부 훑고, 맞지 않으면 debug 로그 함수를 부른다.
  - abort된 tx는 블록에 나오지 않아 그 리스너가 시간 초과까지 남는다. 워커당 약 2,150개가 쌓였다(Fabric 실행에서는 약 90개).
- **수정:** `zipfbench/caliper/workload/users.js`의 `installFastTxListener`(기본으로 켬)
  - 맞는 리스너만 원래 함수에 넘긴다.
  - SDK가 리스너 유무 표시를 다시 계산하는 버그를 함께 고쳤다.
- **확인** (s 2.0, 배치 100)
  - Serializer: 보낸 TPS 849 → 1,004, 성공 279 → 342/s, 커밋 지연 244 → 175 ms
  - Fabric: 그대로
- 그래서 01을 다시 쟀다(v2).

## 2. 고부하에서의 상한 → 피어 CPU (§69~§71, §80)

- **클라이언트 상한:** 워커 5개는 약 1,220 TPS, 워커 15개(16 vCPU)는 약 2,100~2,250 TPS였다. 32 vCPU에 워커 30개면 약 4,500 TPS까지 보낼 수 있다.
- **정렬 경로:** 오더러·Kafka·프로세서는 4,500 TPS까지 다 받았다(Kafka 왕복 7~17 ms).
- **피어 포화:** 4,000 TPS 진단(`scripts/cloud-diag4k.sh`)에서 Fabric VM(16 vCPU)의 피어 둘이 합계 약 11코어를 썼다(org1 6.4~6.9, org2 4.5).
  - 상태 DB는 이미 LevelDB였다.
  - 그래서 이 하드웨어의 실질 상한은 **약 3,000 TPS**다(배치 1,000 기준).
- **배치 크기:** 3,000 TPS에서 배치 100은 무너졌고 배치 1,000은 정상이었다. 4,000 TPS·배치 5,000에서 Serializer는 성공 643/s, Fabric은 14/s였다(§81에서 반복).

## scripts/

원본은 [`bench/scripts/`](../../bench/scripts/)에 있고, 여기 있는 것은 사본이다.

| 파일 | 하는 일 |
|---|---|
| `cloud-prof.sh`, `ordstat.js` | 오더러 계측 실행과 요약 |
| `cloud-timeoutchk.sh`, `cloud-cpuchk.sh` | 커밋 대기 시간·워커 CPU 비교 |
| `cloud-cpuprof.sh`, `cpuprof-top.js` | 워커 CPU 프로파일과 요약(자기 시간 기준 함수·패키지) |
| `cloud-fasttx.sh` | SDK 우회 효과 확인 |
| `cloud-diag4k.sh` | 4,000 TPS에서 컨테이너별 CPU |

- **블록 주기 분해:** `../01-contention-batch/scripts/cyclesplit.js`(§59)
- **원자료:** `bench/zipfbench/results/`(저장소에 넣지 않음)의 `cloud-prof/`, `cpuprof-*`, `fasttx-*`, `ht-*`, `ht15-*`, `ht30-*`, `b5000-*`, `diag4k/`
