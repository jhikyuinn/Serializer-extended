package main

import (
	"fmt"
	"math/rand"
	"os"
	"sort"
	"testing"
	"time"
)

// scheduleBatch의 정확성 검사.
// 실행: go test -mod=vendor -v -run "Check|Compare" ./processor/

func quiet(f func()) {
	stdout := os.Stdout
	devnull, _ := os.Open(os.DevNull)
	os.Stdout = devnull
	defer func() { os.Stdout = stdout; devnull.Close() }()
	f()
}

func copyStats(src map[string]*UserStat) map[string]*UserStat {
	dst := make(map[string]*UserStat, len(src))
	for k, v := range src {
		c := *v
		dst[k] = &c
	}
	return dst
}

func run(txs []TxMeta, stats map[string]*UserStat) (order, aborted []int) {
	if stats == nil {
		stats = map[string]*UserStat{}
	}
	quiet(func() { order, aborted = scheduleBatch(txs, stats) })
	return
}

// acyclic reports whether the "reader before writer" constraints among the kept
// transactions can all be satisfied.
func acyclic(txs []TxMeta, keep []bool) bool {
	n := len(txs)
	writes := make([]map[string]bool, n)
	for i, tx := range txs {
		writes[i] = map[string]bool{}
		for _, k := range tx.Writes {
			writes[i][k] = true
		}
	}
	indeg := make([]int, n)
	adj := make([][]int, n)
	for i := 0; i < n; i++ {
		if !keep[i] {
			continue
		}
		for j := 0; j < n; j++ {
			if i == j || !keep[j] {
				continue
			}
			for _, k := range txs[i].Reads {
				if writes[j][k] {
					adj[i] = append(adj[i], j)
					indeg[j]++
					break
				}
			}
		}
	}
	var q []int
	cnt := 0
	for i := 0; i < n; i++ {
		if keep[i] {
			cnt++
			if indeg[i] == 0 {
				q = append(q, i)
			}
		}
	}
	seen := 0
	for len(q) > 0 {
		v := q[0]
		q = q[1:]
		seen++
		for _, w := range adj[v] {
			indeg[w]--
			if indeg[w] == 0 {
				q = append(q, w)
			}
		}
	}
	return seen == cnt
}

// optimalAborts is the minimum number of aborts (exhaustive, small n only).
func optimalAborts(txs []TxMeta) int {
	n := len(txs)
	best := n
	keep := make([]bool, n)
	for mask := 0; mask < 1<<n; mask++ {
		ab := 0
		for i := 0; i < n; i++ {
			keep[i] = mask&(1<<i) == 0
			if !keep[i] {
				ab++
			}
		}
		if ab < best && acyclic(txs, keep) {
			best = ab
		}
	}
	return best
}

// checkBatch verifies the invariants every schedule must satisfy.
func checkBatch(t *testing.T, name string, txs []TxMeta, order, aborted []int) (needless int) {
	t.Helper()
	n := len(txs)
	cnt := make([]int, n)
	for _, i := range order {
		cnt[i]++
	}
	for _, i := range aborted {
		cnt[i]++
	}
	for i, c := range cnt {
		if c != 1 {
			t.Fatalf("%s: tx %d appears %d times in order+aborted", name, i, c)
		}
	}
	ordered := make([]TxMeta, len(order))
	for i, idx := range order {
		ordered[i] = txs[idx]
	}
	if inv := arrivalOrder(ordered); len(inv) != 0 {
		t.Fatalf("%s: %d ordered tx would fail Fabric validation", name, len(inv))
	}
	// 버린 것 중 다시 넣어도 고리가 생기지 않는 것 = 불필요한 abort
	keep := make([]bool, n)
	for _, i := range order {
		keep[i] = true
	}
	for _, v := range aborted {
		keep[v] = true
		if acyclic(txs, keep) {
			needless++
		}
		keep[v] = false
	}
	return needless
}

func tx(i int, user string, urgent bool, reads, writes []string) TxMeta {
	return TxMeta{Index: i, User: user, Urgency: urgent, Reads: reads, Writes: writes}
}

// 논문 Figure 9: T1→T2, T2→T4, T3→T1, T3→T2 (Ti가 쓴 키를 Tj가 읽음). 고리가 없으므로 abort 0.
func TestCheckPaperFig9(t *testing.T) {
	txs := []TxMeta{
		tx(0, "U1", false, []string{"c"}, []string{"a"}),       // T1: T3이 쓴 c를 읽고 a를 씀
		tx(1, "U2", false, []string{"a", "c"}, []string{"b"}), // T2
		tx(2, "U3", false, nil, []string{"c"}),                // T3
		tx(3, "U4", false, []string{"b"}, nil),                // T4
	}
	order, aborted := run(txs, nil)
	checkBatch(t, "fig9", txs, order, aborted)
	if len(aborted) != 0 {
		t.Fatalf("fig9: expected no aborts, got %v", aborted)
	}
	t.Logf("fig9 order %v", order)
}

func TestCheckHandCases(t *testing.T) {
	// 1) 같은 키를 읽고 쓰는 두 tx: 고리 → 하나 abort, 긴급이 아닌 쪽
	txs := []TxMeta{
		tx(0, "A", true, []string{"k"}, []string{"k"}),
		tx(1, "B", false, []string{"k"}, []string{"k"}),
	}
	_, ab := run(txs, nil)
	if len(ab) != 1 || ab[0] != 1 {
		t.Fatalf("rw-rw: want abort [1], got %v", ab)
	}
	// 같은 순서를 바꿔도 긴급은 살아남는다
	txs[0].Urgency, txs[1].Urgency = false, true
	_, ab = run(txs, nil)
	if len(ab) != 1 || ab[0] != 0 {
		t.Fatalf("rw-rw swapped: want abort [0], got %v", ab)
	}

	// 2) 쓰기만 하는 두 tx: 충돌 아님
	txs = []TxMeta{tx(0, "A", false, nil, []string{"k"}), tx(1, "B", false, nil, []string{"k"})}
	_, ab = run(txs, nil)
	if len(ab) != 0 {
		t.Fatalf("ww: want no abort, got %v", ab)
	}

	// 3) 쓰고 → 읽기: 도착 순서면 Fabric은 뒤를 abort하지만 스케줄러는 순서만 바꾼다
	txs = []TxMeta{tx(0, "A", false, nil, []string{"k"}), tx(1, "B", false, []string{"k"}, nil)}
	order, ab := run(txs, nil)
	if len(ab) != 0 || order[0] != 1 {
		t.Fatalf("w-r: want order [1 0] no abort, got %v %v", order, ab)
	}

	// 4) 같은 조건이면 실패율이 낮은 사용자를 버린다
	txs = []TxMeta{
		tx(0, "Poor", false, []string{"k"}, []string{"k"}),
		tx(1, "Lucky", false, []string{"k"}, []string{"k"}),
	}
	stats := map[string]*UserStat{"Poor": {Submit: 10, Abort: 8}, "Lucky": {Submit: 10, Abort: 0}}
	_, ab = run(txs, stats)
	if len(ab) != 1 || txs[ab[0]].User != "Lucky" {
		t.Fatalf("fairness: want Lucky aborted, got %v", ab)
	}

	// 5) 허브: 0이 k1..k3을 읽고 쓰며 1..3과 각각 고리. 0 하나만 버리면 된다.
	txs = []TxMeta{
		tx(0, "H", false, []string{"k1", "k2", "k3"}, []string{"k1", "k2", "k3"}),
		tx(1, "A", false, []string{"k1"}, []string{"k1"}),
		tx(2, "B", false, []string{"k2"}, []string{"k2"}),
		tx(3, "C", false, []string{"k3"}, []string{"k3"}),
	}
	order, ab = run(txs, nil)
	checkBatch(t, "hub", txs, order, ab)
	if len(ab) != 1 || ab[0] != 0 {
		t.Fatalf("hub: want abort [0], got %v", ab)
	}
}

// 무작위 작은 배치: 항상 유효한 순서인지, 불필요한 abort가 있는지, 최적과 얼마나 차이 나는지.
func TestCheckRandomSmall(t *testing.T) {
	type wl struct {
		name string
		gen  func(rng *rand.Rand, n int) []TxMeta
	}
	keys := 6
	k := func(i int) string { return fmt.Sprintf("key_%d", i) }
	workloads := []wl{
		{"mixed(r/w 무작위)", func(rng *rand.Rand, n int) []TxMeta {
			txs := make([]TxMeta, n)
			for i := range txs {
				var r, w []string
				for j := 0; j < 1+rng.Intn(2); j++ {
					r = append(r, k(rng.Intn(keys)))
				}
				for j := 0; j < 1+rng.Intn(2); j++ {
					w = append(w, k(rng.Intn(keys)))
				}
				txs[i] = tx(i, fmt.Sprintf("U%d", rng.Intn(5)), rng.Intn(10) == 0, r, w)
			}
			return txs
		}},
		{"zipf transfer(2키 읽고 2키 씀)", func(rng *rand.Rand, n int) []TxMeta {
			z := rand.NewZipf(rng, 1.2, 1, uint64(keys*3-1))
			txs := make([]TxMeta, n)
			for i := range txs {
				a := int(z.Uint64())
				b := int(z.Uint64())
				for b == a {
					b = int(z.Uint64())
				}
				ks := []string{k(a), k(b)}
				txs[i] = tx(i, k(a), false, ks, ks)
			}
			return txs
		}},
		{"cross(남 읽고 내 것 씀)", func(rng *rand.Rand, n int) []TxMeta {
			txs := make([]TxMeta, n)
			for i := range txs {
				u := rng.Intn(keys)
				txs[i] = tx(i, k(u), false, []string{k(rng.Intn(keys))}, []string{k(u)})
			}
			return txs
		}},
	}
	for _, w := range workloads {
		rng := rand.New(rand.NewSource(7))
		var trials, sched, opt, arrival, needless, worse int
		for trial := 0; trial < 1500; trial++ {
			n := 4 + rng.Intn(9) // 4..12
			txs := w.gen(rng, n)
			order, ab := run(txs, nil)
			needless += checkBatch(t, w.name, txs, order, ab)
			o := optimalAborts(txs)
			if len(ab) < o {
				t.Fatalf("%s: scheduler beat optimum?! %d < %d", w.name, len(ab), o)
			}
			if len(ab) > o {
				worse++
			}
			trials++
			sched += len(ab)
			opt += o
			arrival += len(arrivalOrder(txs))
		}
		t.Logf("%-28s 배치 %d개 | abort 합계: 도착순(Fabric) %d, 스케줄러 %d, 최적 %d | 최적보다 많은 배치 %d (%.1f%%) | 불필요한 abort %d",
			w.name, trials, arrival, sched, opt, worse, 100*float64(worse)/float64(trials), needless)
	}
}

// 큰 배치에서의 시간. Zipf transfer는 핫키에 tx가 몰려 큰 고리 묶음이 생긴다.
func TestCheckLargeBatchTime(t *testing.T) {
	for _, s := range []float64{1.01, 1.2, 2.0} {
		for _, n := range []int{100, 500, 1000, 2000} {
			rng := rand.New(rand.NewSource(1))
			z := rand.NewZipf(rng, s, 1, 99)
			txs := make([]TxMeta, n)
			for i := range txs {
				a := int(z.Uint64())
				b := int(z.Uint64())
				for b == a {
					b = int(z.Uint64())
				}
				ks := []string{fmt.Sprintf("key_%d", a), fmt.Sprintf("key_%d", b)}
				txs[i] = tx(i, ks[0], false, ks, ks)
			}
			start := time.Now()
			order, ab := run(txs, nil)
			el := time.Since(start)
			ordered := make([]TxMeta, len(order))
			for i, idx := range order {
				ordered[i] = txs[idx]
			}
			if len(order)+len(ab) != n || len(arrivalOrder(ordered)) != 0 {
				t.Fatalf("large s=%.2f n=%d: invalid schedule", s, n)
			}
			t.Logf("s=%.2f n=%4d: %8s, abort 스케줄러 %4d / 도착순 %4d", s, n, el.Round(time.Millisecond), len(ab), len(arrivalOrder(txs)))
		}
	}
}

// ---- Fabric++ / HTFabric: 논문의 예가 그대로 나오는지 ----

func keys(prefix string, ids ...int) []string {
	var out []string
	for _, id := range ids {
		out = append(out, fmt.Sprintf("%s%d", prefix, id))
	}
	return out
}

func withVersions(txs []TxMeta) []TxMeta {
	for i := range txs {
		txs[i].ReadVers = make([]Version, len(txs[i].Reads))
	}
	return txs
}

// Fabric++ 논문 Table 3 → Figure 5: T0, T2를 버리고 T5 ⇒ T1 ⇒ T3 ⇒ T4.
func TestCheckFabricPPPaperTable3(t *testing.T) {
	k := func(ids ...int) []string { return keys("K", ids...) }
	txs := withVersions([]TxMeta{
		{Index: 0, Reads: k(0, 1), Writes: k(2)},
		{Index: 1, Reads: k(3, 4, 5), Writes: k(0)},
		{Index: 2, Reads: k(6, 7), Writes: k(3, 9)},
		{Index: 3, Reads: k(2, 8), Writes: k(1, 4)},
		{Index: 4, Reads: k(9), Writes: k(5, 6, 8)},
		{Index: 5, Reads: nil, Writes: k(7)},
	})
	var order, aborted []int
	quiet(func() { order, aborted = scheduleFabricPP(txs, nil) })
	if fmt.Sprint(aborted) != "[0 2]" || fmt.Sprint(order) != "[5 1 3 4]" {
		t.Fatalf("want aborted [0 2], order [5 1 3 4]; got aborted %v, order %v", aborted, order)
	}
}

// Fabric++ 논문 Table 1 → Table 2: 고리가 없으므로 넷 다 살아야 한다.
func TestCheckFabricPPPaperTable1(t *testing.T) {
	k := func(ids ...int) []string { return keys("k", ids...) }
	txs := withVersions([]TxMeta{
		{Index: 0, Writes: k(1)},
		{Index: 1, Reads: k(1, 2), Writes: k(2)},
		{Index: 2, Reads: k(1, 3), Writes: k(3)},
		{Index: 3, Reads: k(1, 3), Writes: k(4)},
	})
	var order, aborted []int
	quiet(func() { order, aborted = scheduleFabricPP(txs, nil) })
	checkBatch(t, "fabricpp-table1", txs, order, aborted)
	if len(aborted) != 0 {
		t.Fatalf("want no abort, got %v (order %v)", aborted, order)
	}
}

// Fabric++ 5.2.2절: 같은 키를 다른 버전으로 읽으면 뒤의 것을 버린다.
func TestCheckFabricPPEarlyAbort(t *testing.T) {
	txs := []TxMeta{
		{Index: 0, Reads: []string{"a"}, ReadVers: []Version{{true, 4, 0}}, Writes: []string{"x"}},
		{Index: 1, Reads: []string{"a"}, ReadVers: []Version{{true, 5, 2}}, Writes: []string{"y"}},
		{Index: 2, Reads: []string{"a"}, ReadVers: []Version{{true, 4, 0}}, Writes: []string{"z"}},
	}
	var aborted []int
	quiet(func() { _, aborted = scheduleFabricPP(txs, nil) })
	if fmt.Sprint(aborted) != "[1]" {
		t.Fatalf("want aborted [1], got %v", aborted)
	}
}

// HTFabric 논문 Figure 2 → Figure 4(c): T6 T4 T5 T1 T3 T2, 무효는 T2 하나.
func TestCheckHTFabricPaperFigure4(t *testing.T) {
	k := func(ids ...int) []string { return keys("K", ids...) }
	txs := []TxMeta{
		{Index: 0, Writes: k(2)},                  // T1
		{Index: 1, Reads: k(1, 5), Writes: k(1, 3)}, // T2
		{Index: 2, Reads: k(1), Writes: k(1)},     // T3
		{Index: 3, Reads: k(2), Writes: k(2, 4)},  // T4
		{Index: 4, Reads: k(3), Writes: k(5)},     // T5
		{Index: 5, Reads: k(1), Writes: k(4)},     // T6
	}
	var order []int
	quiet(func() { order, _ = scheduleHTFabric(txs, nil) })
	if fmt.Sprint(order) != "[5 3 4 0 2 1]" {
		t.Fatalf("want order T6 T4 T5 T1 T3 T2 = [5 3 4 0 2 1], got %v", order)
	}
	ordered := make([]TxMeta, len(order))
	for i, idx := range order {
		ordered[i] = txs[idx]
	}
	if inv := arrivalOrder(ordered); len(inv) != 1 || ordered[inv[0]].Index != 1 {
		t.Fatalf("want only T2 invalid, got positions %v", inv)
	}
}

// Fabric++의 순서도 Serializer처럼 항상 유효해야 한다.
func TestCheckFabricPPRandomValid(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	for trial := 0; trial < 1500; trial++ {
		n := 4 + rng.Intn(9)
		txs := make([]TxMeta, n)
		for i := range txs {
			var r, w []string
			for j := 0; j < 1+rng.Intn(2); j++ {
				r = append(r, fmt.Sprintf("key_%d", rng.Intn(6)))
			}
			for j := 0; j < 1+rng.Intn(2); j++ {
				w = append(w, fmt.Sprintf("key_%d", rng.Intn(6)))
			}
			txs[i] = TxMeta{Index: i, Reads: r, ReadVers: make([]Version, len(r)), Writes: w}
		}
		var order, aborted []int
		quiet(func() { order, aborted = scheduleFabricPP(txs, nil) })
		checkBatch(t, "fabricpp-random", txs, order, aborted)
	}
}

// 같은 부하에서 네 방식의 실패 수와 시간. 실패 = 프로세서가 버린 것 + 그 순서로 피어가 무효 처리할 것.
func TestCompareAlgorithms(t *testing.T) {
	type workload struct {
		name string
		gen  func(rng *rand.Rand) []TxMeta
	}
	zipfTransfer := func(s float64, keyCount, size int) func(rng *rand.Rand) []TxMeta {
		return func(rng *rand.Rand) []TxMeta {
			z := rand.NewZipf(rng, s, 1, uint64(keyCount-1))
			txs := make([]TxMeta, size)
			for i := range txs {
				a, b := int(z.Uint64()), int(z.Uint64())
				for b == a {
					b = int(z.Uint64())
				}
				ks := []string{fmt.Sprintf("key_%d", a), fmt.Sprintf("key_%d", b)}
				txs[i] = TxMeta{Index: i, User: ks[0], Reads: ks, ReadVers: make([]Version, 2), Writes: ks}
			}
			return txs
		}
	}
	smallbank := func(cross, size int) func(rng *rand.Rand) []TxMeta {
		var zipf *rand.Zipf
		var rank []int
		return func(rng *rand.Rand) []TxMeta {
			if zipf == nil {
				zipf = rand.NewZipf(rng, 1.2, 4, simUsers-1)
				rank = rng.Perm(simUsers)
				for i := range rank {
					rank[i]++
				}
			}
			txs := simBatch(rng, zipf, rank, size, cross)
			for i := range txs {
				txs[i].ReadVers = make([]Version, len(txs[i].Reads))
			}
			return txs
		}
	}
	workloads := []workload{
		{"Zipf transfer s=1.01, 키 1000, 배치 100", zipfTransfer(1.01, 1000, 100)},
		{"Zipf transfer s=1.2, 키 1000, 배치 100", zipfTransfer(1.2, 1000, 100)},
		{"Zipf transfer s=1.2, 키 100, 배치 100", zipfTransfer(1.2, 100, 100)},
		{"smallbank 모양, 계좌 간 이동 0%, 배치 100", smallbank(0, 100)},
		{"smallbank 모양, 계좌 간 이동 40%, 배치 100", smallbank(40, 100)},
	}
	algos := []struct {
		name string
		f    func([]TxMeta, map[string]*UserStat) ([]int, []int)
	}{
		{"serializer", scheduleBatch},
		{"fabricpp", scheduleFabricPP},
		{"htfabric", scheduleHTFabric},
		{"eps 1/1", func(txs []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilon(txs, s, 1, 1) }},
		{"eps .1/.75", func(txs []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilon(txs, s, 0.1, 0.75) }},
	}
	const batches = 300
	for _, w := range workloads {
		t.Logf("%s (배치 %d개)", w.name, batches)
		rng := rand.New(rand.NewSource(11))
		all := make([][]TxMeta, batches)
		for b := range all {
			all[b] = w.gen(rng)
		}
		arrival := 0
		for _, txs := range all {
			arrival += len(arrivalOrder(txs))
		}
		t.Logf("  %-11s 실패 %5d (%.1f%%)", "도착순", arrival, pct(arrival, batches*len(all[0])))
		for _, a := range algos {
			stats := map[string]*UserStat{}
			dropped, invalid := 0, 0
			var elapsed, worst time.Duration
			for _, txs := range all {
				var order, aborted []int
				start := time.Now()
				quiet(func() { order, aborted = a.f(txs, stats) })
				d := time.Since(start)
				elapsed += d
				if d > worst {
					worst = d
				}
				ordered := make([]TxMeta, len(order))
				for i, idx := range order {
					ordered[i] = txs[idx]
				}
				dropped += len(aborted)
				invalid += len(arrivalOrder(ordered))
			}
			t.Logf("  %-11s 실패 %5d (%.1f%%) = 프로세서 abort %5d + 피어 무효 %5d | 배치당 평균 %8s, 최대 %8s",
				a.name, dropped+invalid, pct(dropped+invalid, batches*len(all[0])), dropped, invalid,
				(elapsed / batches).Round(time.Microsecond), worst.Round(time.Microsecond))
		}
	}
}

// ---- ε-ordering (Serializer 논문 Algorithm 1~4) ----

func runEpsilon(txs []TxMeta, stats map[string]*UserStat, epsU, epsL float64) (order, aborted []int) {
	oldU, oldL := epsilonUrgent, epsilonLow
	epsilonUrgent, epsilonLow = epsU, epsL
	defer func() { epsilonUrgent, epsilonLow = oldU, oldL }()
	if stats == nil {
		stats = map[string]*UserStat{}
	}
	quiet(func() { order, aborted = scheduleEpsilon(txs, stats) })
	return
}

func TestCheckEpsilonHandCases(t *testing.T) {
	// 논문 Figure 9: 고리가 없으므로 abort 없이 순서만 바뀐다
	fig9 := []TxMeta{
		tx(0, "U1", false, []string{"c"}, []string{"a"}),
		tx(1, "U2", false, []string{"a", "c"}, []string{"b"}),
		tx(2, "U3", false, nil, []string{"c"}),
		tx(3, "U4", false, []string{"b"}, nil),
	}
	order, ab := runEpsilon(fig9, nil, 1, 1)
	checkBatch(t, "eps-fig9", fig9, order, ab)
	if len(ab) != 0 || order[0] != 3 {
		t.Fatalf("fig9: want no abort and read-only T4 first, got order %v aborted %v", order, ab)
	}

	// 긴급과 일반이 같은 키를 읽고 쓰면 긴급이 먼저 놓이고 일반은 상태 S 와 어긋나 버려진다
	txs := []TxMeta{
		tx(0, "A", false, []string{"k"}, []string{"k"}),
		tx(1, "B", true, []string{"k"}, []string{"k"}),
	}
	order, ab = runEpsilon(txs, nil, 1, 1)
	if fmt.Sprint(order) != "[1]" || fmt.Sprint(ab) != "[0]" {
		t.Fatalf("urgent: want order [1] aborted [0], got %v %v", order, ab)
	}

	// 같은 그룹의 고리에서는 지금까지 abort 가 가장 적은 사용자를 버린다
	txs = []TxMeta{
		tx(0, "Poor", false, []string{"k"}, []string{"k"}),
		tx(1, "Lucky", false, []string{"k"}, []string{"k"}),
	}
	stats := map[string]*UserStat{"Poor": {Submit: 10, Abort: 8}, "Lucky": {Submit: 10, Abort: 0}}
	_, ab = runEpsilon(txs, stats, 1, 1)
	if len(ab) != 1 || txs[ab[0]].User != "Lucky" {
		t.Fatalf("score: want Lucky aborted, got %v", ab)
	}
	if stats["Lucky"].Abort != 1 {
		t.Fatalf("score: abort count not updated: %+v", stats["Lucky"])
	}

	// ε 가 작으면 뒤쪽은 그래프 없이 상태 S 만 본다: 쓰고 → 읽기는 순서를 바꾸지 못해 버려진다
	txs = []TxMeta{
		tx(0, "A", false, nil, []string{"k"}),
		tx(1, "B", false, []string{"k"}, []string{"z"}),
	}
	order, ab = runEpsilon(txs, nil, 1, 0.5)
	if fmt.Sprint(order) != "[0]" || fmt.Sprint(ab) != "[1]" {
		t.Fatalf("eps=0.5: want order [0] aborted [1], got %v %v", order, ab)
	}
	order, ab = runEpsilon(txs, nil, 1, 1)
	if fmt.Sprint(order) != "[1 0]" || len(ab) != 0 {
		t.Fatalf("eps=1: want order [1 0] no abort, got %v %v", order, ab)
	}
}

// ε-ordering 의 순서도 항상 유효해야 한다 (ε 값과 무관하게)
func TestCheckEpsilonRandomValid(t *testing.T) {
	rng := rand.New(rand.NewSource(5))
	for _, eps := range [][2]float64{{1, 1}, {0.1, 0.75}, {0.5, 0.25}, {0, 0}} {
		for trial := 0; trial < 1000; trial++ {
			n := 4 + rng.Intn(9)
			txs := make([]TxMeta, n)
			for i := range txs {
				var r, w []string
				for j := 0; j < rng.Intn(3); j++ {
					r = append(r, fmt.Sprintf("key_%d", rng.Intn(6)))
				}
				for j := 0; j < rng.Intn(3); j++ {
					w = append(w, fmt.Sprintf("key_%d", rng.Intn(6)))
				}
				txs[i] = TxMeta{Index: i, User: fmt.Sprintf("U%d", rng.Intn(4)), Urgency: rng.Intn(5) == 0,
					Reads: r, ReadVers: make([]Version, len(r)), Writes: w}
			}
			order, ab := runEpsilon(txs, nil, eps[0], eps[1])
			checkBatch(t, fmt.Sprintf("epsilon %v", eps), txs, order, ab)
		}
	}
}

// smallbank 체인코드(zipfbench chaincode-smallbank)와 같은 모양의 배치. userbench 와 같은 조건.
func smallbankBatch(rng *rand.Rand, z *rand.Zipf, size int, urgentShare float64) []TxMeta {
	acct := func() string { return fmt.Sprint(z.Uint64()) }
	two := func() (string, string) {
		a, b := acct(), acct()
		for b == a {
			b = acct()
		}
		return a, b
	}
	ck := func(a string) string { return "smallbank/checking_" + a }
	sv := func(a string) string { return "smallbank/savings_" + a }
	txs := make([]TxMeta, size)
	for i := range txs {
		user := fmt.Sprintf("User%d", 1+rng.Intn(5))
		var r, w []string
		urgent := false
		if rng.Float64() < 0.5 {
			r = []string{ck(acct())}
			a := acct()
			r = []string{sv(a), ck(a)}
		} else {
			urgent = user == "User3" && rng.Float64() < urgentShare
			switch rng.Intn(5) {
			case 0:
				a := acct()
				r, w = []string{sv(a)}, []string{sv(a)}
			case 1:
				a := acct()
				r, w = []string{ck(a)}, []string{ck(a)}
			case 2:
				a, b := two()
				r, w = []string{ck(a), ck(b)}, []string{ck(a), ck(b)}
			case 3:
				a := acct()
				r, w = []string{sv(a), ck(a)}, []string{ck(a)}
			default:
				a, b := two()
				r, w = []string{sv(a), ck(a), ck(b)}, []string{sv(a), ck(a), ck(b)}
			}
		}
		txs[i] = TxMeta{Index: i, User: user, Urgency: urgent, Reads: r, ReadVers: make([]Version, len(r)), Writes: w}
	}
	return txs
}

// 배치 크기에 따른 정렬 시간 (go test -run BatchSizeTiming -v). 실제 스택에서 배치를 키우기 전에 잰다.
func TestBatchSizeTiming(t *testing.T) {
	if os.Getenv("TIMING") == "" {
		t.Skip("TIMING=1 일 때만 돈다")
	}
	algos := []struct {
		name string
		f    func([]TxMeta, map[string]*UserStat) ([]int, []int)
	}{
		{"serializer", scheduleBatch},
		{"eps 1/1", func(txs []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilon(txs, s, 1, 1) }},
		{"eps .1/.75", func(txs []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilon(txs, s, 0.1, 0.75) }},
		{"eps 0/0", func(txs []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilon(txs, s, 0, 0) }},
		{"fabricpp", scheduleFabricPP},
		{"htfabric", scheduleHTFabric},
	}
	for _, size := range []int{100, 500, 1000} {
		rng := rand.New(rand.NewSource(1))
		z := rand.NewZipf(rng, 1.15, 1, 99)
		batches := make([][]TxMeta, 5)
		for i := range batches {
			batches[i] = smallbankBatch(rng, z, size, 1)
		}
		for _, a := range algos {
			var worst, total time.Duration
			ab := 0
			for _, txs := range batches {
				var aborted []int
				start := time.Now()
				quiet(func() { _, aborted = a.f(txs, map[string]*UserStat{}) })
				d := time.Since(start)
				total += d
				if d > worst {
					worst = d
				}
				ab += len(aborted)
			}
			t.Logf("batch %4d %-11s 평균 %10s 최대 %10s  abort %5.1f%%", size, a.name,
				(total / time.Duration(len(batches))).Round(time.Microsecond), worst.Round(time.Microsecond),
				100*float64(ab)/float64(size*len(batches)))
		}
	}
}

// ε 에 따라 몇 건이 그래프에 들어가고 몇 건이 그래프 없이 붙는지 (TIMING=1 go test -run EpsilonBreakdown -v)
func TestEpsilonBreakdown(t *testing.T) {
	if os.Getenv("TIMING") == "" {
		t.Skip("TIMING=1 일 때만 돈다")
	}
	rng := rand.New(rand.NewSource(1))
	z := rand.NewZipf(rng, 1.15, 1, 99)
	txs := smallbankBatch(rng, z, 1000, 1)
	for _, eps := range [][2]float64{{0, 0}, {0.25, 0.5}, {0.5, 0.5}, {1, 0}, {0, 1}, {1, 1}} {
		oldU, oldL := epsilonUrgent, epsilonLow
		epsilonUrgent, epsilonLow = eps[0], eps[1]
		order, aborted := scheduleEpsilon(txs, map[string]*UserStat{})
		epsilonUrgent, epsilonLow = oldU, oldL
		ordered := make([]TxMeta, len(order))
		for i, idx := range order {
			ordered[i] = txs[idx]
		}
		t.Logf("ε=%v: 순서 %d, abort %d, 그 순서로 피어가 무효 처리할 것 %d", eps, len(order), len(aborted), len(arrivalOrder(ordered)))
	}
}

// Johnson 으로 찾은 고리가 전수 탐색으로 찾은 단순 고리와 정확히 같은지 (작은 무작위 그래프)
func TestCheckFabricPPJohnsonCycles(t *testing.T) {
	rng := rand.New(rand.NewSource(9))
	canon := func(c []int) string { // 가장 작은 노드에서 시작하도록 돌린 표기
		m := 0
		for i := range c {
			if c[i] < c[m] {
				m = i
			}
		}
		return fmt.Sprint(append(append([]int(nil), c[m:]...), c[:m]...))
	}
	for trial := 0; trial < 300; trial++ {
		n := 3 + rng.Intn(6)
		after := make([][]int, n)
		for v := 0; v < n; v++ {
			for w := 0; w < n; w++ {
				if v != w && rng.Intn(3) == 0 {
					after[v] = append(after[v], w)
				}
			}
		}
		alive := make([]bool, n)
		for i := range alive {
			alive[i] = true
		}
		// 기대값: 가장 작은 노드에서 시작하는 모든 단순 고리
		want := map[string]bool{}
		var path []int
		on := make([]bool, n)
		var dfs func(s, v int)
		dfs = func(s, v int) {
			for _, w := range after[v] {
				if w == s {
					want[canon(path)] = true
				} else if w > s && !on[w] {
					on[w] = true
					path = append(path, w)
					dfs(s, w)
					path = path[:len(path)-1]
					on[w] = false
				}
			}
		}
		for s := 0; s < n; s++ {
			on[s] = true
			path = []int{s}
			dfs(s, s)
			on[s] = false
		}
		got := map[string]bool{}
		for _, g := range cyclicGroups(after, alive) {
			cs, cut := simpleCycles(g, after, alive)
			if cut {
				t.Fatalf("trial %d: unexpected truncation", trial)
			}
			for _, c := range cs {
				k := canon(c)
				if got[k] {
					t.Fatalf("trial %d: cycle %s found twice", trial, k)
				}
				got[k] = true
			}
		}
		if len(got) != len(want) {
			t.Fatalf("trial %d (n=%d): Johnson %d cycles, brute force %d", trial, n, len(got), len(want))
		}
		for k := range want {
			if !got[k] {
				t.Fatalf("trial %d: missing cycle %s", trial, k)
			}
		}
	}
}

// 인접 리스트 구현이 예전 행렬 구현(epsilon_ref_test.go)과 결과가 완전히 같은지:
// 순서, abort 목록, 사용자별 abort 수(같은 배치에서 바로 더해진다)까지 비교한다.
func TestCheckEpsilonMatchesMatrix(t *testing.T) {
	rng := rand.New(rand.NewSource(21))
	gens := []struct {
		name string
		gen  func(n int) []TxMeta
	}{
		{"random", func(n int) []TxMeta {
			txs := make([]TxMeta, n)
			for i := range txs {
				var r, w []string
				for j := 0; j < rng.Intn(4); j++ {
					r = append(r, fmt.Sprintf("key_%d", rng.Intn(12)))
				}
				for j := 0; j < rng.Intn(4); j++ {
					w = append(w, fmt.Sprintf("key_%d", rng.Intn(12)))
				}
				txs[i] = TxMeta{Index: i, User: fmt.Sprintf("U%d", rng.Intn(5)), Urgency: rng.Intn(4) == 0,
					Reads: r, ReadVers: make([]Version, len(r)), Writes: w}
			}
			return txs
		}},
		{"smallbank", func(n int) []TxMeta {
			return smallbankBatch(rng, rand.NewZipf(rng, 1.15, 1, 99), n, 0.5)
		}},
		{"custom", func(n int) []TxMeta {
			txs := make([]TxMeta, n)
			item := func(pHot float64) string {
				if rng.Float64() < pHot {
					return fmt.Sprintf("item_%d", rng.Intn(100))
				}
				return fmt.Sprintf("item_%d", 100+rng.Intn(9900))
			}
			for i := range txs {
				var r, w []string
				for j := 0; j < 8; j++ {
					r = append(r, item(0.4))
					w = append(w, item(0.1))
				}
				user := fmt.Sprintf("User%d", 1+rng.Intn(5))
				txs[i] = TxMeta{Index: i, User: user, Urgency: user == "User3", Reads: r, ReadVers: make([]Version, len(r)), Writes: w}
			}
			return txs
		}},
	}
	epss := [][2]float64{{1, 1}, {0.1, 0.75}, {0.5, 0.25}, {0, 0}, {1, 0}, {0, 1}}
	compared := 0
	for _, g := range gens {
		for trial := 0; trial < 60; trial++ {
			n := []int{5, 20, 100, 300}[trial%4]
			txs := g.gen(n)
			base := map[string]*UserStat{}
			for u := 1; u <= 5; u++ {
				base[fmt.Sprintf("User%d", u)] = &UserStat{Submit: 50, Abort: rng.Intn(20)}
				base[fmt.Sprintf("U%d", u-1)] = &UserStat{Submit: 50, Abort: rng.Intn(20)}
			}
			for _, e := range epss {
				s1, s2 := copyStats(base), copyStats(base)
				o1, a1 := runEpsilonWith(scheduleEpsilon, txs, s1, e[0], e[1])
				o2, a2 := runEpsilonWith(scheduleEpsilonMatrixRef, txs, s2, e[0], e[1])
				if fmt.Sprint(o1) != fmt.Sprint(o2) || fmt.Sprint(a1) != fmt.Sprint(a2) {
					t.Fatalf("%s n=%d eps=%v: different result\n list:   order %v aborted %v\n matrix: order %v aborted %v", g.name, n, e, o1, a1, o2, a2)
				}
				for u, s := range s1 {
					if *s != *s2[u] {
						t.Fatalf("%s n=%d eps=%v: user %s stats differ: %+v vs %+v", g.name, n, e, u, *s, *s2[u])
					}
				}
				compared++
			}
		}
	}
	t.Logf("비교한 배치 %d개 (3가지 부하 × 크기 5/20/100/300 × ε 6가지): 모두 같음", compared)
}

func runEpsilonWith(f func([]TxMeta, map[string]*UserStat) ([]int, []int), txs []TxMeta, stats map[string]*UserStat, epsU, epsL float64) (order, aborted []int) {
	oldU, oldL := epsilonUrgent, epsilonLow
	epsilonUrgent, epsilonLow = epsU, epsL
	defer func() { epsilonUrgent, epsilonLow = oldU, oldL }()
	quiet(func() { order, aborted = f(txs, stats) })
	return
}

// 행렬 구현과 인접 리스트 구현의 시간 (TIMING=1)
func TestEpsilonListVsMatrixTiming(t *testing.T) {
	if os.Getenv("TIMING") == "" {
		t.Skip("TIMING=1 일 때만 돈다")
	}
	rng := rand.New(rand.NewSource(1))
	for _, w := range []string{"smallbank", "custom"} {
		for _, n := range []int{100, 500, 1000, 2000} {
			var txs []TxMeta
			if w == "smallbank" {
				txs = smallbankBatch(rng, rand.NewZipf(rng, 1.15, 1, 99), n, 1)
			} else {
				txs = make([]TxMeta, n)
				for i := range txs {
					var r, wr []string
					for j := 0; j < 8; j++ {
						if rng.Float64() < 0.4 {
							r = append(r, fmt.Sprintf("item_%d", rng.Intn(100)))
						} else {
							r = append(r, fmt.Sprintf("item_%d", 100+rng.Intn(9900)))
						}
						if rng.Float64() < 0.1 {
							wr = append(wr, fmt.Sprintf("item_%d", rng.Intn(100)))
						} else {
							wr = append(wr, fmt.Sprintf("item_%d", 100+rng.Intn(9900)))
						}
					}
					txs[i] = TxMeta{Index: i, User: fmt.Sprintf("User%d", 1+rng.Intn(5)), Reads: r, ReadVers: make([]Version, len(r)), Writes: wr}
				}
			}
			times := map[string]time.Duration{}
			for name, f := range map[string]func([]TxMeta, map[string]*UserStat) ([]int, []int){
				"list": scheduleEpsilon, "matrix": scheduleEpsilonMatrixRef,
			} {
				start := time.Now()
				runEpsilonWith(f, txs, map[string]*UserStat{}, 1, 1)
				times[name] = time.Since(start)
			}
			t.Logf("%-9s n=%4d ε 1/1: 행렬 %10s, 인접 리스트 %10s", w, n, times["matrix"].Round(time.Microsecond), times["list"].Round(time.Microsecond))
		}
	}
}

// 네 알고리즘의 배치 크기별 정렬 시간 (TIMING=1 go test -run AllAlgoTiming -v). smallbank·custom 두 부하.
func TestAllAlgoTiming(t *testing.T) {
	if os.Getenv("TIMING") == "" {
		t.Skip("TIMING=1 일 때만 돈다")
	}
	custom := func(rng *rand.Rand, n int) []TxMeta {
		item := func(pHot float64) string {
			if rng.Float64() < pHot {
				return fmt.Sprintf("item_%d", rng.Intn(100))
			}
			return fmt.Sprintf("item_%d", 100+rng.Intn(9900))
		}
		txs := make([]TxMeta, n)
		for i := range txs {
			var r, w []string
			for j := 0; j < 8; j++ {
				r = append(r, item(0.4))
				w = append(w, item(0.1))
			}
			user := fmt.Sprintf("User%d", 1+rng.Intn(5))
			txs[i] = TxMeta{Index: i, User: user, Urgency: user == "User3" && rng.Intn(2) == 0, Reads: r, ReadVers: make([]Version, len(r)), Writes: w}
		}
		return txs
	}
	algos := []struct {
		name string
		f    func([]TxMeta, map[string]*UserStat) ([]int, []int)
	}{
		{"serializer", scheduleBatch},
		{"eps 1/1", func(x []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilonWith(scheduleEpsilon, x, s, 1, 1) }},
		{"eps .1/.75", func(x []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilonWith(scheduleEpsilon, x, s, 0.1, 0.75) }},
		{"fabricpp", scheduleFabricPP},
		{"htfabric", scheduleHTFabric},
	}
	for _, w := range []string{"smallbank", "custom"} {
		for _, n := range []int{100, 500, 1000, 2000} {
			rng := rand.New(rand.NewSource(int64(n)))
			batches := make([][]TxMeta, 3)
			for i := range batches {
				if w == "smallbank" {
					batches[i] = smallbankBatch(rng, rand.NewZipf(rng, 1.15, 1, 99), n, 1)
				} else {
					batches[i] = custom(rng, n)
				}
			}
			line := fmt.Sprintf("%-9s n=%4d", w, n)
			for _, a := range algos {
				var total time.Duration
				ab := 0
				for _, txs := range batches {
					var aborted []int
					start := time.Now()
					quiet(func() { _, aborted = a.f(txs, map[string]*UserStat{}) })
					total += time.Since(start)
					ab += len(aborted)
				}
				line += fmt.Sprintf(" | %s %s (abort %.0f%%)", a.name, (total / 3).Round(10*time.Microsecond), 100*float64(ab)/float64(3*n))
			}
			t.Log(line)
		}
	}
}

// 기존 스케줄러(scheduleBatch)와 ε=1 인 논문 알고리즘(scheduleEpsilon)이 같은 결과를 내는지 센다 (TIMING=1)
func TestSerializerVsEpsilonOne(t *testing.T) {
	if os.Getenv("TIMING") == "" {
		t.Skip("TIMING=1 일 때만 돈다")
	}
	rng := rand.New(rand.NewSource(33))
	for _, w := range []string{"smallbank", "random"} {
		same, sameAbortCount, total := 0, 0, 0
		var abB, abE int
		for trial := 0; trial < 300; trial++ {
			n := []int{10, 50, 100}[trial%3]
			var txs []TxMeta
			if w == "smallbank" {
				txs = smallbankBatch(rng, rand.NewZipf(rng, 1.15, 1, 99), n, 0.5)
			} else {
				txs = make([]TxMeta, n)
				for i := range txs {
					var r, wr []string
					for j := 0; j < 1+rng.Intn(3); j++ {
						r = append(r, fmt.Sprintf("key_%d", rng.Intn(15)))
					}
					for j := 0; j < 1+rng.Intn(3); j++ {
						wr = append(wr, fmt.Sprintf("key_%d", rng.Intn(15)))
					}
					txs[i] = TxMeta{Index: i, User: fmt.Sprintf("U%d", rng.Intn(5)), Urgency: rng.Intn(5) == 0, Reads: r, ReadVers: make([]Version, len(r)), Writes: wr}
				}
			}
			var oB, aB, oE, aE []int
			quiet(func() { oB, aB = scheduleBatch(txs, map[string]*UserStat{}) })
			oE, aE = runEpsilonWith(scheduleEpsilon, txs, map[string]*UserStat{}, 1, 1)
			sa := append([]int(nil), aB...)
			se := append([]int(nil), aE...)
			sort.Ints(sa)
			sort.Ints(se)
			if fmt.Sprint(sa) == fmt.Sprint(se) && fmt.Sprint(oB) == fmt.Sprint(oE) {
				same++
			}
			if len(aB) == len(aE) {
				sameAbortCount++
			}
			abB += len(aB)
			abE += len(aE)
			total++
		}
		t.Logf("%-9s 배치 %d개: 결과(순서·abort) 완전히 같음 %d개, abort 수만 같음 %d개 | abort 합계 기존 %d, ε=1 %d", w, total, same, sameAbortCount, abB, abE)
	}
}

// 아주 큰 배치에서 ε-ordering 과 WARD 의 정렬 시간 (TIMING=1 go test -run LargeBatchEpsWard -v)
func TestLargeBatchEpsWard(t *testing.T) {
	if os.Getenv("TIMING") == "" {
		t.Skip("TIMING=1 일 때만 돈다")
	}
	custom := func(rng *rand.Rand, n int, urgentShare float64) []TxMeta {
		item := func(pHot float64) string {
			if rng.Float64() < pHot {
				return fmt.Sprintf("item_%d", rng.Intn(100))
			}
			return fmt.Sprintf("item_%d", 100+rng.Intn(9900))
		}
		txs := make([]TxMeta, n)
		for i := range txs {
			var r, w []string
			for j := 0; j < 8; j++ {
				r = append(r, item(0.4))
				w = append(w, item(0.1))
			}
			user := fmt.Sprintf("User%d", 1+rng.Intn(5))
			txs[i] = TxMeta{Index: i, User: user, Urgency: user == "User3" && rng.Float64() < urgentShare, Reads: r, ReadVers: make([]Version, len(r)), Writes: w}
		}
		return txs
	}
	type wl struct {
		name string
		gen  func(rng *rand.Rand, n int) []TxMeta
	}
	wls := []wl{
		{"smallbank", func(rng *rand.Rand, n int) []TxMeta { return smallbankBatch(rng, rand.NewZipf(rng, 1.15, 1, 99), n, 1) }},
		{"custom 긴급없음", func(rng *rand.Rand, n int) []TxMeta { return custom(rng, n, 0) }},
		{"custom 긴급있음", func(rng *rand.Rand, n int) []TxMeta { return custom(rng, n, 0.5) }},
	}
	algos := []struct {
		name string
		f    func([]TxMeta, map[string]*UserStat) ([]int, []int)
	}{
		{"ε 1/1", func(x []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilonWith(scheduleEpsilon, x, s, 1, 1) }},
		{"ε .5/.5", func(x []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilonWith(scheduleEpsilon, x, s, 0.5, 0.5) }},
		{"ε .1/.1", func(x []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilonWith(scheduleEpsilon, x, s, 0.1, 0.1) }},
		{"WARD", scheduleHTFabric},
	}
	for _, w := range wls {
		for _, n := range []int{1000, 2000, 5000, 10000} {
			txs := w.gen(rand.New(rand.NewSource(int64(n))), n)
			line := fmt.Sprintf("%-16s n=%5d", w.name, n)
			for _, a := range algos {
				var ab []int
				start := time.Now()
				quiet(func() { _, ab = a.f(txs, map[string]*UserStat{}) })
				line += fmt.Sprintf(" | %s %s (abort %.0f%%)", a.name, time.Since(start).Round(100*time.Microsecond), 100*float64(len(ab))/float64(n))
			}
			t.Log(line)
		}
	}
}

// custom 부하에서 배치 안의 실패만 비교한다 (프로세서가 버린 것 + 그 순서로 피어가 무효 처리할 것).
// 배치 사이의 MVCC 는 넣지 않는다. TIMING=1 go test -run CustomInBatch -v
func TestCustomInBatchFailures(t *testing.T) {
	if os.Getenv("TIMING") == "" {
		t.Skip("TIMING=1 일 때만 돈다")
	}
	gen := func(rng *rand.Rand, n int, urgentShare float64) []TxMeta {
		item := func(pHot float64) string {
			if rng.Float64() < pHot {
				return fmt.Sprintf("item_%d", rng.Intn(100))
			}
			return fmt.Sprintf("item_%d", 100+rng.Intn(9900))
		}
		txs := make([]TxMeta, n)
		for i := range txs {
			var r, w []string
			for j := 0; j < 8; j++ {
				r = append(r, item(0.4))
				w = append(w, item(0.1))
			}
			user := fmt.Sprintf("User%d", 1+rng.Intn(5))
			txs[i] = TxMeta{Index: i, User: user, Urgency: user == "User3" && rng.Float64() < urgentShare, Reads: r, ReadVers: make([]Version, len(r)), Writes: w}
		}
		return txs
	}
	algos := []struct {
		name string
		f    func([]TxMeta, map[string]*UserStat) ([]int, []int)
	}{
		{"도착순(Fabric)", func(x []TxMeta, _ map[string]*UserStat) ([]int, []int) {
			o := make([]int, len(x))
			for i := range o {
				o[i] = i
			}
			return o, nil
		}},
		{"WARD", scheduleHTFabric},
		{"ε 1/1", func(x []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilonWith(scheduleEpsilon, x, s, 1, 1) }},
		{"ε .1/.75", func(x []TxMeta, s map[string]*UserStat) ([]int, []int) { return runEpsilonWith(scheduleEpsilon, x, s, 0.1, 0.75) }},
		{"Fabric++", scheduleFabricPP},
		{"SCC 변형", scheduleBatch},
	}
	for _, urgent := range []float64{0, 1} {
		rng := rand.New(rand.NewSource(5))
		batches := make([][]TxMeta, 200)
		for i := range batches {
			batches[i] = gen(rng, 100, urgent)
		}
		t.Logf("custom, 배치 100건 × 200개, User3 긴급 비율 %.0f", urgent)
		for _, a := range algos {
			dropped, invalid, hotWrites := 0, 0, 0
			stats := map[string]*UserStat{}
			for _, txs := range batches {
				var order, ab []int
				quiet(func() { order, ab = a.f(txs, stats) })
				ordered := make([]TxMeta, len(order))
				for i, idx := range order {
					ordered[i] = txs[idx]
				}
				dropped += len(ab)
				bad := arrivalOrder(ordered)
				invalid += len(bad)
				isBad := map[int]bool{}
				for _, b := range bad {
					isBad[b] = true
				}
				for p, tx := range ordered { // 커밋되는 tx 가 인기 키(item_0..99)에 쓰는 수
					if isBad[p] {
						continue
					}
					for _, k := range tx.Writes {
						var id int
						if _, err := fmt.Sscanf(k, "item_%d", &id); err == nil && id < 100 {
							hotWrites++
						}
					}
				}
			}
			t.Logf("  %-14s 블록 안 성공 %5d / 20000 (%.1f%%) = 프로세서 abort %5d, 피어 무효 %5d | 커밋되는 인기 키 쓰기 %.1f/배치", a.name, 20000-dropped-invalid, 100*float64(20000-dropped-invalid)/20000, dropped, invalid, float64(hotWrites)/200)
		}
	}
}
