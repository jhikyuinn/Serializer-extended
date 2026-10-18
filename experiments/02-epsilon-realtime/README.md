# 02. ε와 배치 크기에 따른 Serializer의 실시간성

**목적:** 기존 Fabric과 비교하는 실험이 아니다. Serializer 정렬 시스템이 TPS, 배치, 혼잡에 따라 어떻게 동작하는지 보인다. 그리고 ε(충돌 그래프로 정렬하는 tx 비율)가 그 사이에서 이득과 비용을 어떻게 맞바꾸는지 보인다.

## 문서

| 문서 | 내용 |
|---|---|
| [`METRICS.md`](METRICS.md) | **정리본.** 성능 지표 정의, 그림 P1~P5와 읽는 법, 결론 문장 예시, 한계 |
| [`SIM.md`](SIM.md) | 시뮬레이션 방법과 결과 전체(smallbank E1~E3, custom C1) |
| [`PLAN.md`](PLAN.md) | 처음 세운 실험 계획(ε × TPS). 실행 전 초안이다 |

## 방법 요약

1. **로컬 시뮬레이션** (NOTES §73~§75)
   - 실험 부하와 같은 모양의 합성 배치를 실제 정렬 코드(`kafka/processor`의 `scheduleEpsilon`)로 정렬해 시간을 잰다.
   - 그 시간으로 도착 → 배치 → 정렬의 흐름을 계산한다(오더러 lock-step, 경로 비용은 클라우드 실측).
   - 코드: `kafka/processor/eps_cost_test.go`(`TestEpsCost`, `TestEpsSim`)
   - 격자: `kafka/processor/epscost-grid.sh`, `epssim-grid.sh`, `epssim-custom.sh`
2. **클라우드 실제 경로 확인** (§77, §81)
   - custom 부하, 배치 1,000, ε 0 / 0.5 / 1, TPS 1,000~3,000(§81에서 1,500·2,000·2,500 추가, 3회)
   - 배치 10,000 비용 확인
   - 긴급 ε
   - 고부하 반복
3. **고부하 간이 확인** (§69~§71): TPS 2,000~5,000, 배치 100~5,000

## 핵심 결과

- **custom 부하에서 ε는 이득과 비용을 맞바꾼다.**
  - 배치 1,000에서 ε 1은 도착 순서 대비 1.8배를 살린다(44.5% → 79.8%). 정렬은 6 ms다.
  - 배치 10,000에서 ε 1은 정렬이 0.9 s(최대 3.3 s)다. 1만 TPS에서 1 s 마감을 67% 위반한다.
- **클라우드에서 확인한 것**
  - 1,000 TPS에서 ε 1은 ε 0보다 성공이 +51%다.
  - 3,000 TPS에서는 ε 1이 무너진다. 더 많이 살린 tx를 피어가 커밋하지 못하기 때문이다.
  - → **부하가 낮으면 큰 ε, 피어 한계에 가까우면 작은 ε**
- **경계 TPS (§81, 3회):** 1,500 이하는 ε 1, 약 2,000은 ε 0~0.5, 2,500 이상은 ε 0이 가장 많이 살린다(그림 P6).
- **긴급 tx용 ε (§81):** 클라우드에서도 ε_urgent 1이 0.1보다 긴급 tx 성공률이 높다(61.7% 대 47.5%). 비용 차이는 없다.
- **smallbank(계좌 100)에서는 ε를 키워도 이득이 없다**(키 200개). 비용만 커진다.
- **이 하드웨어(피어 2개, 16 vCPU)의 상한은 약 3,000 TPS다.** 정렬 경로는 4,500 TPS까지 병목이 아니었다(05-diagnostics 참고).

## 폴더

- **`figures/`**
  - P1~P6: 정리본 그림(P6 = 경계 TPS)
  - E1~E3: smallbank 시뮬레이션
  - C1: custom 맞교환
- **`data/`**
  - 격자 원자료: `epscost-grid.out`, `epssim-grid.out`, `epssim-custom.out`
  - 그림용 요약: `*.json`
  - §81 요약: `gapfill-summary.md`
- **`scripts/`**: 그림과 요약 스크립트, 클라우드 실행 스크립트의 사본(원본은 [`bench/scripts/`](../../bench/scripts/))
  - `epssim-figs.js`, `epssim-custom-figs.js`, `epssim-paper-figs.js`: 그림
  - `cloud-epscheck.sh`, `epscheck.js`: §77
  - `cloud-gapfill.sh`, `gapfill.js`: §81
  - `cloud-hightps.sh`, `hightps.js`, `cloud-b5000.sh`: §69~§71
- **클라우드 원자료:** `bench/zipfbench/results/`(저장소에 넣지 않음)의 `epsc-*`, `gapA/B/C-*`, `ht30-*`, `b5000-*`
