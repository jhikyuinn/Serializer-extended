# 실험 목록

[← README](../README.md)

실험마다 폴더 하나에 결과와 그림(`figures/`), 요약 데이터(`data/`), 실행·집계 스크립트(`scripts/`)가 있습니다. 근거는 [실험 노트](../docs/lab-notebook.md)의 § 번호에 있습니다.

| 폴더 | 날짜 | 질문 | 핵심 결과 | 노트 |
|---|---|---|---|---|
| [01-contention-batch](01-contention-batch/README.md) | 2026-10-17~18 | 혼잡도(Zipf s 0~2)와 배치(100/500/1000)에 따라 Fabric 대비 이득과 지연이 어떻게 바뀌는가 (AWS, 1,000 TPS, 3회) | 모든 조건에서 성공 ×1.13~7.93. s 1.0에서 ×1.31 / ×2.10 / ×2.98. 커밋 지연도 모든 조건에서 더 짧음(−11~−187 ms) | §54~§57, §78 |
| [02-epsilon-realtime](02-epsilon-realtime/README.md) | 2026-10-18 | ε와 배치에 따라 정렬 비용, 실시간성, 이득은 어떻게 바뀌는가 (시뮬레이션 + 클라우드) | 작은 배치·여유 부하에서는 ε 1이 성공 +51%. 배치 10000에서 ε ≤ 0.5는 20k TPS까지 1 s 마감 유지. 피어 한계 근처(3,000 TPS)에서는 작은 ε | §73~§77, §81 |
| [03-snode-mttr](03-snode-mttr/README.md) | 2026-10-17, 10-19 | s-node 장애 후 모든 w-node가 다시 합의하기까지 얼마나 걸리는가 | 중앙값 11.8 s → 5.4 s, 잘못된 전환 0회. 10-19 재측정 4.5~5.8 s. Lease 1 s는 기각 | §48~§49, §87 |
| [04-fairness-algos](04-fairness-algos/README.md) | 2026-10-18 | 사용자 공정성과 Fabric++·HTFabric 대비 성능은 (AWS, 3회) | smallbank 성공 503/s(Fabric +32%, Fabric++ +11%, HTFabric +6%). 공정성은 Fabric++ > Serializer > HTFabric > Fabric. 긴급 tx +10%p. 블록 안 위치 분석 포함 | §79, §83~§85 |
| [05-diagnostics](05-diagnostics/README.md) | 2026-10-18 | Serializer만 1,000 TPS를 다 보내지 못한 이유와 고부하 상한은 | Caliper SDK 리스너 부담을 찾아 고침(Fabric 수치는 그대로). 이 하드웨어의 상한은 피어(약 3,000 TPS) | §59, §67~§71, §80 |
| [06-consensus-sim](06-consensus-sim/README.md) | 2026-10-19 | s-node pod 수와 pod 장애 확률에 따라 합의 성공률은 (MTTR 실측으로 보정한 시뮬레이션) | pod 장애 15%에서 pod 1개 79.5% → 3개 99.1% → 5개 100%. 비잔틴 w-node 3/10이 있으면 약 75%에서 포화 | §87 |
| [07-extra-advantages](07-extra-advantages/README.md) | 2026-10-18~19 | 실패 통보 시간, 성공 tx당 자원, 한 사용자만 인기 계좌에 몰릴 때 | 실패를 알기까지 153 ms(Fabric 226). 성공 tx당 피어 CPU −23%, 원장 −43%. 쏠린 사용자는 어느 시스템에서도 보호되지 않음(α 효과 없음) | §86 |

로컬 단일 PC에서 한 초기 실험(비교 시스템 4종, 커밋 경로 계측, 배치 크기)은 [docs/results.md](../docs/results.md)와 [docs/case-studies.md](../docs/case-studies.md)에 정리했습니다(§37~§40, §50).

## 공통 환경

- **클라우드:** AWS 서울, VM 4대(Fabric / Caliper 클라이언트 / Kafka+프로세서 / s-node·w-node). 배포는 [deploy/cloud](../deploy/cloud/README.md), 세팅 상세는 [01-contention-batch/SETUP.md](01-contention-batch/SETUP.md)에 있습니다.
- **부하:** smallbank(계좌 100, Query 50%)와 custom(Fabric++ 논문의 custom: 키 10,000, 인기 키 1%, 읽기 4·쓰기 4), 사용자 5명. 사용자 지연은 보내기 전에 기다리는 흉내입니다(실제 망 지연 아님).
- **비교 대상:** 같은 소스로 빌드한 Fabric 오더러(A1), 같은 프로세서 자리에 구현한 Fabric++·HTFabric. 설명은 [bench/README.md](../bench/README.md)에 있습니다.
- **원자료:** 실행마다의 로그와 tx 기록은 크기 때문에 저장소에 넣지 않았습니다(`bench/zipfbench/results/`). 각 폴더의 `data/`가 그림에 쓴 요약값입니다.
- **스크립트:** 각 폴더의 `scripts/`는 그 실험에 쓴 사본입니다. 원본은 [bench/scripts](../bench/scripts/)에 있습니다. `cloud-*.sh`는 Fabric VM에서 실행합니다.

## 새 실험을 추가할 때

1. 스크립트·데이터·그림을 `experiments/<번호>-<이름>/`에 두고, 그 폴더의 `README.md`에 조건과 결과를 적습니다.
2. 위 표에 한 줄을 추가합니다.
3. 대표 결과가 바뀔 때만 [README](../README.md)의 "핵심 결과" 표를 고칩니다.
