# 실험 목록

[← README](../README.md)

새 실험은 한 줄씩 위에 추가합니다. 자세한 조건과 그림은 각 실험의 README에, 근거는 [실험 노트](../docs/lab-notebook.md)의 § 번호에 있습니다.

| 날짜 | 실험 | 질문 | 핵심 결과 | 자세히 |
|---|---|---|---|---|
| 계획 | ε × 보내는 TPS | 부하가 커져도 실시간으로 동작하는가, 어디서 포화되는가 | (실행 전) | [eps-tps/PLAN.md](eps-tps/PLAN.md), §65 |
| 2026-10-17~18 | 클라우드 1,000 TPS (AWS VM 4대) | 배치 크기·혼잡도에 따라 이득과 지연 비용이 어떻게 바뀌는가 | s 1.0에서 성공 처리량 ×1.21 / ×1.78 / ×2.54 (배치 100 / 500 / 1000), 최대 ×6.86. 배치 100의 지연 비용 +29 ms | [cloud-figs/README.md](cloud-figs/README.md), §54~§64 |
| 2026-10-17 | 배치 크기 (로컬) | 배치를 키우면 Fabric과 Serializer가 어떻게 달라지는가 | Fabric 성공률 36% → 16%, Serializer 약 50% 유지. 성공 처리량 차이 1.4배 → 3.4배 | [docs/summary.md](../docs/summary.md) §6, §50 |
| 2026-10-17 | 검증 노드 장애 복구(MTTR) | s-node 장애 후 모든 w-node가 다시 합의하기까지 얼마나 걸리는가 | 중앙값 11.8 s → 5.4 s, 잘못된 전환 0회. Lease 1 s는 기각 | [mttr/](mttr/), [docs/results.md](../docs/results.md#검증-노드-장애-복구-mttr), §48~§49 |
| 2026-10-16 | 비교 시스템 4종 (로컬) | 같은 부하에서 Fabric, Fabric++, HTFabric, Serializer를 비교하면 | smallbank 성공 126.0/s로 가장 높음(Fabric 대비 +33%). 공정성은 Fabric++가 가장 좋음 | [docs/results.md](../docs/results.md#비교-시스템-로컬-smallbank), §40 |
| 2026-10-16 | 커밋 경로 계측 | 커밋 지연이 HTFabric보다 40~80 ms 긴 이유는 | 같은 producer 연결의 abort 기록 때문. 분리 후 626 → 546 ms | [docs/case-studies.md](../docs/case-studies.md), §37~§38 |

## 새 실험을 추가할 때

1. 스크립트·데이터·그림을 `experiments/<이름>/`에 두고, 그 폴더의 `README.md`에 조건과 결과를 적습니다.
2. 위 표 맨 위에 한 줄을 추가합니다.
3. 대표 결과가 바뀔 때만 [README](../README.md)의 "핵심 결과" 표를 고칩니다.
