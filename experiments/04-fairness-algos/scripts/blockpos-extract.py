#!/usr/bin/env python3
# §85 블록 파일(peer channel fetch 결과, protobuf) 을 stdin 으로 받아 tx 마다 한 줄:
#   block,pos,n,fn,user,urgent,valid(0/1),client_ts_ms
# 이 Fabric 은 kvrwset 패키지가 바뀌어 configtxlator 로 블록 전체를 풀 수 없다. 필요한 필드만 wire format 으로 읽는다.
#   Block{header=1{number=1}, data=2{data=1*}, metadata=3{metadata=1*}}  metadata[2] = TRANSACTIONS_FILTER
#   Envelope{payload=1} Payload{header=1{channel_header=1}, data=2}  ChannelHeader{type=1, timestamp=3{seconds=1,nanos=2}}
#   Transaction{actions=1*} TransactionAction{payload=2} ChaincodeActionPayload{chaincode_proposal_payload=1}
#   ChaincodeProposalPayload{input=1} ChaincodeInvocationSpec{chaincode_spec=1} ChaincodeSpec{input=3} ChaincodeInput{args=1*}
import sys


def varint(b, i):
    x = s = 0
    while True:
        c = b[i]
        i += 1
        x |= (c & 0x7f) << s
        s += 7
        if c < 0x80:
            return x, i


def fields(b):
    i, out = 0, []
    while i < len(b):
        k, i = varint(b, i)
        f, t = k >> 3, k & 7
        if t == 0:
            v, i = varint(b, i)
        elif t == 2:
            n, i = varint(b, i)
            v = b[i:i + n]
            i += n
        elif t == 1:
            v = b[i:i + 8]
            i += 8
        elif t == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError('wire type %d' % t)
        out.append((f, v))
    return out


def one(b, f, default=b''):
    for k, v in fields(b):
        if k == f:
            return v
    return default


def many(b, f):
    return [v for k, v in fields(b) if k == f]


blk = sys.stdin.buffer.read()
num = one(one(blk, 1), 1, 0)
envs = many(one(blk, 2), 1)
mds = many(one(blk, 3), 1)
flags = mds[2] if len(mds) > 2 else b''
for i, env in enumerate(envs):
    try:
        pl = one(env, 1)
        ch = one(one(pl, 1), 1)
        if one(ch, 1, 0) != 3:  # ENDORSER_TRANSACTION
            continue
        ts = one(ch, 3)
        ms = one(ts, 1, 0) * 1000 + one(ts, 2, 0) // 1000000 if ts else ''
        act = many(one(pl, 2), 1)[0]
        spec = one(one(one(one(act, 2), 1), 1), 1)
        args = [a.decode('utf-8', 'replace') for a in many(one(spec, 3), 1)]
        valid = 1 if i < len(flags) and flags[i] == 0 else 0
        print(f"{num},{i},{len(envs)},{args[0]},{args[1] if len(args) > 1 else ''},{args[2] if len(args) > 2 else ''},{valid},{ms}")
    except Exception:
        continue
