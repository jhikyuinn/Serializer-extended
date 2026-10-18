package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"weave-kafka/contribution"
	weavehttp "weave-kafka/http"

	types "github.com/Watchdog-Network/types"
	"github.com/hyperledger/fabric-protos-go/common"
	"github.com/hyperledger/fabric/core/ledger/kvledger/txmgmt/rwsetutil"
	"github.com/hyperledger/fabric/protoutil"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"github.com/golang/protobuf/proto"

	"github.com/lovoo/goka"
	"github.com/lovoo/goka/codec"
)

const (
	TopicAbort  goka.Stream = "mychannel-abort"
	TopicCommit goka.Stream = "mychannel-commit"
	Group       goka.Group  = "mychannel-group"
)

var (
	re = regexp.MustCompile(`User(\d+)`)
	tmc *goka.TopicManagerConfig

	brokers1 string
	brokers2 []string
)

type Blocks struct {
	List             []Block
	PeerContribution contribution.FabricChannel
}

type Block struct {
	ChannelID        string
	OutputStream     goka.Stream
	Peers            []PeerInfo
	PeerContribution contribution.FabricChannel
}

type PeerInfo struct {
	ID   string
	Sent int
}

func init() {
	// goka 기본값은 보낼 메시지를 64KB가 차거나 100ms가 될 때까지 모은다. 작은 commit 메시지(abort가
	// 많이 빠진 배치, 몇 건짜리 배치)가 그만큼 늦게 나가므로 바로 보내게 한다. acks 설정은 그대로다.
	cfg := goka.DefaultConfig()
	cfg.Producer.Flush.Frequency = time.Millisecond
	// 배치가 크면(예: 1000건) commit·abort 메시지가 수 MB 가 된다. sarama 기본 상한은 1 MB 라서
	// 넘으면 프로세서가 멈춘다. 브로커의 message.max.bytes(docker-compose.yml, 100 MB)에 맞춘다.
	cfg.Producer.MaxMessageBytes = 100 * 1024 * 1024
	goka.ReplaceGlobalConfig(cfg)

	tmc = goka.NewTopicManagerConfig()
	tmc.Table.Replication = 3
	tmc.Stream.Replication = 3
}

type blockCodec struct{}

func newBlockCodec() *blockCodec {
	return &blockCodec{}
}

// Encode encodes *types.StateData into []byte
func (bc *blockCodec) Encode(value interface{}) ([]byte, error) {
	state, ok := value.(*types.StateData)
	if !ok {
		return nil, fmt.Errorf("blockCodec: expected *types.StateData, got %T", value)
	}
	return json.Marshal(state)
}

// Decode decodes []byte into *types.StateData
func (bc *blockCodec) Decode(data []byte) (interface{}, error) {
	var c types.StateData
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("blockCodec: unmarshal error: %w", err)
	}
	return &c, nil
}

// TxMeta 는 정렬에 쓰는 tx 정보다. 새 오더러는 envelope 대신 이것을 JSON 으로 보낸다(NOTES §46).
// JSON 이름은 오더러의 weaveutils/txmeta.TxMeta 와 같아야 한다.
type TxMeta struct {
	Index    int       `json:"i"`
	User     string    `json:"u,omitempty"`
	Reads    []string  `json:"r,omitempty"`
	ReadVers []Version `json:"rv,omitempty"` // Reads[i]를 읽었을 때의 버전 (Fabric++의 조기 abort가 쓴다)
	Writes   []string  `json:"w,omitempty"`
	Urgency  bool      `json:"g,omitempty"`
	TxID     string    `json:"id,omitempty"` // 채널 헤더의 트랜잭션 ID
	Args     []string  `json:"a,omitempty"`  // 체인코드 호출 인자 (함수 이름 포함). 클라이언트가 abort 통보에서 자기 요청을 찾는 데 쓴다
}

// Version은 트랜잭션이 읽은 키의 버전이다. Exists가 false면 그 키가 아직 없었다.
type Version struct {
	Exists bool   `json:"e,omitempty"`
	Block  uint64 `json:"b,omitempty"`
	Tx     uint64 `json:"t,omitempty"`
}

func (v Version) less(o Version) bool {
	if v.Exists != o.Exists {
		return !v.Exists
	}
	if v.Block != o.Block {
		return v.Block < o.Block
	}
	return v.Tx < o.Tx
}

// 정렬 알고리즘. -algo 플래그로 고른다. 비교 실험에서 Kafka 경로와 사용자 통계 기록은 같게 두고
// 순서를 정하는 부분만 바꾼다.
var schedulers = map[string]func([]TxMeta, map[string]*UserStat) ([]int, []int){
	"serializer": scheduleBatch,
	"fabricpp":   scheduleFabricPP,
	"htfabric":   scheduleHTFabric,
	"epsilon":    scheduleEpsilon,
}

var schedule = scheduleBatch

// verbose 면 배치마다 순서·abort 목록과 희생자마다 한 줄씩 찍는다(-verbose). 출력이 정렬 시간보다 오래 걸려 기본은 끈다.
var verbose = false

type TxData struct {
	ID        string   `json:"id"` // 오더러가 붙인 배치 ID (예전 오더러는 없음)
	Timestamp int64    `json:"timestamp"`
	Batch     [][]byte `json:"batch,omitempty"` // envelope 전체 (예전 형식)
	Txs       []TxMeta `json:"txs,omitempty"`   // tx 별 메타데이터 (새 형식, 오더러가 envelope 대신 보낸다)
}

type AbortPayload struct {
	Timestamp int64                `json:"timestamp"`
	// abort된 트랜잭션의 envelope. 예전 형식(envelope 를 받은 배치)에서만 채운다. 새 형식에서는 프로세서가
	// envelope 을 받지 않으므로 비어 있다(NOTES §46). QUIC w-node 는 users 만, 클라이언트는 aborted 만 쓴다.
	Data      []*common.Envelope `json:"data,omitempty"`
	// abort된 트랜잭션의 사용자별 건수. w-node는 Envelope을 풀지 않고 이 값을 원장에 적는다.
	Users     map[string]int     `json:"users"`
	// abort된 트랜잭션마다 ID와 호출 인자. 클라이언트가 이 토픽을 읽어 자기 트랜잭션이 버려진 것을
	// 커밋 이벤트를 기다리지 않고 바로 안다 (논문 II.A절: "The Fabric client reads and abort them quickly").
	Aborted   []AbortedTx        `json:"aborted"`
}

type AbortedTx struct {
	TxID string   `json:"txId"`
	Args []string `json:"args"`
}

// UserStat은 한 사용자가 지금까지 제출한 쓰기 트랜잭션 수와 그중 abort된 수다.
type UserStat struct {
	Submit int
	Abort  int
}

// failRatio는 사용자의 실패율이다. 제출이 적을 때 한두 건으로 크게 흔들리지 않도록
// (실패+1)/(제출+2)로 보정한다.
func (s *UserStat) failRatio() float64 {
	return float64(s.Abort+1) / float64(s.Submit+2)
}

// process orders one batch from the incoming topic.
// 예전에는 받은 배치를 Loopback으로 loop 토픽에 다시 써서 처리했다. 그룹 테이블을 쓰지 않으므로
// Kafka를 한 번 더 거치는 것 말고는 하는 일이 없어 바로 처리한다.
func (bs *Blocks) process(ctx goka.Context, msg interface{}) {
	startelsaped:=time.Now().UnixMilli()

	// 단계별 시간(ms). recv는 받은 시각, create는 오더러가 Produce를 부른 시각(Kafka 레코드 시각)이다.
	phase := time.Now()
	lap := func() float64 {
		now := time.Now()
		d := float64(now.Sub(phase).Microseconds()) / 1000
		phase = now
		return d
	}
	recvAt := phase.UnixMilli()
	msgBytes := len(msg.([]byte))

	var transactionlist TxData
	err := json.Unmarshal(msg.([]byte), &transactionlist)
	if err != nil {
		log.Fatalf("Failed to unmarshal JSON: %v", err)
	}

	var kafkadata []*common.Envelope
	for _, serializedEnv := range transactionlist.Batch {
		env := &common.Envelope{}
		err := proto.Unmarshal(serializedEnv, env)
		if err != nil {
			log.Fatalf("Failed to unmarshal envelope: %v", err)
		}
		kafkadata = append(kafkadata, env)
	}

	// 새 오더러는 envelope 대신 tx 별 메타데이터(txs)를 보낸다. 그러면 envelope 을 풀 필요가 없다.
	var txMetaList []TxMeta
	if len(transactionlist.Txs) > 0 {
		txMetaList = transactionlist.Txs
		for i := range txMetaList {
			txMetaList[i].Index = i // 정렬 함수들은 Index == i 를 가정한다
		}
	}
	n := len(kafkadata) + len(txMetaList)

	fmt.Println("[The length of Kafka incoming data]", n, transactionlist.Timestamp)
	tDecode := lap()

	if txMetaList == nil {
		txMetaList = make([]TxMeta, len(kafkadata))
		for i, env := range kafkadata {
			txMetaList[i] = readTxMeta(i, env)
		}
	}
	// 읽기만 하는 트랜잭션은 abort될 일이 없으므로 사용자 통계에 넣지 않는다
	submitted := make(map[string]int)
	for i := range txMetaList {
		if len(txMetaList[i].Writes) > 0 && txMetaList[i].User != "" {
			submitted[txMetaList[i].User]++
		}
	}

	tMeta := lap()
	stats := loadUserStats(submitted)
	tLoad := lap()
	order, aborted := schedule(txMetaList, stats)
	tSched := lap()

	// 정렬된 envelope 는 예전 오더러(배치 ID 없음)에게만 필요하다
	var OrderedData []*common.Envelope
	if transactionlist.ID == "" {
		for _, i := range order {
			OrderedData = append(OrderedData, kafkadata[i])
		}
	}

	AbortData := make([]*common.Envelope, 0, len(aborted))
	abortUsers := make(map[string]int)
	abortedTxs := make([]AbortedTx, 0, len(aborted))
	for _, i := range aborted {
		if len(kafkadata) > 0 {
			AbortData = append(AbortData, kafkadata[i])
		}
		abortedTxs = append(abortedTxs, AbortedTx{TxID: txMetaList[i].TxID, Args: txMetaList[i].Args})
		if txMetaList[i].User != "" {
			abortUsers[txMetaList[i].User]++
		}
	}
	saveUserStats(submitted, abortUsers)
	tSave := lap()

	// 정렬 결과. 오더러가 배치 ID 를 보냈으면(새 오더러) 배치 안 인덱스만 보낸다. 오더러는 그 배치를
	// 갖고 있으므로 Envelope 를 다시 보낼 필요가 없다(배치 100건에 약 450 KB → 수백 바이트).
	// ID 가 없으면(예전 오더러) 예전처럼 정렬된 Envelope 를 보낸다.
	var marshalledOrdereddata []byte
	if transactionlist.ID != "" {
		marshalledOrdereddata, _ = json.Marshal(struct {
			ID    string `json:"id"`
			Order []int  `json:"order"`
		}{transactionlist.ID, order})
	} else {
		marshalledOrdereddata, _ = json.Marshal(OrderedData)
	}
	// 오더러가 기다리는 것은 commit 이므로 abort 기록보다 먼저 보낸다
	ctx.Emit(TopicCommit, strconv.Itoa(int(ctx.Offset())), marshalledOrdereddata)

	// 한 건짜리 배치는 순서를 정할 것이 없어 abort 기록을 남기지 않는다
	if n > 1 {
		abortPayload := &AbortPayload{
			Timestamp: time.Now().UnixMilli(),
			Data:      AbortData,
			Users:     abortUsers,
			Aborted:   abortedTxs,
		}
		marshalledAbortdata, err := json.Marshal(abortPayload)
		if err != nil {
			fmt.Printf("Failed to marshal abortPayload: %v\n", err)
		}
		emitAbort(ctx, strconv.Itoa(int(ctx.Offset())), marshalledAbortdata)
	}
	tEncode := lap()
	// 알고리즘과 무관하게 같은 형식으로 남긴다. 벤치마크 집계(zipfbench aggregate.js)가 이 줄로
	// 프로세서가 버린 트랜잭션 수를 센다.
	fmt.Printf("[Batch] n=%d ordered=%d aborted=%d\n", n, len(order), len(aborted))
	fmt.Printf("[Timing] n=%d bytes=%d out=%d create=%d recv=%d decode=%.1f meta=%.1f load=%.1f sched=%.1f save=%.1f encode=%.1f\n",
		n, msgBytes, len(marshalledOrdereddata), ctx.Timestamp().UnixMilli(), recvAt, tDecode, tMeta, tLoad, tSched, tSave, tEncode)
	fmt.Println("[Total Ordering Time]", time.Now().UnixMilli()-startelsaped)
}

// 체인코드가 읽기 집합에 남기는 사용자·긴급 표시 (논문 Figure 7, zipfbench smallbank 체인코드).
// 체인코드는 호출자의 info_<사용자> 를 읽고, 긴급이면 flag_urgent 를 읽는다. 둘 다 init 말고는
// 아무도 쓰지 않는다.
const (
	userInfoPrefix = "info_"
	urgentFlagKey  = "flag_urgent"
)

// readTxMeta pulls the keys a transaction read and wrote out of its envelope.
// 풀리지 않는 트랜잭션(설정 트랜잭션 등)은 키가 없는 것으로 보고 그대로 통과시킨다.
func readTxMeta(index int, env *common.Envelope) TxMeta {
	meta := TxMeta{Index: index}
	invoker := ""

	payload, err := protoutil.UnmarshalPayload(env.Payload)
	if err != nil {
		return meta
	}
	if payload.Header != nil {
		if ch, err := protoutil.UnmarshalChannelHeader(payload.Header.ChannelHeader); err == nil {
			meta.TxID = ch.TxId
		}
	}
	transaction, err := protoutil.UnmarshalTransaction(payload.Data)
	if err != nil {
		return meta
	}

	for _, action := range transaction.Actions {
		chaincodeActionPayload, err := protoutil.UnmarshalChaincodeActionPayload(action.Payload)
		if err != nil || chaincodeActionPayload.Action == nil {
			continue
		}
		// 호출 인자 (클라이언트에 abort를 알릴 때 요청을 찾는 데 쓴다)
		if meta.Args == nil {
			if cpp, err := protoutil.UnmarshalChaincodeProposalPayload(chaincodeActionPayload.ChaincodeProposalPayload); err == nil {
				if cis, err := protoutil.UnmarshalChaincodeInvocationSpec(cpp.Input); err == nil &&
					cis.ChaincodeSpec != nil && cis.ChaincodeSpec.Input != nil {
					for _, a := range cis.ChaincodeSpec.Input.Args {
						meta.Args = append(meta.Args, string(a))
					}
				}
			}
		}
		responsePayload, err := protoutil.UnmarshalProposalResponsePayload(chaincodeActionPayload.Action.ProposalResponsePayload)
		if err != nil {
			continue
		}
		chaincodeAction, err := protoutil.UnmarshalChaincodeAction(responsePayload.Extension)
		if err != nil {
			continue
		}

		txRWSet := &rwsetutil.TxRwSet{}
		if err = txRWSet.FromProtoBytes(chaincodeAction.Results); err != nil {
			fmt.Println("RWSet unmarshal error:", err)
			continue
		}

		for _, ns := range txRWSet.NsRwSets {
			// 사용자는 체인코드가 처음 건드린 키로 본다. 체인코드 정의(_lifecycle)의 키는 사용자가 아니다.
			// 단, 체인코드가 사용자 정보 키(info_<사용자>)를 읽었으면 그 사용자다 (논문 Figure 7 방식,
			// smallbank 체인코드). 읽기 집합은 키 순으로 정렬되므로 "처음 읽은 키"는 호출 순서가 아니다.
			system := ns.NameSpace == "_lifecycle"

			for _, r := range ns.KvRwSet.Reads {
				if r.Key == "namespaces/fields/basic/Sequence" {
					continue
				}
				// 사용자·긴급 표시 키는 아무도 쓰지 않는 표시일 뿐이므로 충돌 그래프에 넣지 않는다
				if strings.HasPrefix(r.Key, userInfoPrefix) {
					invoker = strings.TrimPrefix(r.Key, userInfoPrefix)
					continue
				}
				if r.Key == urgentFlagKey {
					meta.Urgency = true
					continue
				}
				if meta.User == "" && !system {
					meta.User = r.Key
				}
				meta.Reads = append(meta.Reads, ns.NameSpace+"/"+r.Key)
				var ver Version
				if v := r.GetVersion(); v != nil {
					ver = Version{Exists: true, Block: v.BlockNum, Tx: v.TxNum}
				}
				meta.ReadVers = append(meta.ReadVers, ver)
			}

			for _, w := range ns.KvRwSet.Writes {
				if meta.User == "" && !system {
					meta.User = w.Key
				}
				meta.Writes = append(meta.Writes, ns.NameSpace+"/"+w.Key)

				var valMap map[string]interface{}
				if err := json.Unmarshal(w.Value, &valMap); err == nil {
					if userInfo, ok := valMap["UserInfo"].(map[string]interface{}); ok {
						if urgency, ok := userInfo["Urgency"].(bool); ok && urgency {
							meta.Urgency = true
						}
					}
				}
			}
		}
	}

	if invoker != "" {
		meta.User = invoker
	}
	return meta
}

// scheduleBatch decides which transactions of a batch commit, in what order, and
// which have to abort. txs[i].Index는 i와 같아야 한다.
//
// Fabric은 블록 안에서 앞선 트랜잭션이 쓴 키를 뒤의 트랜잭션이 (예전 버전으로) 읽었으면
// 뒤의 것을 무효로 한다. 그래서 "A가 읽은 키를 B가 쓴다"면 A가 B보다 앞에 와야 한다.
// 이 선후 관계가 고리를 이룰 때만 어느 하나를 버려야 하고, 그 밖에는 순서만 맞추면
// 모두 커밋된다. 같은 키를 쓰기만 하는 트랜잭션끼리는 충돌이 아니다.
//
// 고리에서 버릴 트랜잭션은 다음 순서로 고른다.
//  1. 긴급이 아닌 것을 먼저 버린다.
//  2. 고리를 더 많이 끊는 것을 버린다 (전체 abort 수를 줄인다).
//  3. 그래도 같으면 실패율이 낮은 사용자의 것을 버린다 (실패가 한 사용자에게 몰리지 않게 한다).
//  4. 그래도 같으면 늦게 들어온 것을 버린다.
func scheduleBatch(txs []TxMeta, stats map[string]*UserStat) (order []int, aborted []int) {
	n := len(txs)
	after := conflictGraph(txs)
	alive := make([]bool, n)
	for i := range alive {
		alive[i] = true
	}

	statOf := func(user string) *UserStat {
		if s, ok := stats[user]; ok {
			return s
		}
		return &UserStat{}
	}

	// 고리가 없어질 때까지, 고리로 얽힌 묶음마다 하나씩 버린다
	for {
		groups := cyclicGroups(after, alive)
		if len(groups) == 0 {
			break
		}
		for _, group := range groups {
			victim := pickVictim(group, txs, after, statOf)
			alive[victim] = false
			aborted = append(aborted, victim)
			if s, ok := stats[txs[victim].User]; ok {
				s.Abort++
			}
		}
	}

	// 남은 것은 선후 관계를 지키는 순서로 놓는다. 여럿이 가능하면 긴급을 먼저, 그다음은 들어온 순서다.
	order = topoOrder(after, alive, func(a, b int) bool { return txs[a].Urgency && !txs[b].Urgency })

	if verbose {
		fmt.Println("SUC", order)
		fmt.Println("ABO", aborted)
	}
	return order, aborted
}

// conflictGraph returns after[i]: the transactions that must come after i, i.e. the
// ones that write a key i read. 같은 배치 안에서 앞선 트랜잭션이 쓴 키를 뒤의 것이 읽으면
// 피어가 뒤의 것을 무효로 하므로, 읽은 쪽이 먼저 와야 한다.
func conflictGraph(txs []TxMeta) [][]int {
	n := len(txs)
	writers := make(map[string][]int)
	for i, tx := range txs {
		for _, key := range tx.Writes {
			writers[key] = append(writers[key], i)
		}
	}
	after := make([][]int, n)
	seen := make([]int, n)
	for i, tx := range txs {
		for _, key := range tx.Reads {
			for _, j := range writers[key] {
				if j != i && seen[j] != i+1 {
					seen[j] = i + 1
					after[i] = append(after[i], j)
				}
			}
		}
	}
	return after
}

// topoOrder places the live transactions so that every edge of after is respected.
// 놓을 수 있는 것이 여럿이면 prefer(a, b)가 참인 a를 먼저, 그 밖에는 들어온 순서대로 놓는다.
// after가 고리를 가지면 고리에 걸린 것은 빠진다.
func topoOrder(after [][]int, alive []bool, prefer func(a, b int) bool) (order []int) {
	n := len(after)
	waiting := make([]int, n)
	remaining := 0
	for i := 0; i < n; i++ {
		if !alive[i] {
			continue
		}
		remaining++
		for _, j := range after[i] {
			if alive[j] {
				waiting[j]++
			}
		}
	}
	placed := make([]bool, n)
	for len(order) < remaining {
		next := -1
		for i := 0; i < n; i++ {
			if !alive[i] || placed[i] || waiting[i] != 0 {
				continue
			}
			if next == -1 || (prefer != nil && prefer(i, next)) {
				next = i
			}
		}
		if next == -1 {
			break
		}
		placed[next] = true
		order = append(order, next)
		for _, j := range after[next] {
			if alive[j] {
				waiting[j]--
			}
		}
	}
	return order
}

// cyclicGroups returns the groups of live transactions that are tangled in a cycle
// (strongly connected components with more than one member, Tarjan's algorithm).
func cyclicGroups(after [][]int, alive []bool) [][]int {
	n := len(after)
	index := make([]int, n) // 0이면 아직 방문하지 않은 것
	low := make([]int, n)
	onStack := make([]bool, n)
	var stack []int
	var groups [][]int
	counter := 0

	var visit func(v int)
	visit = func(v int) {
		counter++
		index[v] = counter
		low[v] = counter
		stack = append(stack, v)
		onStack[v] = true

		for _, w := range after[v] {
			if !alive[w] {
				continue
			}
			if index[w] == 0 {
				visit(w)
				if low[w] < low[v] {
					low[v] = low[w]
				}
			} else if onStack[w] && index[w] < low[v] {
				low[v] = index[w]
			}
		}

		if low[v] == index[v] {
			var group []int
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				group = append(group, w)
				if w == v {
					break
				}
			}
			if len(group) > 1 {
				groups = append(groups, group)
			}
		}
	}

	for v := 0; v < n; v++ {
		if alive[v] && index[v] == 0 {
			visit(v)
		}
	}
	return groups
}

// pickVictim chooses which transaction of a cyclic group to abort.
func pickVictim(group []int, txs []TxMeta, after [][]int, statOf func(string) *UserStat) int {
	inGroup := make(map[int]bool, len(group))
	for _, v := range group {
		inGroup[v] = true
	}

	// 묶음 안에서 들어오고 나가는 선이 많을수록 여러 고리에 걸쳐 있다
	in := make(map[int]int, len(group))
	out := make(map[int]int, len(group))
	for _, v := range group {
		for _, w := range after[v] {
			if inGroup[w] {
				out[v]++
				in[w]++
			}
		}
	}

	victim := group[0]
	for _, v := range group[1:] {
		a, b := txs[v], txs[victim]
		switch {
		case a.Urgency != b.Urgency:
			if !a.Urgency {
				victim = v
			}
		case in[v]*out[v] != in[victim]*out[victim]:
			if in[v]*out[v] > in[victim]*out[victim] {
				victim = v
			}
		case statOf(a.User).failRatio() != statOf(b.User).failRatio():
			if statOf(a.User).failRatio() < statOf(b.User).failRatio() {
				victim = v
			}
		case v > victim:
			victim = v
		}
	}

	if verbose {
		s := statOf(txs[victim].User)
		fmt.Printf("ABORT tx %d (%s, urgent=%v, %d/%d failed so far)\n", victim, txs[victim].User, txs[victim].Urgency, s.Abort, s.Submit)
	}
	return victim
}

// 사용자별 제출·실패 건수는 MongoDB의 User.abortTransaction에 누적한다.
//   { user, submitCount, abortCount }
type userStatDoc struct {
	User   string `bson:"user"`
	Submit int64  `bson:"submitCount"`
	Abort  int64  `bson:"abortCount"`
}

const userStatTimeout = 3 * time.Second

var (
	userStatOnce       sync.Once
	userStatCollection *mongo.Collection
)

func userStats() *mongo.Collection {
	userStatOnce.Do(func() {
		client, err := mongo.Connect(context.Background(), options.Client().ApplyURI("mongodb://localhost:27017"))
		if err != nil {
			log.Printf("MongoDB 연결 실패: %v", err)
			return
		}
		userStatCollection = client.Database("User").Collection("abortTransaction")
		// user 로 찾고 upsert 하므로 인덱스가 없으면 갱신마다 컬렉션 전체를 훑는다
		// (배치 100건에 저장이 수십 ms 걸렸다). 이미 있으면 아무 일도 하지 않는다.
		ctx, cancel := context.WithTimeout(context.Background(), userStatTimeout)
		defer cancel()
		if _, err := userStatCollection.Indexes().CreateOne(ctx, mongo.IndexModel{
			Keys:    bson.D{{Key: "user", Value: 1}},
			Options: options.Index().SetUnique(true),
		}); err != nil {
			log.Printf("MongoDB user 인덱스 생성 실패: %v", err)
		}
	})
	return userStatCollection
}

// loadUserStats returns the totals of the users in this batch, with the batch's
// own submissions already added. MongoDB를 읽지 못해도 순서 결정은 멈추지 않는다.
// 그 배치에서는 모두 처음 보는 사용자로 취급될 뿐이다.
func loadUserStats(submitted map[string]int) map[string]*UserStat {
	stats := make(map[string]*UserStat, len(submitted))
	users := make([]string, 0, len(submitted))
	for user := range submitted {
		stats[user] = &UserStat{}
		users = append(users, user)
	}

	if collection := userStats(); collection != nil && len(users) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), userStatTimeout)
		defer cancel()

		cursor, err := collection.Find(ctx, bson.M{"user": bson.M{"$in": users}})
		if err != nil {
			log.Printf("MongoDB 조회 실패: %v", err)
		} else {
			defer cursor.Close(ctx)
			for cursor.Next(ctx) {
				var doc userStatDoc
				if err := cursor.Decode(&doc); err != nil {
					log.Printf("Decode 실패: %v", err)
					continue
				}
				if s, ok := stats[doc.User]; ok {
					s.Submit = int(doc.Submit)
					s.Abort = int(doc.Abort)
					// 제출 건수를 세기 전에 쌓인 실패 기록은 적어도 그만큼은 제출한 것이다
					if s.Submit < s.Abort {
						s.Submit = s.Abort
					}
				}
			}
		}
	}

	for user, count := range submitted {
		stats[user].Submit += count
	}
	return stats
}

func saveUserStats(submitted, aborted map[string]int) {
	collection := userStats()
	if collection == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), userStatTimeout)
	defer cancel()

	// 사용자마다 따로 보내면 배치 하나에 수십~백 번 왕복하므로 한 번에 보낸다.
	// 다음 배치가 이 결과를 읽어야 하므로 commit을 내보내기 전에 끝낸다.
	models := make([]mongo.WriteModel, 0, len(submitted))
	for user, count := range submitted {
		models = append(models, mongo.NewUpdateOneModel().
			SetFilter(bson.M{"user": user}).
			SetUpdate(bson.M{"$inc": bson.M{"submitCount": count, "abortCount": aborted[user]}}).
			SetUpsert(true))
	}
	if len(models) == 0 {
		return
	}
	if _, err := collection.BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false)); err != nil {
		log.Printf("MongoDB 업데이트 실패: %v", err)
	}
}

// Write a processor that consumes data from Kafka
func (bs *Blocks) runProcessor() {
	channel := "mychannel-incoming"
	fmt.Println("Starting processor for channel:", channel)
	tm, err := goka.NewTopicManager(brokers2, goka.DefaultConfig(), tmc)
	if err != nil {
		log.Fatalf("Error creating topic manager: %v", err)
	}
	defer tm.Close()

	for _, topic := range []goka.Stream{goka.Stream(channel), TopicCommit, TopicAbort} {
		if err := tm.EnsureStreamExists(string(topic), 3); err != nil {
			log.Printf("Error creating kafka topic %s: %v", topic, err)
		}
	}

	newBlock := Block{
		ChannelID:    channel,
		OutputStream: TopicAbort,
	}
	bs.List = append(bs.List, newBlock)

	group := goka.Group(channel + "-group")
	g := goka.DefineGroup(
		group,
		goka.Input(goka.Stream(channel), new(codec.Bytes), bs.process),
		goka.Output(TopicCommit, new(codec.Bytes)),
		goka.Output(TopicAbort, new(codec.Bytes)),
		goka.Persist(new(blockCodec)),
	)

	p, err := goka.NewProcessor(
		brokers2,
		g,
		goka.WithTopicManagerBuilder(goka.TopicManagerBuilderWithTopicManagerConfig(tmc)),
		goka.WithConsumerGroupBuilder(goka.DefaultConsumerGroupBuilder),
	)
	if err != nil {
		log.Fatalf("creating processor: %v", err)
	}

	p.Run(context.Background())
}

// Writing a view to query the user table
func (bs *Blocks) runView(initialized chan struct{}) error {
	<-initialized

	channel := <-bs.PeerContribution.ChannelTrigger
	group := goka.Group(channel + "-group")
	view, err := goka.NewView(brokers2, goka.GroupTable(group), new(blockCodec))
	if err != nil {
		return fmt.Errorf("creating view: %w", err)
	}
	return view.Run(context.Background())
}
func main() {

	kafka := flag.String("broker", "127.0.0.1", "Kafka broker")
	brokerList := flag.String("brokers", "", "comma-separated Kafka brokers (host:port,...); overrides -broker. 예: 도커 내부망 kafka1:9090,kafka2:9090,kafka3:9090 (NOTES §45)")
	bind := flag.String("bind", ":8082", "server bind address")
    tcp := flag.Bool("tcp", false, "also listen on TCP")
	algo := flag.String("algo", "serializer", "ordering algorithm: serializer | fabricpp | htfabric | epsilon")
	flag.Float64Var(&epsilonUrgent, "eps-urgent", 1.0, "epsilon: share of urgent transactions ordered by the conflict graph (0..1)")
	flag.Float64Var(&epsilonLow, "eps-low", 1.0, "epsilon: share of low-priority transactions ordered by the conflict graph (0..1)")
	flag.Float64Var(&abortAlpha, "alpha", 1.0, "epsilon: abort score f(n) = exp(alpha*n)")
	flag.BoolVar(&verbose, "verbose", false, "print per-batch order and every victim")
	flag.StringVar(&abortMode, "abort-mode", "separate", "how to send abort records: separate (own producer, default) | inline (same goka producer, adds ~40 ms to commit) | delayed (own producer, after -abort-delay)")
	flag.DurationVar(&abortDelay, "abort-delay", 0, "delay before sending abort records when -abort-mode=delayed")
	flag.Parse()

	if s, ok := schedulers[*algo]; ok {
		schedule = s
	} else {
		log.Fatalf("unknown -algo %q (serializer | fabricpp | htfabric | epsilon)", *algo)
	}
	fmt.Println("Ordering algorithm:", *algo)

	brokers1 = "" + *kafka + ":9091, " + *kafka + ":9092, " + *kafka + ":9093" + ""
	brokers2 = []string{
		fmt.Sprintf("%s:9091", *kafka),
		fmt.Sprintf("%s:9092", *kafka),
		fmt.Sprintf("%s:9093", *kafka),
	}
	if *brokerList != "" {
		brokers2 = nil
		for _, b := range strings.Split(*brokerList, ",") {
			if b = strings.TrimSpace(b); b != "" {
				brokers2 = append(brokers2, b)
			}
		}
		brokers1 = strings.Join(brokers2, ", ")
	}
	fmt.Println("Kafka brokers:", brokers2)

	if err := startAbortProducer(brokers2); err != nil {
		log.Fatalf("abort producer: %v", err)
	}

	go weavehttp.Http3Listen(*bind,*tcp)

	bs := Blocks{
		PeerContribution: contribution.FabricChannel{
			ChannelTrigger: make(chan string),
		},
	}

	go bs.PeerContribution.Start(brokers1)

	go func() {
		bs.runProcessor()
	}()

	initialized := make(chan struct{})
	go func() {
		if err := bs.runView(initialized); err != nil {
			log.Fatalf("View error: %v", err)
		}
	}()

	select {} 
}
