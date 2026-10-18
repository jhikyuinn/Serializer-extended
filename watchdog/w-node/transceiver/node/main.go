package main

import (
        "context"
        "crypto/rand"
        "crypto/rsa"
        "crypto/sha256"
        "crypto/sha512"
        "crypto/tls"
        "crypto/x509"
        "encoding/hex"
        "encoding/json"
        "encoding/pem"
        "strings"
        "flag"
        "fmt"
        "io"
        "log"
        "math/big"
        "net"
        "net/http"
        "strconv"
        "sync/atomic"
        "time"
        "sort"
        "os"
       
        "google.golang.org/protobuf/proto"

        lg "auditchain/ledger"
        pb "auditchain/msg"
        wp2p "auditchain/wp2p"

        "github.com/confluentinc/confluent-kafka-go/v2/kafka"
        "github.com/herumi/bls-eth-go-binary/bls"
        "github.com/prometheus/client_golang/prometheus/promhttp"
        "github.com/quic-go/quic-go"
        "google.golang.org/grpc"

        "go.mongodb.org/mongo-driver/bson"
        "go.mongodb.org/mongo-driver/mongo"
        "go.mongodb.org/mongo-driver/mongo/options"
)

// ======================= Structs =======================
type CONSENSUSNODE struct {
        address          string
        selfId           string
        roundIdx         uint32
        members          []*pb.Wnode
        isLeader         atomic.Bool
        leader           bool
        channelID        string
        done             chan bool
        pendingCommittee *pb.CommitteeMsg // 새 커미티 대기용

        kafkaConsumer    *kafka.Consumer
        blockMsg         *pb.TransactionMsg
        memberMsg        *pb.MemberMsg
        auditMsg         *pb.AuditMsg
        cancel           context.CancelFunc
        isRunning        atomic.Bool
        isChildListening atomic.Bool
        // 이 노드가 리더인 커미티의 라운드 번호. 리더가 아니면 0.
        leaderRound      atomic.Uint32
        publicKeyMap map[string]*bls.PublicKey
}

// ======================= Constants =======================
const (
        validatorIP       = "127.0.0.1"
        validatorGrpcPort = "16220"
        validatorNatPort  = "11730"
        gossipMsgPort     = ":4242"
        grpcPort          = ":5252"
        gossipListenPort  = ":6262"
        prometheusPort    = ":12345"
        abortTopic ="mychannel-abort"
        addrDB = "mongodb://127.0.0.1:27017"
)

type VRFNode struct {
        NodeID string
        PubKey []byte
        Seed   string
        Proof  []byte
        Value  *big.Int
}

var VRFGlobal *VRFNode

// 합의 메시지의 MerkleRootHash 자리에 채우는 바이트 수 (블록 크기를 흉내 낸다)
var paddingSize *int

// 한 블록에 묶는 abort 기록의 최대 개수. 오래 멈췄다 복구될 때 블록이 지나치게 커지지 않게 한다.
var maxBatch *int

const (
        // 반영되지 않은 abort 기록이 있는데 이 시간 동안 원장이 그대로면 리더가 죽은 것으로 본다
        stallTimeout = 20 * time.Second
        // 모든 노드가 벽시계의 같은 시각에 판단한다. 재등록이 한꺼번에 일어나야 커미티가 하나로 만들어진다.
        stallCheckPeriod = 10 * time.Second
)

// ======================= Global Variables =======================
var (
	startConsensusTime int64
	nodename,_           = os.Hostname()
	kafkaGroupID      = "GROUP"+nodename
	seed string

	// ======================= Kafka / Network =======================
	validatorGrpcAddr string
	validatorNatAddr  string
	brokers           string
	leaderChan        string

	// ======================= BLS =======================
	sec    bls.SecretKey // 노드의 BLS 비밀키, VRF에도 활용
	pub    *bls.PublicKey // 노드의 BLS 공개키, VRF에도 활용
	sigVec []bls.Sign // 네트워크에 참여하는 노드들의 BLS 서명 모음
	pubVec []bls.PublicKey // 네트워크에 참여하는 노드들의 BLS 공개키 모음

			mongoclient *mongo.Client

	// ======================= Context =======================
	ctx    context.Context
	cancel context.CancelFunc

	// ======================= Consensus Status =======================
	consensusStatusMap map[string]bool

)

// ======================= Main =======================
func main() {
        defaultValidatorAddr := flag.String("snode", "127.0.0.1", "Validator node IP address")
        kafkaProcessorAddr := flag.String("broker", "127.0.0.1", "Kafka broker IP address")
        libp2pAddr := flag.String("libp2p", "/ip4/127.0.0.1/tcp/4001/p2p/QmSP2ouvsYDhj4ne8FCfhSzAiQJBDBvoUPZtnQWYG8ZW8m", "Libp2p multiaddress")
        channel := flag.String("channel", "mychannel", "Channel name")
        consensusProtocol := flag.Bool("networktype", false, "true = MP2BTP, false = QUIC")
        paddingSize = flag.Int("padding", 100000000, "합의 메시지에 채워 넣는 블록 크기 (바이트)")
        maxBatch = flag.Int("maxbatch", 50, "한 블록에 묶는 abort 기록의 최대 개수")
        snodeCheck := flag.Duration("snodeping", time.Second, "s-node 연결을 확인(ping)하고 끊겼으면 다시 붙는 주기. 응답 대기도 같다 (예전 3초, NOTES §48)")
        snodeDial := flag.Duration("snodedial", time.Second, "s-node 에 다시 붙을 때 한 번 기다리는 시간 (예전 5초)")
        regRetry = flag.Duration("regretry", 200*time.Millisecond, "s-node 등록이 실패했을 때 다시 시도하기까지 (예전 1초)")
        regTimeout = flag.Duration("regtimeout", time.Second, "s-node 등록 한 번을 기다리는 시간 (예전 5초)")

        flag.Parse()
        wp2p.SnodeCheckInterval = *snodeCheck
        wp2p.SnodeDialTimeout = *snodeDial

        validatorGrpcAddr = *defaultValidatorAddr + ":16220"
        validatorNatAddr = *defaultValidatorAddr + ":11730"
        brokers = *kafkaProcessorAddr + ":9091," + *kafkaProcessorAddr + ":9092," + *kafkaProcessorAddr + ":9093"
        leaderChan = *channel

        var consensusNode CONSENSUSNODE
        consensusNode = CONSENSUSNODE{
                done:      make(chan bool, 1),
                blockMsg:  &pb.TransactionMsg{},
                auditMsg:  &pb.AuditMsg{},
                memberMsg: &pb.MemberMsg{},
        }

        go wp2p.Start(true, *libp2pAddr, 4010)
        time.Sleep(3 * time.Second)

        consensusNode.selfId = wp2p.Host
        fmt.Println("[HOST ID]", consensusNode.selfId)

        bls.Init(bls.BLS12_381)
        bls.SetETHmode(bls.EthModeDraft07)
        sec.SetByCSPRNG()
        pub = sec.GetPublicKey()

        http.Handle("/metrics", promhttp.Handler())
        // go monitoring()

        wp2p.JoinShard(leaderChan)

        consensusNode.start(*consensusProtocol)
}

func NewKafkaConsumer() *kafka.Consumer {
        c, err := kafka.NewConsumer(&kafka.ConfigMap{
                "bootstrap.servers":       brokers,
                "group.id":                kafkaGroupID,
                "auto.offset.reset":       "earliest",
                "enable.auto.commit":      false,
                "fetch.min.bytes":         1,
                "fetch.wait.max.ms":       10,
        })
        if err != nil {
                        log.Fatalf("Failed to create Kafka consumer: %v", err)
        }
        return c
}


func (w *CONSENSUSNODE) setLeaderChan(isLeader bool, channel string) {
        if w.channelID != channel {
                        w.channelID = channel
        }
        w.isLeader.Store(isLeader)
}

func (w *CONSENSUSNODE) setDone(b bool) {
        w.done <- b
}

func (w *CONSENSUSNODE) start(consensusProtocol bool) {
        w.getOutboundIP()
        w.isLeader.Store(false)
        w.done = make(chan bool, 1)
        w.isRunning.Store(false)

        consensusStatusMap = make(map[string]bool)

        go w.LeaderLoop()
        go w.StallWatchdog()

        go w.CommitteeListening()
        go w.ConsensusListening()
        go w.BlockListening()

        w.publicKeyMap = make(map[string]*bls.PublicKey)

        // [GRPC: Membership Message]
        w.Reporting()
        time.Sleep(3 * time.Second)
        ReportExternal(w.selfId)

        // s-node가 교체되면 새 s-node는 멤버 정보가 없으므로 다시 등록한다
        wp2p.SetOnReconnect(w.Reporting)

        w.ListenForCommitteeMsgs()
}

func (w *CONSENSUSNODE) ListenForCommitteeMsgs() {
        for {
            msg := <-committeeMsgChannel // 어떤 방식으로든 메시지를 수신했다고 가정
            log.Println(msg)
        }
}

var committeeMsgChannel = make(chan *pb.CommitteeMsg, 10)

// ======================= Committee Listening =======================
func (w *CONSENSUSNODE) CommitteeListening() {
        listener, err := net.Listen("tcp", w.address+gossipListenPort)
        if err != nil {
                        log.Fatalf("Failed to listen on %s: %v", w.address+gossipListenPort, err)
        }
        defer listener.Close()

        fmt.Println("🟢 Committee Listening on", w.address+gossipListenPort)

        for {
                conn, err := listener.Accept()
                if err != nil {
                                log.Println("⚠️ Accept error:", err)
                                continue
                }
                go w.CommConnHandler(conn)
        }
}

func (w *CONSENSUSNODE) CommConnHandler(conn net.Conn) {
        defer conn.Close()

        recvBuf := make([]byte, 20000)
        n, err := conn.Read(recvBuf)
        if err != nil {
                if err != io.EOF {
                log.Printf("❌ Failed to read data: %v", err)
                }
                return
        }

        recvMsg := &pb.CommitteeMsg{}
        if err := json.Unmarshal(recvBuf[:n], recvMsg); err != nil {
                log.Printf("❌ Failed to unmarshal CommitteeMsg: %v", err)
                return
        }

        if w.isRunning.Load() {
                w.pendingCommittee = recvMsg
                log.Printf("⚠️ Still processing previous consensus round, storing new CommitteeMsg (round %d) as pending", recvMsg.RoundNum)
                return
        }

        w.applyCommittee(recvMsg)
}

// // Check if this peer is the leader; if so, it should receive messages from Kafka.
// // BlockListening listens for block insertion.
func (w *CONSENSUSNODE) BlockListening() {
        listener, err := net.Listen("tcp", w.address+grpcPort)
        if err != nil {
                log.Fatalf("❌ Failed to listen on %s: %v", w.address+grpcPort, err)
        }
        defer listener.Close()

        for {
                conn, err := listener.Accept()
                if err != nil {
                        log.Println("⚠️ Accept error:", err)
                        continue
                }
                go w.BloConnHandler(conn)
        }
}

func (w *CONSENSUSNODE) BloConnHandler(conn net.Conn) {
        defer conn.Close()

        recvBuf := make([]byte, 20000)
        n, err := conn.Read(recvBuf)
        if err != nil {
                if err == io.EOF {
                        log.Printf("🔌 Connection closed by client: %v", conn.RemoteAddr())
                } else {
                        log.Printf("❌ Failed to read data: %v", err)
                }
                return
        }

        MsgRecv := &pb.GossipMsg{}
        if err := json.Unmarshal(recvBuf[:n], MsgRecv); err != nil {
                log.Printf("❌ Failed to unmarshal GossipMsg: %v", err)
                return
        }

        // 합의 실패 통보: 블록은 없다. 새 커미티를 받기 위해 다시 등록한다.
        if MsgRecv.Type == gossipRoundFailed {
                fmt.Println("🔁 Round failed: registering again for a new committee")
                w.Reporting()
                return
        }

        fmt.Println("📦 BLOCKINSERT: Committing block to ledger")
        go lg.BlkInsert(MsgRecv.Rndblk)
        elapsedMs := time.Now().UnixMilli() - MsgRecv.StartConsensusTime
        elapsedSec := float64(elapsedMs) / 1000.0

        fmt.Printf("consensus elapsed time: %.3f seconds\n", elapsedSec)
        w.Reporting()
}

// ======================= Kafka Listener =======================
// 프로세서가 abort 토픽에 올리는 기록. data(Fabric Envelope)는 읽지 않고,
// 프로세서가 세어 준 사용자별 abort 건수만 쓴다.
type AbortPayload struct {
	Timestamp int64            `json:"timestamp"`
	Users     map[string]int32 `json:"users"`
}

const (
        gossipBlock       = 2 // 합의된 블록
        gossipRoundFailed = 3 // 합의 실패 통보
)

// LeaderLoop runs consensus rounds while this node leads a committee.
//
// 어디까지 반영했는지는 노드가 아니라 원장이 기억한다. 리더는 원장의 마지막 블록이 끝난
// 자리부터 abort 토픽을 읽으므로, 리더가 바뀌어도 기록이 빠지거나 두 번 들어가지 않는다.
// 합의에 실패하면 블록이 없으니 원장도 그대로이고, 다음 리더가 같은 자리부터 다시 읽는다.
func (w *CONSENSUSNODE) LeaderLoop() {
        w.kafkaConsumer = NewKafkaConsumer()

        for {
                round := w.leaderRound.Load()
                if round == 0 {
                        time.Sleep(200 * time.Millisecond)
                        continue
                }

                last, err := lg.LastAbortOffsets()
                if err != nil {
                        log.Printf("Failed to read the ledger: %v", err)
                        time.Sleep(time.Second)
                        continue
                }

                userCount, from, to, oldest, n, err := w.readPending(last)
                if err != nil {
                        log.Printf("Failed to read abort records: %v", err)
                        time.Sleep(time.Second)
                        continue
                }
                if n == 0 {
                        continue
                }

                fmt.Printf("📥 %d abort record(s) pending, starting consensus\n", n)
                startConsensusTime = oldest
                ok := w.bftConsensus(userCount, from, to)

                // 한 커미티는 한 라운드만 맡는다. 성공하면 블록을 받은 노드들이, 실패하면 통보를
                // 받은 노드들이 다시 등록해 새 커미티가 정해진다. 그사이 새 커미티가 이미
                // 적용됐다면 그 라운드의 리더 자격은 건드리지 않는다.
                w.leaderRound.CompareAndSwap(round, 0)

                if !ok {
                        fmt.Println("❌ Consensus failed: no block is recorded, the records stay pending")
                        wp2p.WDNMessage(wp2p.Wctx, wp2p.Shard[0], &pb.GossipMsg{Type: gossipRoundFailed, Channel: leaderChan})
                }
        }
}

// readPending reads the abort records that are not in the ledger yet, at most
// maxBatch of them, and merges them into one set of per-user counts.
func (w *CONSENSUSNODE) readPending(last map[int32]int64) (userCount map[string]int32, from, to map[int32]int64, oldest int64, n int, err error) {
        topic := abortTopic
        meta, err := w.kafkaConsumer.GetMetadata(&topic, false, 5000)
        if err != nil {
                return nil, nil, nil, 0, 0, err
        }

        from = make(map[int32]int64)
        to = make(map[int32]int64)
        var assignment []kafka.TopicPartition
        for _, p := range meta.Topics[topic].Partitions {
                start := firstReadable(w.kafkaConsumer, topic, p.ID, last[p.ID])
                from[p.ID] = start
                to[p.ID] = start
                assignment = append(assignment, kafka.TopicPartition{Topic: &topic, Partition: p.ID, Offset: kafka.Offset(start)})
        }
        if len(assignment) == 0 {
                time.Sleep(time.Second)
                return nil, from, to, 0, 0, nil
        }
        if err := w.kafkaConsumer.Assign(assignment); err != nil {
                return nil, nil, nil, 0, 0, err
        }
        defer w.kafkaConsumer.Unassign()

        userCount = make(map[string]int32)
        deadline := time.Now().Add(time.Second)

        for n < *maxBatch {
                msg, err := w.kafkaConsumer.ReadMessage(200 * time.Millisecond)
                if err != nil {
                        // 하나라도 읽었으면 더 기다리지 않고 그만큼으로 블록을 만든다
                        if n > 0 || time.Now().After(deadline) {
                                break
                        }
                        continue
                }

                n++
                to[msg.TopicPartition.Partition] = int64(msg.TopicPartition.Offset) + 1

                var abortPayload AbortPayload
                if err := json.Unmarshal(msg.Value, &abortPayload); err != nil {
                        log.Printf("Failed to unmarshal Kafka message: %v", err)
                        continue
                }
                if oldest == 0 || abortPayload.Timestamp < oldest {
                        oldest = abortPayload.Timestamp
                }
                for user, count := range abortPayload.Users {
                        userCount[user] += count
                }
        }
        return userCount, from, to, oldest, n, nil
}

// firstReadable returns where reading can actually start. Kafka는 보존 기간이 지난 기록을
// 지우므로, 원장의 위치가 이미 지워진 구간을 가리키면 남아 있는 첫 기록에서 시작한다.
// 그 사이의 기록은 반영하지 못한 채 사라진 것이다.
func firstReadable(c *kafka.Consumer, topic string, partition int32, ledgerOffset int64) int64 {
        low, _, err := c.QueryWatermarkOffsets(topic, partition, 5000)
        if err != nil || low <= ledgerOffset {
                return ledgerOffset
        }
        return low
}

// StallWatchdog asks for a new committee when records stay pending and the
// ledger does not move. 리더가 죽으면 실패를 알려 줄 노드가 없으므로 각자 판단한다.
func (w *CONSENSUSNODE) StallWatchdog() {
        consumer := NewKafkaConsumer()
        topic := abortTopic

        // 시간 대신 판단 횟수를 센다. 노드마다 몇 ms씩 다른 시각에 판단해도 같은 회차에
        // 같은 결론이 나와야 재등록이 한꺼번에 일어난다.
        var lastSeen string
        stalledChecks := 0

        for {
                now := time.Now()
                time.Sleep(now.Truncate(stallCheckPeriod).Add(stallCheckPeriod).Sub(now))

                last, err := lg.LastAbortOffsets()
                if err != nil {
                        continue
                }
                meta, err := consumer.GetMetadata(&topic, false, 5000)
                if err != nil {
                        continue
                }
                pending := false
                for _, p := range meta.Topics[topic].Partitions {
                        low, high, err := consumer.QueryWatermarkOffsets(topic, p.ID, 5000)
                        // 이미 지워진 구간은 밀린 것으로 치지 않는다
                        if err == nil && high > last[p.ID] && high > low {
                                pending = true
                        }
                }

                seen := fmt.Sprint(last)
                if !pending || seen != lastSeen {
                        lastSeen = seen
                        stalledChecks = 0
                        continue
                }
                stalledChecks++
                if stalledChecks >= int(stallTimeout/stallCheckPeriod) {
                        fmt.Println("⏳ Records are pending but the ledger is not moving: registering again for a new committee")
                        stalledChecks = 0
                        w.Reporting()
                }
        }
}
    
type VRFCandidate struct {
        Node *pb.Wnode
        VRF  *big.Int
}

func (w *CONSENSUSNODE) applyCommittee(msg *pb.CommitteeMsg) {
	w.done = make(chan bool, 1)
	w.roundIdx = msg.RoundNum

	for _, shard := range msg.Shards {
		// 해당 shard에 내가 포함되어 있는지 확인
		containsSelf := false
		for _, mem := range shard.Member {
			if mem.NodeID == w.selfId {
				containsSelf = true
				break
			}
		}
		if !containsSelf {
			continue
		}

		// === (1) VRF 검증 및 후보 리스트 생성 ===
		var candidates []VRFCandidate
		for _, mem := range shard.Member {
			var pubKey bls.PublicKey
			if err := pubKey.Deserialize(mem.Publickey); err != nil {
				fmt.Printf("❌ Node %s PublicKey 역직렬화 실패\n", mem.NodeID)
				return
			}
                        w.publicKeyMap[mem.NodeID] = &pubKey

			vrfVal, ok := VerifyVRF(mem.Seed, mem.Proof, pubKey)
			if !ok {
				fmt.Printf("❌ Node %s VRF 검증 실패\n", mem.NodeID)
				return
			}
			fmt.Printf("✅ Node %s VRF 검증 성공\n", mem.NodeID)

			candidates = append(candidates, VRFCandidate{
				Node: mem,
				VRF:  vrfVal,
			})
		}

		// === (2) VRF 순으로 정렬 ===
		sort.Slice(candidates, func(i, j int) bool {
			return candidates[i].VRF.Cmp(candidates[j].VRF) < 0
		})

		// === (3) 위조 여부 확인 (순서 및 리더ID) ===
		for i := range shard.Member {
			if shard.Member[i].NodeID != candidates[i].Node.NodeID {
				fmt.Println("❌ Committee 멤버 순서 불일치 → 메시지 위조 가능성")
				return
			}
		}
		if shard.LeaderID != candidates[0].Node.NodeID {
			fmt.Println("❌ Leader 불일치 → 메시지 위조 가능성")
			return
		}

		// === (4) 합의 상태 적용 ===
		log.Printf("🔹 CommitteeMsg Round: %d 적용됨", msg.RoundNum)
		w.members = shard.Member
		w.leader = (shard.LeaderID == w.selfId)
		if w.leader {
			w.leaderRound.Store(msg.RoundNum)
		} else {
			w.leaderRound.Store(0)
		}
		w.channelID = leaderChan

		if w.leader {
			fmt.Println("🎉 Leader consensus node")
			go func() {
				defer w.setDone(false)
				defer w.isRunning.Store(false)
			}()
		} else {
			fmt.Println("🧩 Follower consensus node")
		}
		return
	}

	// 새 커미티에 들지 못했으면 이전 커미티의 리더 자격도 끝난다
	w.leader = false
	w.leaderRound.Store(0)
	fmt.Println("CommitteeMsg에 해당 노드가 포함되어 있지 않음")
}

func VerifyVRF(seed string, proof []byte, pubKey bls.PublicKey) (*big.Int, bool) {
        var sig bls.Sign
        if err := sig.Deserialize(proof); err != nil {
            return nil, false
        }
    
        seedHash := sha256.Sum256([]byte(seed))
        if !sig.FastAggregateVerify([]bls.PublicKey{pubKey}, seedHash[:]) {
            return nil, false
        }
    
        sigHash := sha256.Sum256(proof)
        vrfValue := new(big.Int).SetBytes(sigHash[:])
    
        return vrfValue, true
    }
    
func VRFHash(nodeID, seed string) *big.Int { 
        data := []byte(nodeID + seed) 
        hash := sha256.Sum256(data) 
        return new(big.Int).SetBytes(hash[:]) 
}

func GetMongoClient() {
        ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
        defer cancel()
        mongoclient, _ = mongo.Connect(ctx, options.Client().ApplyURI(addrDB))
}

func GetPrevBlockHash() (string, error) {
        GetMongoClient()
        collection := mongoclient.Database("ledger").Collection("blk")

        var lastBlock struct {
                CurHash string `bson:"CurHash"`
        }

        opts := options.FindOne().SetSort(bson.D{{Key: "_id", Value: -1}})

        err := collection.FindOne(context.Background(), bson.D{}, opts).Decode(&lastBlock)
        if err != nil {
                if err == mongo.ErrNoDocuments {
                        // 데이터가 없을 경우 기본값 반환
                        defaultHash := strings.Repeat("0", 64) // 64자리 0 (SHA-256 기본 길이)
                        return defaultHash, nil
                }
                return "", err // 다른 에러일 경우 그대로 반환
        }

        return lastBlock.CurHash, nil
}

func makePadding(size int) string {
        b := make([]byte, size)
        for i := range b {
            b[i] = 'A'
        }
        return string(b)
    }


// bftConsensus reports whether the block was agreed on. 합의되지 않으면 블록을 전파하지 않는다.
func (w *CONSENSUSNODE) bftConsensus(userCount map[string]int32, from, to map[int32]int64) bool {

        PrevHash, _ := GetPrevBlockHash()

        w.auditMsg = &pb.AuditMsg{
                BlkNum:              w.roundIdx,
                LeaderID:            w.selfId,
                PrevHash:	     PrevHash,
                PhaseNum:            pb.AuditMsg_PREPARE,
                MerkleRootHash:      makePadding(*paddingSize),
                Aborttransactionnum: userCount,
                AbortOffsetsFrom:    from,
                AbortOffsetsTo:      to,
                HonestAuditors: []*pb.HonestAuditor{
                        {Id: w.selfId},
                },
        }

        hashBytes := lg.BlockHashCalculator(w.auditMsg)
        hash := sha512.Sum512(hashBytes)
        w.auditMsg.CurHash = hex.EncodeToString(hash[:63])

        signing := sec.SignByte([]byte(w.auditMsg.CurHash))
        w.auditMsg.Signature = signing.Serialize()

        // ==== PREPARE & COMMIT Broadcasting ====
        fmt.Println("🚀 Broadcasting PREPARE")
        chPrepare := make(chan vote, len(w.members))
        for _, each := range w.members {
                go w.Submit(chPrepare, each, pb.AuditMsg_PREPARE, pb.AuditMsg_AGGREGATED_PREPARE)
        }

        quorum := quorumSize(len(w.members))
        if !w.waitForVotes(chPrepare, quorum, pb.AuditMsg_AGGREGATED_PREPARE) {
                return false
        }

        fmt.Println("🚀 Broadcasting COMMIT")
        chCommit := make(chan vote, len(w.members))
        for _, each := range w.members {
                go w.Submit(chCommit, each, pb.AuditMsg_COMMIT, pb.AuditMsg_AGGREGATED_COMMIT)
        }
        if !w.waitForVotes(chCommit, quorum, pb.AuditMsg_AGGREGATED_COMMIT) {
                return false
        }

        fmt.Println("📦 Disseminating block to peers")
        w.auditMsg.MerkleRootHash="abcdefghijklnmop"
        gossipMsg := &pb.GossipMsg{
                Type:   gossipBlock,
                Rndblk: w.auditMsg,
                StartConsensusTime:startConsensusTime,
        }
        wp2p.WDNMessage(wp2p.Wctx, wp2p.Shard[0], gossipMsg)
        return true
}

// 멤버 주소는 다중 경로용으로 목록이 됐다. QUIC 버전은 첫 번째 주소 하나만 쓴다.
func primaryAddr(m *pb.Wnode) string {
        if len(m.Addrs) == 0 {
                return ""
        }
        return m.Addrs[0]
}

// 멤버 n개 중 f = (n-1)/3 개가 응답하지 않아도 합의가 되려면 n-f 표가 필요하다.
// n이 3f+1 꼴이면 2f+1과 같은 값이다.
func quorumSize(n int) int {
        return n - (n-1)/3
}

// 한 멤버가 낸 표. msg가 nil이면 그 멤버에게서 유효한 응답을 받지 못한 것이다.
type vote struct {
        nodeID string
        msg    *pb.AuditMsg
}

/*I'm a leader, send a message to a w-node*/
func (w *CONSENSUSNODE) Submit(votes chan<- vote, member *pb.Wnode, currentPhase pb.AuditMsg_Phases, targetPhase pb.AuditMsg_Phases) {
        ip := primaryAddr(member)
        ch := make(chan *pb.AuditMsg, 1)
        defer func() { votes <- vote{nodeID: member.NodeID, msg: <-ch} }()

        tlsConf := &tls.Config{
                InsecureSkipVerify: true,
                NextProtos:         []string{"quic-echo-example"},
        }
        session, err := quic.DialAddr(context.Background(), ip+gossipMsgPort, tlsConf, nil)
        if err != nil {
                log.Printf("❌ Failed to connect to %s: %v", ip+gossipMsgPort, err)
                ch <- nil
                return
        }

        defer session.CloseWithError(0, "")

        stream, err := session.OpenStreamSync(context.Background())
        if err != nil {
                log.Printf("❌ Failed to open stream: %v", err)
                ch <- nil
                return
        }

        msgSnap := proto.Clone(w.auditMsg).(*pb.AuditMsg)
        msgSnap.PhaseNum = currentPhase

        // size := proto.Size(msgSnap) 
        // fmt.Println("AuditMsg whole size:", size, "bytes")

        enc := json.NewEncoder(stream)
        if err := enc.Encode(msgSnap); err != nil {
                log.Printf("❌ JSON encode error: %v", err)
                ch <- nil
                return
        }

        type closeWriter interface{ CloseWrite() error }
        if cw, ok := any(stream).(closeWriter); ok {
                _ = cw.CloseWrite()
        }

        dec := json.NewDecoder(stream)
        msg := &pb.AuditMsg{}
        if err := dec.Decode(msg); err != nil {
                log.Printf("❌ JSON decode error: %v", err)
                ch <- nil
                return
        }

        if msg.PhaseNum == targetPhase {
                ch <- msg
        } else {
                ch <- nil
        }
}

/*Consensus three-phases: Announce(Completed State), Prepare, Commit] I'm not a leader*/
func (w *CONSENSUSNODE) ConsensusListening() {
        listener, err := quic.ListenAddr(w.address+gossipMsgPort, generateTLSConfig(), nil)
        if err != nil {
                log.Fatalf("❌ QUIC Listen error: %v", err)
        }

        fmt.Println("🟣 Consensus data Listening on", w.address+gossipMsgPort)

        for {
                sess, err := listener.Accept(context.Background())
                if err != nil {
                log.Println("❌ Session accept error:", err)
                continue
                }

                stream, err := sess.AcceptStream(context.Background()) 
                        if err != nil { 
                                panic(err) 
                        } 
                        go w.StreamHandler(stream)
        }
}

func (w *CONSENSUSNODE) StreamHandler(stream quic.Stream) {
        defer stream.Close()
    
        dec := json.NewDecoder(stream)
    
        for {
            msg := new(pb.AuditMsg)
            if err := dec.Decode(msg); err != nil {

                if err == io.EOF {
                    return
                }
                log.Println("❌ JSON decode error:", err)
                return
            }

    
            switch msg.PhaseNum {
            case pb.AuditMsg_PREPARE:
                // 응답 보내고 끝내는 프로토콜이면 return
                if w.acceptProposal(msg) {
                    w.sendResponse(pb.AuditMsg_AGGREGATED_PREPARE,msg,stream)
                } else {
                    w.sendResponse(pb.AuditMsg_PHASE_UNSPECIFIED, msg, stream)
                }
                return
    
            case pb.AuditMsg_COMMIT:
                if w.verifying(msg) {
                    w.sendResponse(pb.AuditMsg_AGGREGATED_COMMIT, msg,stream)
                }else {
                        // ✅ COMMIT 검증 실패에도 응답하도록
                        w.sendResponse(pb.AuditMsg_PHASE_UNSPECIFIED, msg, stream)
                    }
                return
    
            default:
                continue
            }
        }
    }

// acceptProposal reports whether a proposed block continues from this node's ledger.
// 이미 원장에 있는 구간을 다시 담은 제안(뒤처진 리더)은 거절한다.
func (w *CONSENSUSNODE) acceptProposal(msg *pb.AuditMsg) bool {
        last, err := lg.LastAbortOffsets()
        if err != nil {
                log.Printf("Failed to read the ledger: %v", err)
                return false
        }

        progress := false
        for partition, to := range msg.AbortOffsetsTo {
                from := msg.AbortOffsetsFrom[partition]
                if from < last[partition] {
                        fmt.Printf("❌ Proposal rejected: partition %d starts at %d but the ledger is already at %d\n", partition, from, last[partition])
                        return false
                }
                if to < from {
                        return false
                }
                if to > from {
                        progress = true
                }
        }
        if !progress {
                fmt.Println("❌ Proposal rejected: it covers no abort record")
        }
        return progress
}

func (w *CONSENSUSNODE) updateAuditFields(msg *pb.AuditMsg) {
        auditors := make([]*pb.HonestAuditor, 0, len(msg.HonestAuditors)+1)
    
        already := false
        for _, a := range msg.HonestAuditors {
            if a == nil {
                continue
            }
            auditors = append(auditors, a)
            if a.Id == w.selfId {
                already = true
            }
        }
    
        if !already {
            auditors = append(auditors, &pb.HonestAuditor{Id: w.selfId})
        }
    
        msg.HonestAuditors = auditors
    }
    

func (w *CONSENSUSNODE) sendResponse(targetPhase pb.AuditMsg_Phases,cMsg *pb.AuditMsg,stream quic.Stream) { 

        resp := proto.Clone(cMsg).(*pb.AuditMsg)

        signing := sec.SignByte([]byte(resp.CurHash))
        resp.Signature = signing.Serialize()
        resp.PhaseNum = targetPhase
    
        w.updateAuditFields(resp)
    
        enc := json.NewEncoder(stream)
        if err := enc.Encode(resp); err != nil {
            log.Printf("❌ JSON encode error: %v", err)
            return
        }
        if cw, ok := any(stream).(interface{ CloseWrite() error }); ok {
            _ = cw.CloseWrite()
        }
}

func (w *CONSENSUSNODE) Multisinging(cMsgs *pb.AuditMsg, sigVec []bls.Sign) (bool, int) {
        switch cMsgs.PhaseNum {
        case pb.AuditMsg_AGGREGATED_PREPARE:
                return w.aggregateAndPrepare(cMsgs, sigVec), len(w.auditMsg.HonestAuditors)

        case pb.AuditMsg_AGGREGATED_COMMIT:
                return w.aggregateAndCommit(cMsgs, sigVec), len(w.auditMsg.HonestAuditors)

        default:
                return false, 0
        }
}

func (w *CONSENSUSNODE) aggregateAndPrepare(cMsgs *pb.AuditMsg, sigVec []bls.Sign) bool {
        return w.aggregateAndSet(cMsgs, sigVec, pb.AuditMsg_COMMIT)
}

func (w *CONSENSUSNODE) aggregateAndCommit(cMsgs *pb.AuditMsg, sigVec []bls.Sign) bool {
        return w.aggregateAndSet(cMsgs, sigVec, pb.AuditMsg_AGGREGATED_COMMIT)
}

func (w *CONSENSUSNODE) aggregateAndSet(cMsgs *pb.AuditMsg, sigVec []bls.Sign, phase pb.AuditMsg_Phases) bool {
        var aggeSign bls.Sign
        aggeSign.Aggregate(sigVec)
        byteSig := aggeSign.Serialize()

        w.auditMsg.BlkNum = cMsgs.BlkNum
        w.auditMsg.PrevHash = cMsgs.PrevHash
        w.auditMsg.CurHash = cMsgs.CurHash
        w.auditMsg.Signature = byteSig
        w.auditMsg.PhaseNum = phase
        return true
}

func (w *CONSENSUSNODE) verifying(cMsg *pb.AuditMsg) bool {
        pubVec = pubVec[:0]
        seenKeys := make(map[string]bool)

        members := make(map[string]bool, len(w.members))
        for _, m := range w.members {
                members[m.NodeID] = true
        }

        for _, honestID := range cMsg.HonestAuditors {
                if !members[honestID.Id] {
                        fmt.Printf("❌ Signer %s is not in the committee\n", honestID.Id)
                        return false
                }
                if pk := w.getPublicKeyByNodeID(honestID.Id); pk != nil {
                        keyBytes := pk.Serialize()
                        keyStr := string(keyBytes) // serialize된 바이트를 문자열로

                        if !seenKeys[keyStr] {
                        pubVec = append(pubVec, *pk)
                        seenKeys[keyStr] = true
                        } else {
                        fmt.Printf("⚠️ Duplicate public key ignored for node: %s\n", honestID.Id)
                        }
                } else {
                        fmt.Printf("Missing public key for node: %s\n", honestID.Id)
                }
        }
        

        // 서명이 맞더라도 서명자가 정족수에 못 미치면 합의된 것이 아니다
        if quorum := quorumSize(len(w.members)); len(pubVec) < quorum {
                fmt.Printf("❌ AGGREGATED_COMMIT: %d signer(s), quorum is %d\n", len(pubVec), quorum)
                return false
        }

        var decSign bls.Sign
        if err := decSign.Deserialize(cMsg.Signature); err != nil {
                fmt.Println("Signature deserialization error:", err)
                return false
        }

        switch cMsg.PhaseNum {
        case pb.AuditMsg_COMMIT:
                if decSign.FastAggregateVerify(pubVec, []byte(cMsg.CurHash)) {
                        fmt.Println("✅ AGGREGATED_COMMIT: Verification SUCCESS")
                        return true
                }  
                fmt.Println("❌ AGGREGATED_COMMIT: Verification ERROR")
        }
        return false
}


func (w *CONSENSUSNODE) getPublicKeyByNodeID(id string) *bls.PublicKey {
        if pk, ok := w.publicKeyMap[id]; ok {
		return pk
	}
	fmt.Printf("🔍 Public key for node %s not found in publicKeyMap\n", id)
	return nil
}

func (w *CONSENSUSNODE) getOutboundIP() string {
        conn, err := net.Dial("udp", "8.8.8.8:80")
        if err != nil {
                panic(err)
        }
        defer conn.Close()
        localAddr := conn.LocalAddr().(*net.UDPAddr)
        w.address=localAddr.IP.String()

        return localAddr.IP.String()
}

func GenerateVRF(nodeID string, seed string) {
        seed = strconv.FormatInt(time.Now().UnixMilli(), 10)
        nodeinit := &VRFNode{
                NodeID: nodeID,
                PubKey: pub.Serialize(),
        }

        hash := sha256.Sum256([]byte(seed))
        sign := sec.SignByte(hash[:]) 
        nodeinit.Proof = sign.Serialize()
        nodeinit.Seed = seed
        vrfHash := sha256.Sum256(sign.Serialize())
        nodeinit.Value = new(big.Int).SetBytes(vrfHash[:])
        VRFGlobal = nodeinit

}

// 등록 재시도 간격과 한 번의 대기 시간 (-regretry, -regtimeout)
var regRetry, regTimeout *time.Duration

/*GRPC SERVICE Membershhip Exchanging Procedure*/
func (w *CONSENSUSNODE) Reporting() {
        GenerateVRF(w.address, seed)
        req := createSelfMembership(w.selfId, w.address,"11730", VRFGlobal)

        // 활성 s-node가 교체되는 동안에는 실패하므로 성공할 때까지 재시도한다
        for {
                resp, err := reportOnce(req)
                if err == nil {
                        w.memberMsg = resp
                        return
                }
                log.Printf("Membership report failed, retrying: %v", err)
                time.Sleep(*regRetry)
        }
}

func reportOnce(req *pb.MemberMsg) (*pb.MemberMsg, error) {
        ctx, cancel := context.WithTimeout(context.Background(), *regTimeout)
        defer cancel()

        conn, err := grpc.DialContext(ctx, validatorGrpcAddr, grpc.WithInsecure(), grpc.WithBlock())
        if err != nil {
                return nil, err
        }
        defer conn.Close()

        return pb.NewMembershipServiceClient(conn).GetMembership(ctx, req)
}

func createSelfMembership(id string, addr string, port string, nodeinfo *VRFNode) *pb.MemberMsg {

        node := &pb.Node{
                NodeID:    id,
                Addrs:     []string{addr},
                Port:      port,
                Publickey: nodeinfo.PubKey,
                Seed:      nodeinfo.Seed,
                Proof:     nodeinfo.Proof,
                Value:     nodeinfo.Value.Bytes(),
        }
        return &pb.MemberMsg{Nodes: []*pb.Node{node}}
}

func MerkleHash(s []uint64) string {
        return strconv.FormatUint(s[0], 16)     
}

func ReportExternal(id string) {
        conn, err := net.Dial("tcp", validatorNatAddr)
        if err != nil {
                fmt.Println("[NAT] Failed to dial:", err)
                return
        }
        defer conn.Close()

        sndBuf, err := json.Marshal(id)
        if err != nil {
                fmt.Println("[NAT] Failed to marshal ID:", err)
                return
        }

        if _, err := conn.Write(sndBuf); err != nil {
                fmt.Println("[NAT] Failed to write data:", err)
        }
}

func generateTLSConfig() *tls.Config {
        key, err := rsa.GenerateKey(rand.Reader, 1024)
        if err != nil {
                panic(fmt.Errorf("failed to generate RSA key: %w", err))
        }

        template := x509.Certificate{SerialNumber: big.NewInt(1)}
        certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
        if err != nil {
                panic(fmt.Errorf("failed to create certificate: %w", err))
        }

        keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
        certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

        tlsCert, err := tls.X509KeyPair(certPEM, keyPEM)
        if err != nil {
                panic(fmt.Errorf("failed to load TLS key pair: %w", err))
        }

        return &tls.Config{
                Certificates: []tls.Certificate{tlsCert},
                NextProtos:   []string{"quic-echo-example"},
        }
}

func idxToInt(s string) int {
        var num int
        fmt.Sscanf(s, "%d", &num)
        return num
}

// 정족수만큼 표가 모이면 그 표들만으로 서명을 집계한다. 서명자 목록도 실제로 표를 낸
// 노드들로 맞춘다. 집계 서명은 이 목록의 공개키로 검증되므로 둘이 어긋나면 안 된다.
func (w *CONSENSUSNODE) waitForVotes(ch chan vote, quorum int, targetPhase pb.AuditMsg_Phases) bool {
        var sigVec []bls.Sign
        var voters []*pb.HonestAuditor

        timeout := time.After(5 * time.Second)

        for {
                select {
                case v := <-ch:
                        msg := v.msg
                        if msg == nil {
                                log.Println("⚠️ received nil vote")
                                continue
                        }

                        if msg.PhaseNum == pb.AuditMsg_PHASE_UNSPECIFIED {
                                continue
                        }

                        if msg.PhaseNum != targetPhase {
                                log.Printf("❌ Unexpected phase: got=%v expected=%v", msg.PhaseNum, targetPhase)
                                continue
                        }

                        sig := bls.Sign{}
                        if err := sig.Deserialize(msg.Signature); err != nil {
                                log.Println("❌ Signature deserialize error:", err)
                                continue
                        }

                        // 잘못된 서명 하나가 집계 서명 전체를 무효로 만들지 않게 표마다 확인한다
                        pk := w.getPublicKeyByNodeID(v.nodeID)
                        if pk == nil || !sig.VerifyByte(pk, []byte(w.auditMsg.CurHash)) {
                                log.Printf("❌ Invalid vote signature from %s", v.nodeID)
                                continue
                        }

                        sigVec = append(sigVec, sig)
                        voters = append(voters, &pb.HonestAuditor{Id: v.nodeID})
                        fmt.Printf("🗳️ Votes: %d/%d\n", len(sigVec), quorum)

                        if len(sigVec) == quorum {
                                fmt.Printf("✅ Phase %v Aggregation Complete\n", targetPhase)
                                w.auditMsg.HonestAuditors = voters
                                w.Multisinging(msg, sigVec)
                                return true
                        }

                case <-timeout:
                        log.Printf(
                                "⏰ waitForVotes timeout: votes=%d quorum=%d targetPhase=%v",
                                len(sigVec), quorum, targetPhase,
                        )
                        return false
                }
        }
}

// ======================= Monitoring =======================
// func monitoring() {
//   counter := prometheus.NewCounter(prometheus.CounterOpts{Namespace: "WDN", Name: "counter_total"})
//   gauge := prometheus.NewGauge(prometheus.GaugeOpts{Namespace: "WDN", Name: "gauge_value"})
//   histogram := prometheus.NewHistogram(prometheus.HistogramOpts{
//           Namespace: "WDN", Name: "histogram_value", Buckets: prometheus.LinearBuckets(0, 5, 10),
//   })

//   prometheus.MustRegister(counter, gauge, histogram)

//   go func() {
//           for {
//                   counter.Add(rand.Float64() * 5)
//                   gauge.Add(rand.Float64()*15 - 5)
//                   histogram.Observe(rand.Float64() * 10)
//                   time.Sleep(2 * time.Second)
//           }
//   }()
//   fmt.Println(http.ListenAndServe(prometheusPort, nil))
// }