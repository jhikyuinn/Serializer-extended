package __

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"path"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"

	pubsub "github.com/libp2p/go-libp2p-pubsub"
	"github.com/multiformats/go-multiaddr"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"github.com/google/uuid"
)

var brokers = ""

var kafkaPro *kafka.Producer
var kafkaCon *kafka.Consumer

type WatchdogPubsub struct {
	ctx   context.Context
	topic *pubsub.Topic
	ps    *pubsub.PubSub
	h     host.Host
}

type Channels struct {
	ID []string `json:"id"`
}

type WTopics struct {
	Topics []WatchdogTopic
}

type WatchdogTopic struct {
	ID    string
	Topic *pubsub.Topic
}

// discoveryNotifee gets notified when we find a new peer via mDNS discovery
type discoveryNotifee struct {
	h host.Host
}

var Wctx context.Context
var Wtopic *pubsub.Topic

var WatchdogTopics WTopics

var JoinedChannels Channels

// CommitteeTopic carries committee information to every w-node.
const CommitteeTopic = "watchdog/group/w-node"

const channelTopicPrefix = "watchdog/"

// keyTopic holds the libp2p private key shared by every s-node pod.
const keyTopic = "snode-keys"

var (
	selfID  peer.ID
	current *WatchdogPubsub
	ready   atomic.Bool

	// Loaded once at startup so that a standby pod can take over quickly.
	hostKey crypto.PrivKey

	// topicsMu guards WatchdogTopics and JoinedChannels.
	topicsMu sync.RWMutex
)

// SetBrokers overrides the broker list derived from the processor address.
func SetBrokers(b string) { brokers = b }

func Ready() bool { return ready.Load() }

// readySince is when this s-node opened its network (became the active one).
var readySince atomic.Int64

// SinceReady is how long this s-node has been reachable by w-nodes; 0 while it is not.
func SinceReady() time.Duration {
	if !ready.Load() {
		return 0
	}
	return time.Duration(time.Now().UnixNano() - readySince.Load())
}

func PeerID() string { return selfID.String() }

func PeerCount() int {
	if !ready.Load() {
		return 0
	}
	return len(current.h.Network().Peers())
}

// ChannelIDs returns the Fabric channels this replica has opened a topic for.
func ChannelIDs() []string {
	topicsMu.RLock()
	defer topicsMu.RUnlock()
	ids := make([]string, 0, len(WatchdogTopics.Topics))
	for _, t := range WatchdogTopics.Topics {
		ids = append(ids, t.ID)
	}
	return ids
}

// EnsureKeyTopic makes sure the key topic exists and never expires. If the
// broker's default retention deleted the key, a restarted pod would generate a
// new one and come up with a peer ID the w-nodes do not know.
func EnsureKeyTopic(replication int) error {
	a, err := kafka.NewAdminClient(&kafka.ConfigMap{"bootstrap.servers": brokers})
	if err != nil {
		return err
	}
	defer a.Close()

	keep := map[string]string{"retention.ms": "-1", "retention.bytes": "-1"}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	created, err := a.CreateTopics(ctx, []kafka.TopicSpecification{
		{Topic: keyTopic, NumPartitions: 1, ReplicationFactor: replication, Config: keep},
	}, kafka.SetAdminOperationTimeout(20*time.Second))
	if err != nil {
		return err
	}
	for _, r := range created {
		if code := r.Error.Code(); code != kafka.ErrNoError && code != kafka.ErrTopicAlreadyExists {
			return fmt.Errorf("create topic %s: %v", r.Topic, r.Error)
		}
	}

	// The topic may predate this code with the default retention.
	altered, err := a.AlterConfigs(ctx, []kafka.ConfigResource{{
		Type:   kafka.ResourceTopic,
		Name:   keyTopic,
		Config: kafka.StringMapToConfigEntries(keep, kafka.AlterOperationSet),
	}})
	if err != nil {
		return err
	}
	for _, r := range altered {
		if r.Error.Code() != kafka.ErrNoError {
			return fmt.Errorf("set retention on %s: %v", r.Name, r.Error)
		}
	}
	return nil
}

// PreloadKey fetches the shared identity before this pod becomes active.
func PreloadKey(kafkaprocessorAddr string) error {
	key, err := LoadOrCreateKey(kafkaprocessorAddr)
	if err != nil {
		return err
	}
	hostKey = key
	return nil
}

func handleStream(s network.Stream) {
	// Create a buffer stream for non-blocking read and write.
	rw := bufio.NewReadWriter(bufio.NewReader(s), bufio.NewWriter(s))

	go readData(rw)
	go writeData(rw)

	// stream 's' will stay open until you close it (or the other side closes it).
}

func readData(rw *bufio.ReadWriter) {
	for {
		str, _ := rw.ReadString('\n')
		if str == "" {
			return
		}
		if str != "\n" {
			fmt.Printf("\x1b[32m%s\x1b[0m> ", str)
		}

	}
}

func writeData(rw *bufio.ReadWriter) {
	stdReader := bufio.NewReader(os.Stdin)

	for {
		fmt.Print("> ")
		sendData, err := stdReader.ReadString('\n')
		if err != nil {
			log.Println(err)
			return
		}

		rw.WriteString(fmt.Sprintf("%s\n", sendData))
		rw.Flush()
	}
}

var certPath string

func init() {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		panic("Failed to get current frame")
	}

	certPath = path.Dir(filename)
}

// AddRootCA adds the root CA certificate to a cert pool
func AddRootCA(certPool *x509.CertPool) {
	// caCertPath := path.Join("./src/ca.pem")
	caCertPath := path.Join(certPath, "../testdata/ca.pem")
	caCertRaw, err := os.ReadFile(caCertPath)
	if err != nil {
		panic(err)
	}
	if ok := certPool.AppendCertsFromPEM(caCertRaw); !ok {
		panic("Could not add root ceritificate to pool.")
	}
}

func (wp *WatchdogPubsub) Start(processorIP *string) {

	wp.ctx = context.Background()

	r := rand.Reader

	h, err := makeHost(*processorIP, 4001, r)
	if err != nil {
		wp.ctx.Done()
		panic(err)
	}
	wp.h = h
	selfID = h.ID()
	current = wp
	fmt.Printf("Peer ID: %s\n", wp.h.ID())

	wp.startPeer(handleStream)

	// create a new PubSub service using the GossipSub router
	// ps, err := pubsub.NewGossipSub(wp.ctx, h)
	wp.ps, err = pubsub.NewGossipSub(wp.ctx, h)
	if err != nil {
		wp.ctx.Done()
		panic(err)
	}

	// setup local mDNS discovery
	if err := setupDiscovery(wp.h); err != nil {
		wp.ctx.Done()
		panic(err)
	}

	// watchdog/group/w-node topic publishes committee information
	// which committee for the channel, and who is the leader node
	wp.topic, err = joinNetwork(wp.ctx, wp.ps, CommitteeTopic)
	if err != nil {
		wp.ctx.Done()
		panic(err)
	}

	Wtopic = wp.topic
	Wctx = wp.ctx
	readySince.Store(time.Now().UnixNano())
	ready.Store(true)

	// setting TLS for QUIC
	pool, err := x509.SystemCertPool()
	if err != nil {
		log.Fatal(err)
	}
	AddRootCA(pool)

	var qconf quic.Config
	roundTripper := &http3.RoundTripper{
		TLSClientConfig: &tls.Config{
			RootCAs:            pool,
			InsecureSkipVerify: true,
		},
		QuicConfig: &qconf,
	}

	defer roundTripper.Close()
	hclient := &http.Client{
		Transport: roundTripper,
	}

	body := &bytes.Buffer{}
	for {
		processorAddr := "https://" + *processorIP + ":8082/fabric/channels"

		var resp *http.Response
		var err error

		// 시도 1: QUIC (HTTP/3)
		resp, err = hclient.Get(processorAddr)
		if err != nil {
			fmt.Println("QUIC HTTP/3 GET error:", err)

			// 시도 2: fallback to HTTP/1.1
			fallbackClient := &http.Client{Timeout: 2 * time.Second}
			fallbackAddr := "http://" + *processorIP + ":8082/fabric/channels"
			resp, err = fallbackClient.Get(fallbackAddr)
			if err != nil {
				fmt.Println("HTTP/1.1 fallback failed:", err)
				time.Sleep(10 * time.Second)
				continue
			}
		}

		body = &bytes.Buffer{}
		_, err = io.Copy(body, resp.Body)
		resp.Body.Close()
		if err != nil {
			log.Fatal(err)
		}

		var newChannels Channels
		b, _ := ioutil.ReadAll(body)
		err = json.Unmarshal(b, &newChannels)
		if err != nil {
			fmt.Println("Unmarshal error:", err)
		}
		wp.openPubsubNetwork(&newChannels)

		time.Sleep(10 * time.Second)
	}
}

// openPubsubNetwork opens new pubsub network channel if
// there is no opened network
func (wp *WatchdogPubsub) openPubsubNetwork(newChannels *Channels) {
	for _, nc := range newChannels.ID {
		if !existChannel(nc) {
			fmt.Println("Opening network:", nc)
			newTopic, err := joinNetwork(wp.ctx, wp.ps, channelTopicPrefix+nc)
			if err != nil {
				fmt.Println("Joining network error:", err)
				continue
			}

			new := &WatchdogTopic{
				ID:    nc,
				Topic: newTopic,
			}

			topicsMu.Lock()
			JoinedChannels.ID = append(JoinedChannels.ID, nc)
			WatchdogTopics.Topics = append(WatchdogTopics.Topics, *new)
			topicsMu.Unlock()
		}
	}
}

func existChannel(channel string) bool {
	topicsMu.RLock()
	defer topicsMu.RUnlock()
	for _, jc := range JoinedChannels.ID {
		if jc == channel {
			return true
		}
	}
	return false
}

func KafkaCon() *kafka.Consumer {

	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers": brokers,
		"group.id":          "myGroup" + uuid.NewString(),
		"auto.offset.reset": "earliest",
	})

	if err != nil {
		// When a connection error occurs, a panic occurs and the system is shut down
		panic(err)
	}

	return c
}

func KafkaPro() *kafka.Producer {

	p, _ := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": brokers,
		"acks":              "all",
		"message.max.bytes": 104857600,
	})

	return p
}

func LoadOrCreateKey(kafkaprocessorAddr string) (crypto.PrivKey, error) {

	if brokers == "" {
		brokers = kafkaprocessorAddr + ":9091, " + kafkaprocessorAddr + ":9092, " + kafkaprocessorAddr + ":9093"
	}
	// 이거 토픽도 없으면 만들도록 해야하는데..!!
	topic := keyTopic
	// 하드 코딩 말고 채널이름 받도록 하고싶음.
	channel := "mychannel"

	privKey, err := GetOrCreateSnodePrivateKey(brokers, topic, channel)
	if err != nil {
		panic(err)
	}

	return privKey, nil
}

func GetOrCreateSnodePrivateKey(brokerAddr, topic, channel string) (crypto.PrivKey, error) {
	privKey, err := getSnodePrivateKeyFromKafka(brokerAddr, topic, channel)
	if err != nil {
		return nil, err
	}

	if privKey != nil {
		fmt.Println("Private key loaded from Kafka for channel:", channel)
		return privKey, nil
	}

	privKey, _, err = crypto.GenerateKeyPair(crypto.RSA, 2048)
	if err != nil {
		return nil, err
	}

	err = saveSnodePrivateKeyToKafka(brokerAddr, topic, channel, privKey)
	if err != nil {
		return nil, err
	}
	fmt.Println("New private key generated and saved to Kafka for channel:", channel)

	// Replicas starting together may each have written a key. The first record
	// in the topic wins, so that all of them end up with the same peer ID.
	if first, err := getSnodePrivateKeyFromKafka(brokerAddr, topic, channel); err == nil && first != nil {
		return first, nil
	}
	return privKey, nil
}

func getSnodePrivateKeyFromKafka(brokerAddr, topic, channel string) (crypto.PrivKey, error) {
	c := KafkaCon()
	defer c.Close()

	err := c.SubscribeTopics([]string{topic}, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to subscribe to topic: %w", err)
	}

	timeout := time.After(5 * time.Second)
	for {
		select {
		case <-timeout:
			return nil, nil
		default:
			msg, err := c.ReadMessage(100 * time.Millisecond)
			if err != nil {
				continue
			}
			if string(msg.Key) == channel {

				privKey, err := crypto.UnmarshalPrivateKey(msg.Value)
				if err != nil {
					return nil, fmt.Errorf("failed to unmarshal private key: %w", err)
				}
				return privKey, nil
			}
		}
	}
}

func saveSnodePrivateKeyToKafka(brokerAddr, topic, channel string, privKey crypto.PrivKey) error {

	keyBytes, err := crypto.MarshalPrivateKey(privKey)
	if err != nil {
		return err
	}

	producer, err := kafka.NewProducer(&kafka.ConfigMap{"bootstrap.servers": brokerAddr})
	if err != nil {
		return err
	}
	defer producer.Close()

	msg := &kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny},
		Key:            []byte(channel),
		Value:          keyBytes,
	}

	deliveryChan := make(chan kafka.Event)

	err = producer.Produce(msg, deliveryChan)
	if err != nil {
		return fmt.Errorf("failed to produce message: %w", err)
	}

	e := <-deliveryChan
	m := e.(*kafka.Message)
	close(deliveryChan)

	if m.TopicPartition.Error != nil {
		return fmt.Errorf("delivery failed: %w", m.TopicPartition.Error)
	}

	fmt.Printf("Message delivered to topic %s [partition %d] at offset %v with key '%s'\n",
		*m.TopicPartition.Topic, m.TopicPartition.Partition, m.TopicPartition.Offset, string(m.Key))

	return nil
}

func makeHost(kafkaIp string, port int, randomness io.Reader) (host.Host, error) {
	// (default)Creates a new RSA key pair for this host.
	// prvKey, _, err := crypto.GenerateKeyPairWithReader(crypto.RSA, 2048, randomness)
	// if err != nil {
	// 	log.Println(err)
	// 	return nil, err
	// }

	// multiple stateless snode
	prvKey := hostKey
	if prvKey == nil {
		var err error
		prvKey, err = LoadOrCreateKey(kafkaIp)
		if err != nil {
			return nil, err
		}
	}

	// 0.0.0.0 will listen on any interface device.
	sourceMultiAddr, _ := multiaddr.NewMultiaddr(fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", port))

	// libp2p.New constructs a new libp2p Host.
	// Other options can be added here.
	return libp2p.New(
		libp2p.ListenAddrs(sourceMultiAddr),
		libp2p.Identity(prvKey),
	)
}

func (wp *WatchdogPubsub) startPeer(streamHandler network.StreamHandler) {
	// Set a function as stream handler.
	// This function is called when a peer connects, and starts a stream with this protocol.
	// Only applies on the receiving side.
	wp.h.SetStreamHandler("/chat/1.0.0", streamHandler)

	// Let's get the actual TCP port from our listen multiaddr, in case we're using 0 (default; random available port).
	var port string
	for _, la := range wp.h.Network().ListenAddresses() {
		if p, err := la.ValueForProtocol(multiaddr.P_TCP); err == nil {
			port = p
			break
		}
	}

	if port == "" {
		log.Println("was not able to find actual local port")
		return
	}

	log.Println("Waiting for incoming connection")
	log.Println()
}

// TopicPeerCount is the number of peers (w-nodes) currently on the s-node's pubsub topic.
// 커미티를 일찍 만들 때 "연결된 w-node 가 모두 등록했는가"를 보는 데 쓴다.
func TopicPeerCount() int {
	if Wtopic == nil {
		return 0
	}
	return len(Wtopic.ListPeers())
}
