package main

// ε 정렬 비용 사전 측정 (Serializer NOTES §73, §72 의 0단계). 실험 부하(smallbank, 계좌 100, Zipf s, 쓰기 50%,
// 사용자 5명, User3 의 쓰기는 긴급)와 같은 모양의 합성 배치를 만들어 scheduleEpsilon 의 시간과 결과를 잰다.
//
// 한 번에 한 조건만 돈다(ε 1·큰 배치는 오래 걸릴 수 있어 밖에서 timeout 으로 끊는다):
//   EPS_COST=1 COST_S=1.0 COST_BATCH=5000 COST_EPS_U=0.1 COST_EPS_L=0.75 COST_REPS=5 go test -mod=vendor -run TestEpsCost ./processor/
// 결과 한 줄: [EPSCOST] s=.. batch=.. epsU=.. epsL=.. reps=.. ms_med=.. ms_max=.. valid=.. fabric_valid=.. aborted=.. graph=..

import (
	"fmt"
	"math"
	"math/rand"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"
)

func envF(k string, d float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(k), 64); err == nil {
		return v
	}
	return d
}

// zipfPick: 순위 k(1..n)의 확률이 1/k^s 에 비례. s=0 이면 균등. 워크로드(users.js buildCdf)와 같다
type zipfPick struct{ cdf []float64 }

func newZipfPick(n int, s float64) *zipfPick {
	c := make([]float64, n)
	t := 0.0
	for k := 1; k <= n; k++ {
		t += 1 / math.Pow(float64(k), s)
		c[k-1] = t
	}
	for i := range c {
		c[i] /= t
	}
	c[n-1] = 1
	return &zipfPick{c}
}

func (z *zipfPick) pick(r *rand.Rand) int { return sort.SearchFloat64s(z.cdf, r.Float64()) }

// costBatch: users.js nextTx 와 같은 모양. 키는 프로세서가 보는 이름("smallbank/checking_<a>")이고 읽기 집합은 키 순이다.
var costUrgent = os.Getenv("COST_URGENT") != "0"

// COST_MODE=custom: users.js 의 custom 모드와 같은 모양. 키 10000 개 중 앞 1%(100개)가 인기 키다.
// tx 마다 서로 다른 키 4개를 읽고(각각 확률 COST_HR 로 인기 키), 따로 고른 키 4개에 쓴다(확률 COST_HW).
// COST_QS 비율은 읽기만 한다. 혼잡은 s 대신 COST_HR/COST_HW 로 바꾼다(s 는 쓰지 않는다).
var costMode = os.Getenv("COST_MODE")

func customBatch(r *rand.Rand, n int) []TxMeta {
	hr, hw, qs := envF("COST_HR", 0.2), envF("COST_HW", 0.1), envF("COST_QS", 0)
	const items, hot, rw = 10000, 100, 4
	pick := func(p float64) []string {
		set := map[int]bool{}
		for len(set) < rw {
			if r.Float64() < p {
				set[r.Intn(hot)] = true
			} else {
				set[hot+r.Intn(items-hot)] = true
			}
		}
		keys := make([]string, 0, rw)
		for k := range set {
			keys = append(keys, fmt.Sprintf("smallbank/item_%d", k))
		}
		sort.Strings(keys)
		return keys
	}
	txs := make([]TxMeta, n)
	for i := range txs {
		u := r.Intn(5) + 1
		tx := TxMeta{Index: i, User: fmt.Sprintf("User%d", u), Reads: pick(hr)}
		if r.Float64() >= qs {
			tx.Writes = pick(hw)
			tx.Urgency = costUrgent && u == 3
		}
		txs[i] = tx
	}
	return txs
}

func costBatch(r *rand.Rand, z *zipfPick, n int) []TxMeta {
	if costMode == "custom" {
		return customBatch(r, n)
	}
	chk :=func(a int) string { return fmt.Sprintf("smallbank/checking_%d", a) }
	sav := func(a int) string { return fmt.Sprintf("smallbank/savings_%d", a) }
	two := func() (int, int) {
		a, b := z.pick(r), z.pick(r)
		for b == a {
			b = z.pick(r)
		}
		return a, b
	}
	txs := make([]TxMeta, n)
	for i := range txs {
		u := r.Intn(5) + 1
		tx := TxMeta{Index: i, User: fmt.Sprintf("User%d", u)}
		if r.Float64() >= 0.5 { // Query
			a := z.pick(r)
			tx.Reads = []string{chk(a), sav(a)}
		} else {
			switch r.Intn(5) {
			case 0: // TransactSavings
				a := z.pick(r)
				tx.Reads, tx.Writes = []string{sav(a)}, []string{sav(a)}
			case 1: // DepositChecking
				a := z.pick(r)
				tx.Reads, tx.Writes = []string{chk(a)}, []string{chk(a)}
			case 2: // SendPayment
				a, b := two()
				tx.Reads = []string{chk(a), chk(b)}
				tx.Writes = tx.Reads
			case 3: // WriteCheck
				a := z.pick(r)
				tx.Reads, tx.Writes = []string{chk(a), sav(a)}, []string{chk(a)}
			case 4: // Amalgamate
				a, b := two()
				tx.Reads = []string{chk(a), chk(b), sav(a)}
				tx.Writes = tx.Reads
			}
			sort.Strings(tx.Reads)
			tx.Urgency = costUrgent && u == 3 // VIP(User3)의 쓰기는 긴급 (COST_URGENT=0 이면 긴급 없음)
		}
		txs[i] = tx
	}
	return txs
}

func TestEpsCost(t *testing.T) {
	if os.Getenv("EPS_COST") != "1" {
		t.Skip("EPS_COST=1 일 때만 돈다")
	}
	s, n := envF("COST_S", 1.0), int(envF("COST_BATCH", 1000))
	eu, el, reps := envF("COST_EPS_U", 1), envF("COST_EPS_L", 1), int(envF("COST_REPS", 5))
	epsilonUrgent, epsilonLow = eu, el
	r := rand.New(rand.NewSource(12345))
	z := newZipfPick(100, s)
	stats := map[string]*UserStat{}

	// scheduleEpsilon 은 배치마다 [Epsilon] 줄을 찍는다. 잴 때는 버린다
	devnull, _ := os.Open(os.DevNull)
	stdout := os.Stdout
	var ms []float64
	valid, fabValid, aborted := 0, 0, 0
	for i := 0; i < reps; i++ {
		txs := costBatch(r, z, n)
		fabValid += n - len(arrivalOrder(txs))
		os.Stdout = devnull
		t0 := time.Now()
		order, ab := scheduleEpsilon(txs, stats)
		d := time.Since(t0)
		os.Stdout = stdout
		ms = append(ms, float64(d)/1e6)
		valid += len(order)
		aborted += len(ab)
	}
	sort.Float64s(ms)
	fmt.Printf("[EPSCOST] urgent=%v s=%.1f batch=%d epsU=%.2f epsL=%.2f reps=%d ms_med=%.2f ms_max=%.2f valid=%.1f fabric_valid=%.1f aborted=%.1f\n",
		costUrgent, s, n, eu, el, reps, ms[len(ms)/2], ms[len(ms)-1],
		float64(valid)/float64(reps), float64(fabValid)/float64(reps), float64(aborted)/float64(reps))
}

// ---- §74 시뮬레이션: 도착 → 배치 → 정렬 시간 흐름 ----
// 같은 조건의 배치 COST_REPS 개를 실제로 정렬해 배치마다 시간을 잰 뒤, 그 시간으로 TPS 마다 시간 흐름을 계산한다.
//   tx i 는 i/TPS 에 도착한다. 배치 k 는 마지막 tx 가 도착하고 앞 배치 처리가 끝나야 잘린다(오더러 lock-step).
//   처리 끝 = 잘린 시각 + 경로 비용(COST_OVH_FIXED ms + COST_OVH_PERTX ms × 배치) + 실제 정렬 시간.
//   정렬 지연 = 처리 끝 − 배치가 다 찬 시각(대기 + 경로 + 정렬). 배치가 차기를 기다리는 시간은 뺀 것이다.
// 이득(TPS 와 무관): 배치 안에서 살린 비율, 긴급 tx 생존율, 사용자별 쓰기 성공률의 Jain 지수.
//   EPS_SIM=1 COST_URGENT=0 COST_S=2.0 COST_BATCH=10000 COST_EPS_U=1 COST_EPS_L=1 COST_REPS=15 go test -run TestEpsSim
func TestEpsSim(t *testing.T) {
	if os.Getenv("EPS_SIM") != "1" {
		t.Skip("EPS_SIM=1 일 때만 돈다")
	}
	s, n := envF("COST_S", 1.0), int(envF("COST_BATCH", 5000))
	eu, el, reps := envF("COST_EPS_U", 1), envF("COST_EPS_L", 1), int(envF("COST_REPS", 20))
	ovhFixed, ovhPerTx := envF("COST_OVH_FIXED", 10), envF("COST_OVH_PERTX", 0.02)
	deadline := envF("COST_DEADLINE_MS", 1000)
	epsilonUrgent, epsilonLow = eu, el
	r := rand.New(rand.NewSource(12345))
	z := newZipfPick(100, s)
	stats := map[string]*UserStat{}
	devnull, _ := os.Open(os.DevNull)
	stdout := os.Stdout

	sortMs := make([]float64, reps)
	valid, fabValid, urgTot, urgOK := 0, 0, 0, 0
	userW, userOK := map[string]int{}, map[string]int{}
	for k := 0; k < reps; k++ {
		txs := costBatch(r, z, n)
		fabValid += n - len(arrivalOrder(txs))
		os.Stdout = devnull
		t0 := time.Now()
		order, _ := scheduleEpsilon(txs, stats)
		d := time.Since(t0)
		os.Stdout = stdout
		sortMs[k] = float64(d) / 1e6
		valid += len(order)
		placed := make([]bool, n)
		for _, i := range order {
			placed[i] = true
		}
		for i, tx := range txs {
			if len(tx.Writes) == 0 {
				continue
			}
			userW[tx.User]++
			if placed[i] {
				userOK[tx.User]++
			}
			if tx.Urgency {
				urgTot++
				if placed[i] {
					urgOK++
				}
			}
		}
	}
	// Jain 지수: (Σx)² / (m·Σx²), x = 사용자별 쓰기 성공률. 1 이면 고르다
	sx, sxx, m := 0.0, 0.0, 0.0
	for u, w := range userW {
		x := float64(userOK[u]) / float64(w)
		sx, sxx, m = sx+x, sxx+x*x, m+1
	}
	jain := sx * sx / (m * sxx)
	sorted := append([]float64(nil), sortMs...)
	sort.Float64s(sorted)
	q := func(a []float64, p float64) float64 { return a[int(math.Min(float64(len(a)-1), math.Floor(p*float64(len(a)))))] }
	mean := 0.0
	for _, v := range sortMs {
		mean += v
	}
	mean /= float64(reps)
	urg := math.NaN()
	if urgTot > 0 {
		urg = float64(urgOK) / float64(urgTot)
	}
	cfg := fmt.Sprintf("urgent=%v s=%.1f batch=%d epsU=%.2f epsL=%.2f", costUrgent, s, n, eu, el)
	if costMode == "custom" {
		cfg = fmt.Sprintf("mode=custom urgent=%v hr=%.2f hw=%.2f qs=%.2f batch=%d epsU=%.2f epsL=%.2f", costUrgent, envF("COST_HR", 0.2), envF("COST_HW", 0.1), envF("COST_QS", 0), n, eu, el)
	}
	ovh := ovhFixed + ovhPerTx*float64(n)
	// 따라갈 수 있는 최대 TPS: 배치 하나를 처리하는 동안 다음 배치가 차야 한다 → 배치 / (경로 비용 + 정렬)
	capMean := float64(n) * 1000 / (ovh + mean)
	capWorst := float64(n) * 1000 / (ovh + sorted[len(sorted)-1])
	fmt.Printf("[EPSSIM-BATCH] %s reps=%d sort_mean=%.2f sort_p90=%.2f sort_max=%.2f cap_mean=%.0f cap_worst=%.0f valid=%.4f fabric_valid=%.4f urgent_ok=%.4f jain=%.4f\n",
		cfg, reps, mean, q(sorted, 0.9), sorted[len(sorted)-1], capMean, capWorst, float64(valid)/float64(reps*n), float64(fabValid)/float64(reps*n), urg, jain)
	for _, tps := range []float64{1000, 2000, 5000, 10000, 20000} {
		done := 0.0 // ms
		var ordDelay, total []float64
		miss := 0
		for k := 0; k < reps; k++ {
			full := float64((k+1)*n-1) / tps * 1000 // 배치의 마지막 tx 도착
			cut := math.Max(full, done)
			done = cut + ovh + sortMs[k]
			od := done - full
			ordDelay = append(ordDelay, od)
			if od > deadline {
				miss++
			}
			// 배치 안 tx 들의 전체 지연(도착 → 처리 끝): 균등 도착이므로 평균은 od + 채우는 시간/2
			total = append(total, od+float64(n-1)/tps*1000/2)
		}
		sustained := math.Min(tps, capMean)
		os := append([]float64(nil), ordDelay...)
		sort.Float64s(os)
		tm := 0.0
		for _, v := range total {
			tm += v
		}
		fmt.Printf("[EPSSIM-TPS] %s tps=%.0f sustained=%.0f ord_mean=%.1f ord_max=%.1f ord_last=%.1f miss=%.3f total_mean=%.1f\n",
			cfg, tps, sustained, meanOf(ordDelay), os[len(os)-1], ordDelay[len(ordDelay)-1], float64(miss)/float64(reps), tm/float64(reps))
	}
}

func meanOf(a []float64) float64 {
	s := 0.0
	for _, v := range a {
		s += v
	}
	return s / float64(len(a))
}
