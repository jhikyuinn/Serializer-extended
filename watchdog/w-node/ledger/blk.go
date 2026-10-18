package __

import (
	pb "auditchain/msg"
	"bytes"
	"context"
	"encoding/gob"
	"fmt"
	"log"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const addrDB = "mongodb://127.0.0.1:27017"

func BlockHashCalculator(s *pb.AuditMsg) []byte {
	var b bytes.Buffer
	gob.NewEncoder(&b).Encode(s)
	return b.Bytes()
}

func BlkInsert(cMsg *pb.AuditMsg) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	clientOptions := options.Client().ApplyURI(addrDB)

	client, err := mongo.Connect(ctx, clientOptions)
	if err != nil {
		panic(err)
	}

	collection := client.Database("ledger").Collection("blk")
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res, err := collection.InsertOne(ctx, bson.D{
		{"PrevHash", cMsg.PrevHash},
		{"CurHash", cMsg.CurHash},
		{"LeaderID", cMsg.LeaderID},
		{"MerkleRootHash", cMsg.MerkleRootHash},
		{"Signature", cMsg.Signature},
		{"NumofAbortTransaction", cMsg.Aborttransactionnum},
		{"Committee", cMsg.HonestAuditors},
		{"AbortOffsetsFrom", offsetsToDoc(cMsg.AbortOffsetsFrom)},
		{"AbortOffsets", offsetsToDoc(cMsg.AbortOffsetsTo)},
	})
	if err != nil {
		fmt.Println(err)
		return
	} else {
		fmt.Println(res.InsertedID)
	}

	err = client.Disconnect(context.TODO())
	if err != nil {
		log.Fatal(err)
	}
}

// MongoDB 문서의 키는 문자열이어야 한다
func offsetsToDoc(offsets map[int32]int64) bson.M {
	doc := bson.M{}
	for partition, offset := range offsets {
		doc[strconv.Itoa(int(partition))] = offset
	}
	return doc
}

// LastAbortOffsets returns, per partition of the abort topic, the next offset
// that has not been recorded in the ledger yet. An empty map means nothing has
// been recorded.
func LastAbortOffsets() (map[int32]int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(addrDB))
	if err != nil {
		return nil, err
	}
	defer client.Disconnect(context.Background())

	var last struct {
		AbortOffsets map[string]int64 `bson:"AbortOffsets"`
	}
	opts := options.FindOne().SetSort(bson.D{{Key: "_id", Value: -1}})
	err = client.Database("ledger").Collection("blk").FindOne(ctx, bson.D{}, opts).Decode(&last)
	if err == mongo.ErrNoDocuments {
		return map[int32]int64{}, nil
	}
	if err != nil {
		return nil, err
	}

	offsets := make(map[int32]int64, len(last.AbortOffsets))
	for partition, offset := range last.AbortOffsets {
		p, err := strconv.Atoi(partition)
		if err != nil {
			continue
		}
		offsets[int32(p)] = offset
	}
	return offsets, nil
}
