// Package txmeta extracts, from an endorsed transaction envelope, what the Serializer
// processor needs to order a batch: read keys (with versions), write keys, the invoking
// user, the urgency flag, the transaction ID and the chaincode arguments.
//
// 오더러가 envelope 전체(배치 100건에 약 520 KB) 대신 이것만 Kafka 로 보낸다(Serializer NOTES §45~§46).
// 규칙은 프로세서의 readTxMeta(kafka/processor/processor.go)와 같다. 둘을 함께 고쳐야 한다.
package txmeta

import (
	"encoding/json"
	"strings"

	"github.com/golang/protobuf/proto"
	"github.com/hyperledger/fabric-protos-go/common"
	"github.com/hyperledger/fabric-protos-go/ledger/rwset"
	kvrwset "github.com/hyperledger/fabric-protos-go/ledger/rwset/kvrwset" // 로컬 수정본의 패키지 이름이 __ 다
	"github.com/hyperledger/fabric/protoutil"
)

// 체인코드가 읽기 집합에 남기는 사용자·긴급 표시 (논문 Figure 7, zipfbench smallbank 체인코드)
const (
	userInfoPrefix = "info_"
	urgentFlagKey  = "flag_urgent"
)

// Version is the version a transaction read a key at. Exists is false when the key did not exist yet.
type Version struct {
	Exists bool   `json:"e,omitempty"`
	Block  uint64 `json:"b,omitempty"`
	Tx     uint64 `json:"t,omitempty"`
}

// TxMeta is one transaction's ordering metadata. JSON 이름은 프로세서의 TxMeta 와 같다.
type TxMeta struct {
	Index    int       `json:"i"`
	User     string    `json:"u,omitempty"`
	Reads    []string  `json:"r,omitempty"`
	ReadVers []Version `json:"rv,omitempty"`
	Writes   []string  `json:"w,omitempty"`
	Urgency  bool      `json:"g,omitempty"`
	TxID     string    `json:"id,omitempty"`
	Args     []string  `json:"a,omitempty"`
}

// Extract returns the metadata of env. 풀 수 없는 부분은 비워 둔다(프로세서가 그렇게 해 왔다).
func Extract(index int, env *common.Envelope) TxMeta {
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
		cap, err := protoutil.UnmarshalChaincodeActionPayload(action.Payload)
		if err != nil || cap.Action == nil {
			continue
		}
		if meta.Args == nil {
			if cpp, err := protoutil.UnmarshalChaincodeProposalPayload(cap.ChaincodeProposalPayload); err == nil {
				if cis, err := protoutil.UnmarshalChaincodeInvocationSpec(cpp.Input); err == nil &&
					cis.ChaincodeSpec != nil && cis.ChaincodeSpec.Input != nil {
					for _, a := range cis.ChaincodeSpec.Input.Args {
						meta.Args = append(meta.Args, string(a))
					}
				}
			}
		}
		prp, err := protoutil.UnmarshalProposalResponsePayload(cap.Action.ProposalResponsePayload)
		if err != nil {
			continue
		}
		ca, err := protoutil.UnmarshalChaincodeAction(prp.Extension)
		if err != nil {
			continue
		}
		txRWSet := &rwset.TxReadWriteSet{}
		if err := proto.Unmarshal(ca.Results, txRWSet); err != nil {
			continue
		}

		for _, ns := range txRWSet.NsRwset {
			kv := &kvrwset.KVRWSet{}
			if err := proto.Unmarshal(ns.Rwset, kv); err != nil {
				continue
			}
			// 사용자는 체인코드가 처음 건드린 키로 본다. 체인코드 정의(_lifecycle)의 키는 사용자가 아니다.
			// 체인코드가 info_<사용자> 를 읽었으면 그 사용자다.
			system := ns.Namespace == "_lifecycle"

			for _, r := range kv.Reads {
				if r.Key == "namespaces/fields/basic/Sequence" {
					continue
				}
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
				meta.Reads = append(meta.Reads, ns.Namespace+"/"+r.Key)
				var ver Version
				if v := r.GetVersion(); v != nil {
					ver = Version{Exists: true, Block: v.BlockNum, Tx: v.TxNum}
				}
				meta.ReadVers = append(meta.ReadVers, ver)
			}

			for _, w := range kv.Writes {
				if meta.User == "" && !system {
					meta.User = w.Key
				}
				meta.Writes = append(meta.Writes, ns.Namespace+"/"+w.Key)

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
