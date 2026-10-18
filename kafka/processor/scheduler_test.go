package main

import (
	"fmt"
	"math"
	"math/rand"
	"os"
	"testing"
	"time"
)

// 같은 배치를 두 방식으로 처리해 비교한다.
//   - 기존 Fabric: 도착한 순서 그대로 블록에 넣는다. 앞선 유효 트랜잭션이 쓴 키를 읽은 것은 무효다.
//   - 스케줄러:    scheduleBatch가 순서를 정하고 버릴 것을 고른다.
//
// 실행: go test -mod=vendor -v ./processor/

const (
	simUsers  = 100
	simUrgent = 10 // User1~User10이 긴급(VIP)
)

func simKey(user int) string { return fmt.Sprintf("basic/User%d", user) }

// simBatch makes one batch. 사용자마다 제출 빈도가 다르고(Zipf), 트랜잭션은 체인코드의
// 네 가지 모양을 흉내 낸다(cross는 계좌 간 이동의 비율, %). 긴급 판정은 프로세서와 같다: 쓰는 계좌 중 VIP가 있으면 긴급.
func simBatch(rng *rand.Rand, zipf *rand.Zipf, rank []int, size, cross int) []TxMeta {
	txs := make([]TxMeta, size)
	for i := range txs {
		u := rank[zipf.Uint64()]
		tx := TxMeta{Index: i, User: fmt.Sprintf("User%d", u), Urgency: u <= simUrgent}
		switch r := rng.Intn(10); {
		case rng.Intn(100) < cross: // 다른 계좌를 읽어 자기 계좌에 쓴다 (Amalgamate)
			v := rng.Intn(simUsers) + 1
			tx.Reads = []string{simKey(v)}
			tx.Writes = []string{simKey(u)}
		case r < 5: // 자기 계좌를 읽고 쓴다 (WriteCheck)
			tx.Reads = []string{simKey(u)}
			tx.Writes = []string{simKey(u)}
		case r < 8: // 송금: 자기 계좌를 읽고, 자기와 상대 계좌를 쓴다 (SendPayment)
			v := rng.Intn(simUsers) + 1
			tx.Reads = []string{simKey(u)}
			tx.Writes = []string{simKey(u), simKey(v)}
			tx.Urgency = tx.Urgency || v <= simUrgent
		default: // 읽지 않고 쓰기만 한다 (DepositChecking)
			tx.Writes = []string{simKey(u)}
		}
		txs[i] = tx
	}
	return txs
}

// arrivalOrder is what vanilla Fabric does: keep the arrival order and let validation
// invalidate every transaction that read a key an earlier valid one wrote.
func arrivalOrder(txs []TxMeta) (aborted []int) {
	written := make(map[string]bool)
	for i, tx := range txs {
		stale := false
		for _, key := range tx.Reads {
			if written[key] {
				stale = true
				break
			}
		}
		if stale {
			aborted = append(aborted, i)
			continue
		}
		for _, key := range tx.Writes {
			written[key] = true
		}
	}
	return aborted
}

type simResult struct {
	urgent, urgentAborted int
	normal, normalAborted int
	users                 map[string]*UserStat
}

func (r *simResult) record(txs []TxMeta, aborted []int) {
	isAborted := make(map[int]bool, len(aborted))
	for _, i := range aborted {
		isAborted[i] = true
	}
	for i, tx := range txs {
		s, ok := r.users[tx.User]
		if !ok {
			s = &UserStat{}
			r.users[tx.User] = s
		}
		s.Submit++
		if tx.Urgency {
			r.urgent++
		} else {
			r.normal++
		}
		if !isAborted[i] {
			continue
		}
		s.Abort++
		if tx.Urgency {
			r.urgentAborted++
		} else {
			r.normalAborted++
		}
	}
}

// spread returns the highest per-user failure rate and the standard deviation,
// over users who submitted enough for the rate to mean something.
func (r *simResult) spread() (max, stddev float64) {
	var rates []float64
	var sum float64
	for _, s := range r.users {
		if s.Submit < 30 {
			continue
		}
		rate := float64(s.Abort) / float64(s.Submit)
		rates = append(rates, rate)
		sum += rate
		if rate > max {
			max = rate
		}
	}
	mean := sum / float64(len(rates))
	for _, rate := range rates {
		stddev += (rate - mean) * (rate - mean)
	}
	return max, math.Sqrt(stddev / float64(len(rates)))
}

func pct(a, b int) float64 { return 100 * float64(a) / float64(b) }

func TestSchedulerVsArrivalOrder(t *testing.T) {
	// 스케줄러가 배치마다 찍는 로그는 버린다
	stdout := os.Stdout
	devnull, _ := os.Open(os.DevNull)
	defer func() { os.Stdout = stdout }()

	const batches = 2000
	for _, cross := range []int{0, 40} {
		for _, size := range []int{10, 30, 100} {
			rng := rand.New(rand.NewSource(1))
			zipf := rand.NewZipf(rng, 1.2, 4, simUsers-1)
			rank := rng.Perm(simUsers)
			for i := range rank {
				rank[i]++
			}

			fabric := &simResult{users: make(map[string]*UserStat)}
			ours := &simResult{users: make(map[string]*UserStat)}
			stats := make(map[string]*UserStat) // 프로세서의 MongoDB 누적을 대신한다
			var elapsed time.Duration

			for b := 0; b < batches; b++ {
				txs := simBatch(rng, zipf, rank, size, cross)
				fabric.record(txs, arrivalOrder(txs))

				for _, tx := range txs {
					if _, ok := stats[tx.User]; !ok {
						stats[tx.User] = &UserStat{}
					}
					stats[tx.User].Submit++
				}
				os.Stdout = devnull
				start := time.Now()
				order, aborted := scheduleBatch(txs, stats)
				elapsed += time.Since(start)
				os.Stdout = stdout
				ours.record(txs, aborted)

				// 스케줄러가 낸 순서는 Fabric 검증을 전부 통과해야 한다
				if len(order)+len(aborted) != len(txs) {
					t.Fatalf("batch %d: %d ordered + %d aborted != %d", b, len(order), len(aborted), len(txs))
				}
				ordered := make([]TxMeta, len(order))
				for i, idx := range order {
					ordered[i] = txs[idx]
				}
				if invalid := arrivalOrder(ordered); len(invalid) != 0 {
					t.Fatalf("batch %d: %d ordered transaction(s) would fail validation", b, len(invalid))
				}
			}

			fMax, fDev := fabric.spread()
			oMax, oDev := ours.spread()
			t.Logf("계좌 간 이동 %d%%, 배치 크기 %d (배치 %d개, 긴급 트랜잭션 비율 %.0f%%)", cross, size, batches, pct(fabric.urgent, fabric.urgent+fabric.normal))
			t.Logf("                          기존 Fabric   스케줄러")
			t.Logf("  전체 실패율             %9.2f%%  %9.2f%%", pct(fabric.urgentAborted+fabric.normalAborted, batches*size), pct(ours.urgentAborted+ours.normalAborted, batches*size))
			t.Logf("  긴급 실패율             %9.2f%%  %9.2f%%", pct(fabric.urgentAborted, fabric.urgent), pct(ours.urgentAborted, ours.urgent))
			t.Logf("  일반 실패율             %9.2f%%  %9.2f%%", pct(fabric.normalAborted, fabric.normal), pct(ours.normalAborted, ours.normal))
			t.Logf("  사용자별 실패율 최댓값  %9.2f%%  %9.2f%%", 100*fMax, 100*oMax)
			t.Logf("  사용자별 실패율 표준편차 %8.2f%%p %8.2f%%p", 100*fDev, 100*oDev)
			t.Logf("  스케줄링 시간(배치당)           -   %9s", (elapsed / batches).Round(time.Microsecond))
		}
	}
}
