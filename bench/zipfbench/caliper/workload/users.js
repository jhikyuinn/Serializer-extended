'use strict';

const fs = require('fs');
const path = require('path');
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { buildCdf, sample, mulberry32 } = require('./zipf.js');

// Serializer 논문(IEEE Access) III.B절 Figure 16·Table I 실험의 워크로드.
// 워커 하나가 사용자 한 명이다. 사용자마다 네트워크 지연이 다르고, VIP 사용자는 긴급 트랜잭션을 보낸다.
//
// 트랜잭션은 smallbank 체인코드 6종이다. prw 확률로 쓰기 5종(TransactSavings, DepositChecking,
// SendPayment, WriteCheck, Amalgamate) 중 하나를 고르고, 나머지는 Query 다. Query 도 블록에 들어가도록
// 제출한다(오더링을 거쳐야 Serializer 의 "읽기 전용 = 높은 우선순위"가 의미가 있다).
// 계좌는 Zipf(s) 로 고른다. 두 계좌를 쓰는 것은 서로 다른 둘을 고른다.
//
// roundArguments
//   users         사용자 이름 목록. 워커 수와 같아야 한다             기본 User1..User5
//   latenciesMs   사용자별 네트워크 지연(ms). 보내기 전에 이만큼 기다린다 기본 [4.5, 50, 50, 50, 100]
//   urgentUser    긴급 트랜잭션을 보내는 VIP 사용자                     기본 User3
//   urgentRatio   그 사용자의 쓰기 트랜잭션 중 긴급으로 보내는 비율 (0~1) 기본 0
//   accountCount  계좌 수 (체인코드 init 과 같아야 한다)                기본 100
//   zipfS         계좌 선택의 Zipf 지수                                 기본 1.15
//   prw           쓰기 트랜잭션 비율                                    기본 0.5
//   amount        옮기는 양                                             기본 1
//   seed          난수 씨앗. 워커마다 seed + workerIndex                기본 12345
//   timeoutSec    Caliper 커밋 대기 시간. 이보다 0.5초 이상 짧게 끝난 실패만 '빠른 실패'로 센다 기본 10
//   outDir        사용자별 집계 파일을 쓸 곳                            기본 /out
//   mode          smallbank | custom                                     기본 smallbank
//
// custom 모드 (보조 부하, Fabric++ 논문 6.2.2절의 custom 워크로드)
//   모든 트랜잭션이 Custom 하나다. 키 itemCount 개 중 앞 hotShare 비율이 인기 키다. 키 rw 개를 읽고
//   (각각 확률 hr 로 인기 키), 따로 고른 키 rw 개에 쓴다(각각 확률 hw 로 인기 키). 읽는 키와 쓰는 키가
//   다르므로 순서를 바꾸면 살릴 수 있는 충돌이 많다. VIP 의 긴급 비율(urgentRatio)은 smallbank 와 같다.
//   itemCount 10000, rw 4, hr 0.2, hw 0.1, hotShare 0.01 이 기본이다 (Fabric++ 논문 Table 7 의 범위).
//   queryShare    custom 에서 읽기 전용 tx 비율. 키 rw 개를 읽기만 한다(인기 키 확률 hr)  기본 0
//   abortNotify   프로세서의 abort 토픽을 읽어 버려진 트랜잭션을 바로 실패로 끝낼지 기본 true
//   kafkaBrokers  abort 토픽을 읽을 Kafka 브로커                        기본 host.docker.internal:9091~9093
//   abortTopic    abort 토픽                                            기본 mychannel-abort
//
// abort 통보 (Serializer 논문 II.A절: 클라이언트가 abort 파티션을 읽어 바로 abort 한다)
//   트랜잭션마다 요청 ID(<사용자>-<라운드>-<순번>)를 세 번째 인자로 붙인다. 프로세서는 버린 트랜잭션의
//   호출 인자를 abort 기록에 함께 보내므로, 워커는 그 토픽에서 자기 요청 ID 를 보면 커밋 이벤트를
//   기다리지 않고 그 트랜잭션을 실패로 끝낸다(사용자가 실패를 아는 시각). Caliper 자신은 여전히 커밋
//   대기 시간까지 기다린 뒤 실패로 세므로, Caliper 보고서의 처리량·지연은 이 통보를 반영하지 않는다.
//
// 끝나면 outDir/user-<사용자>-w<워커>.json 에 성공·실패를 남긴다(집계 스크립트가 사용자별로 합친다). 실패는 셋으로 나눈다.
//   failNotified  abort 토픽으로 통보받음 (프로세서가 버림)
//   failFast      커밋 대기 시간보다 빨리 실패 = 피어가 무효 처리 (MVCC 등)
//   failSlow      커밋 대기 시간까지 기다린 실패 = 블록에 들어가지 않았는데 통보도 못 받음
// Caliper 의 TxStatus 에는 실패 사유가 없어 failFast 와 failSlow 는 걸린 시간으로 나눈다.

const WRITE_OPS = ['TransactSavings', 'DepositChecking', 'SendPayment', 'WriteCheck', 'Amalgamate'];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function newTally() {
    return {
        total: 0, success: 0, failNotified: 0, failFast: 0, failSlow: 0,
        latencySuccessSum: 0, latencyNotifiedSum: 0, latencyFastSum: 0, latencySlowSum: 0, latencyFailSum: 0
    };
}

class UsersWorkload extends WorkloadModuleBase {
    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
        const a = roundArguments;
        const users = a.users || ['User1', 'User2', 'User3', 'User4', 'User5'];
        const latencies = a.latenciesMs || [4.5, 50, 50, 50, 100];
        // 워커 수는 사용자 수의 배수여야 한다. 워커 i 는 사용자 users[i % 사용자 수] 를 맡는다
        // (사용자 하나를 워커 여럿이 나눠 보낸다. 클라이언트가 병목일 때 부하를 더 내기 위해서다).
        if (totalWorkers % users.length !== 0) {
            throw new Error(`워커 수(${totalWorkers}) 는 사용자 수(${users.length}) 의 배수여야 한다`);
        }
        this.workerIndex = workerIndex;
        this.user = users[workerIndex % users.length];
        this.latencyMs = Number(latencies[workerIndex % users.length] || 0);
        this.urgentRatio = this.user === (a.urgentUser || 'User3') ? Number(a.urgentRatio || 0) : 0;
        this.accountCount = Number(a.accountCount || 100);
        this.prw = a.prw === undefined ? 0.5 : Number(a.prw);
        this.amount = String(a.amount || 1);
        this.contractId = a.contractId || 'smallbank';
        this.slowMs = (Number(a.timeoutSec || 10) - 0.5) * 1000;
        this.outDir = a.outDir || '/out';
        installFastTxListener();
        // WORKLOAD_CPU_PROF=1 이면 이 워커의 CPU 프로파일을 outDir/prof 에 남긴다 (§68). --cpu-prof 는 NODE_OPTIONS 로 줄 수 없다
        if (process.env.WORKLOAD_CPU_PROF === '1') {
            this.profSession = new (require('inspector').Session)();
            this.profSession.connect();
            this.profSession.post('Profiler.enable', () => this.profSession.post('Profiler.start'));
            // SDK 이벤트 처리 횟수도 센다: 블록의 tx 마다 불리는 _callTransactionListener 와 그때 훑는 리스너 수
            try {
                const fc = require(require.resolve('fabric-common', { paths: ['/home/node/.npm-global/lib/node_modules/fabric-network'] }));
                const proto = fc.EventService.prototype, orig = proto._callTransactionListener;
                const st = this.sdkStats = { calls: 0, regsScanned: 0, maxRegs: 0, services: new Set() };
                proto._callTransactionListener = function (...args) {
                    const n = this._eventListenerRegistrations.size;
                    st.calls++; st.regsScanned += n; if (n > st.maxRegs) st.maxRegs = n; st.services.add(this.myNumber + '/' + this.name);
                    return orig.apply(this, args);
                };
            } catch (e) { console.error(`SDK 계측 실패: ${e.message}`); }
        }
        // userZipfS: 사용자별 Zipf s 를 따로 줄 수 있다(§86, 예: {"User2": 2.5} 이면 User2 만 인기 계좌에 몰린다)
        const userS = a.userZipfS && a.userZipfS[this.user] !== undefined ? Number(a.userZipfS[this.user]) : undefined;
        this.zipfS = userS !== undefined ? userS : (a.zipfS === undefined ? 1.15 : Number(a.zipfS));
        this.cdf = buildCdf(this.accountCount, this.zipfS);
        this.mode = a.mode || 'smallbank';
        this.itemCount = Number(a.itemCount || 10000);
        this.rw = Number(a.rw || 4);
        this.hr = a.hr === undefined ? 0.2 : Number(a.hr);
        this.hw = a.hw === undefined ? 0.1 : Number(a.hw);
        this.queryShare = Number(a.queryShare || 0);
        this.hotCount = Math.max(1, Math.round(this.itemCount * (a.hotShare === undefined ? 0.01 : Number(a.hotShare))));
        this.rand = mulberry32(Number(a.seed || 12345) + workerIndex);
        this.tally = { all: newTally(), urgent: newTally(), normalWrite: newTally(), query: newTally() };
        // 처음 warmupSec 초에 보낸 트랜잭션을 뺀 집계(tallySteady)와 초 단위 시계열(series). 초는 이 워커가 처음 보낸 때부터 센다
        this.warmupSec = Number(a.warmupSec || 0);
        this.tallySteady = { all: newTally(), urgent: newTally(), normalWrite: newTally(), query: newTally() };
        this.series = {};
        this.t0 = null;
        this.ops = {};
        this.roundIndex = roundIndex;
        this.seq = 0;
        this.pending = new Map(); // 요청 ID → abort 통보를 받으면 부를 함수
        this.abortNotify = a.abortNotify === undefined ? true : (a.abortNotify === true || a.abortNotify === 'true');
        if (this.abortNotify) {
            await this.startAbortListener(a.kafkaBrokers || ['host.docker.internal:9091', 'host.docker.internal:9092', 'host.docker.internal:9093'],
                a.abortTopic || 'mychannel-abort');
        }
    }

    // abort 토픽을 끝에서부터 읽는다. 그룹에 들어간 뒤에 라운드를 시작해야 앞부분 통보를 놓치지 않는다.
    async startAbortListener(brokers, topic) {
        const { Kafka, logLevel, CompressionTypes, CompressionCodecs } = require('kafkajs');
        // 프로세서(goka/sarama)는 Snappy 로 압축해 보낸다
        CompressionCodecs[CompressionTypes.Snappy] = require('kafkajs-snappy');
        const kafka = new Kafka({ clientId: `userbench-${this.user}`, brokers, logLevel: logLevel.WARN });
        this.consumer = kafka.consumer({ groupId: `userbench-${this.user}-${Date.now()}` });
        await this.consumer.connect();
        await this.consumer.subscribe({ topic, fromBeginning: false });
        const joined = new Promise((resolve) => this.consumer.on(this.consumer.events.GROUP_JOIN, resolve));
        await this.consumer.run({
            eachMessage: async ({ message }) => {
                if (!this.pending.size || !message.value) {
                    return;
                }
                let rec;
                try {
                    rec = JSON.parse(message.value.toString());
                } catch (e) {
                    return;
                }
                for (const t of rec.aborted || []) {
                    for (const arg of t.args || []) {
                        const done = this.pending.get(arg);
                        if (done) {
                            done();
                        }
                    }
                }
            }
        });
        await Promise.race([joined, sleep(30000)]);
    }

    account() {
        return String(sample(this.cdf, this.rand()));
    }

    twoAccounts() {
        const a = this.account();
        let b = this.account();
        while (b === a) {
            b = this.account();
        }
        return [a, b];
    }

    // custom 모드: 서로 다른 키 n 개. 각각 확률 pHot 으로 인기 키, 아니면 나머지에서 균등
    items(n, pHot) {
        const keys = new Set();
        while (keys.size < n) {
            const hot = this.rand() < pHot;
            const i = hot ? Math.floor(this.rand() * this.hotCount)
                : this.hotCount + Math.floor(this.rand() * (this.itemCount - this.hotCount));
            keys.add(`item_${i}`);
        }
        return [...keys];
    }

    nextTx() {
        if (this.mode === 'custom') {
            const reads = this.items(this.rw, this.hr);
            if (this.rand() < this.queryShare) { // 읽기 전용: 쓰기 없는 Custom
                return { fn: 'Custom', args: [String(reads.length), ...reads], urgent: false, query: true };
            }
            const writes = this.items(this.rw, this.hw);
            const urgent = this.rand() < this.urgentRatio;
            return { fn: 'Custom', args: [String(reads.length), ...reads, ...writes], urgent };
        }
        if (this.rand() >= this.prw) {
            return { fn: 'Query', args: [this.account()], urgent: false };
        }
        const fn = WRITE_OPS[Math.floor(this.rand() * WRITE_OPS.length)];
        const urgent = this.rand() < this.urgentRatio;
        let args;
        switch (fn) {
        case 'SendPayment': {
            const [a, b] = this.twoAccounts();
            args = [a, b, this.amount];
            break;
        }
        case 'Amalgamate':
            args = this.twoAccounts();
            break;
        default:
            args = [this.account(), this.amount];
        }
        return { fn, args, urgent };
    }

    // outcome: 'success' | 'notified' | 'failed' (failed 는 걸린 시간으로 빠른/느린 실패를 나눈다)
    record(kind, outcome, ms, sentAt) {
        const sec = this.t0 === null || sentAt === undefined ? 0 : Math.floor((sentAt - this.t0) / 1000);
        // tx 별 기록(§84, 연속 abort 를 세려고): [보낸 시각(ms, t0 기준), 종류 q/u/n, 결과 s/a(통보)/f(피어 무효)/t(시간 초과), 지연 ms]
        (this.txlog || (this.txlog = [])).push([sentAt === undefined || this.t0 === null ? 0 : sentAt - this.t0, kind[0],
            outcome === 'success' ? 's' : outcome === 'notified' ? 'a' : ms >= this.slowMs ? 't' : 'f', Math.round(ms)]);
        const p = this.series[sec] || (this.series[sec] = { sent: 0, success: 0, failNotified: 0, failFast: 0, failSlow: 0, latencySuccessSum: 0 });
        p.sent++;
        if (outcome === 'success') { p.success++; p.latencySuccessSum += ms; }
        else if (outcome === 'notified') p.failNotified++;
        else if (ms >= this.slowMs) p.failSlow++;
        else p.failFast++;
        const targets = [this.tally.all, this.tally[kind]];
        if (sec >= this.warmupSec) targets.push(this.tallySteady.all, this.tallySteady[kind]);
        for (const t of targets) {
            t.total++;
            if (outcome === 'success') {
                t.success++;
                t.latencySuccessSum += ms;
                continue;
            }
            t.latencyFailSum += ms;
            if (outcome === 'notified') {
                t.failNotified++;
                t.latencyNotifiedSum += ms;
            } else if (ms >= this.slowMs) {
                t.failSlow++;
                t.latencySlowSum += ms;
            } else {
                t.failFast++;
                t.latencyFastSum += ms;
            }
        }
    }

    async submitTransaction() {
        const tx = this.nextTx();
        const kind = (tx.fn === 'Query' || tx.query) ? 'query' : (tx.urgent ? 'urgent' : 'normalWrite');
        this.ops[tx.fn] = (this.ops[tx.fn] || 0) + 1;
        const reqId = `${this.user}-w${this.workerIndex}-${this.roundIndex}-${this.seq++}`;
        if (this.latencyMs > 0) {
            await sleep(this.latencyMs);
        }
        let notified = null;
        if (this.abortNotify) {
            notified = new Promise((resolve) => this.pending.set(reqId, () => resolve('notified')));
        }
        const start = Date.now();
        if (this.t0 === null) this.t0 = start;
        const sent = this.sutAdapter.sendRequests({
            contractId: this.contractId,
            contractFunction: tx.fn,
            contractArguments: [this.user, tx.urgent ? '1' : '0', reqId, ...tx.args],
            invokerIdentity: 'User1',
            readOnly: false
        });
        const settled = sent.then((status) =>
            (status && typeof status.GetStatus === 'function' && status.GetStatus() === 'success') ? 'success' : 'failed');
        const outcome = await (notified ? Promise.race([settled, notified]) : settled);
        this.pending.delete(reqId);
        this.record(kind, outcome, Date.now() - start, start);
        return sent;
    }

    async cleanupWorkloadModule() {
        // 집계 파일을 먼저 쓴다. 부하가 높을 때 kafkajs 소비자가 그룹에서 밀려났다 다시 들어가는 중이면
        // disconnect 가 끝나지 않아 워커가 멈출 수 있다(실제로 Caliper 라운드가 15분 넘게 끝나지 않았다).
        this.writeTally();
        if (this.profSession) {
            await new Promise((resolve) => this.profSession.post('Profiler.stop', (err, res) => {
                try {
                    fs.mkdirSync(path.join(this.outDir, 'prof'), { recursive: true });
                    if (!err) fs.writeFileSync(path.join(this.outDir, 'prof', `w${this.workerIndex}-${this.user}.cpuprofile`), JSON.stringify(res.profile));
                } catch (e) { console.error(`프로파일을 쓰지 못했다: ${e.message}`); }
                resolve();
            }));
        }
        if (this.consumer) {
            await Promise.race([this.consumer.disconnect().catch(() => {}), sleep(5000)]);
        }
    }

    writeTally() {
        const out = {
            user: this.user,
            latencyMs: this.latencyMs,
            urgentRatio: this.urgentRatio,
            ops: this.ops,
            tally: this.tally,
            warmupSec: this.warmupSec,
            tallySteady: this.tallySteady,
            series: this.series
        };
        if (this.sdkStats) out.sdkStats = { ...this.sdkStats, services: [...this.sdkStats.services] };
        if (this.txlog) {
            try {
                fs.writeFileSync(path.join(this.outDir, `tx-${this.user}-w${this.workerIndex}.json`), JSON.stringify(this.txlog));
            } catch (e) { console.error(`tx 기록을 쓰지 못했다: ${e.message}`); }
        }
        try {
            fs.writeFileSync(path.join(this.outDir, `user-${this.user}-w${this.workerIndex}.json`), JSON.stringify(out, null, 2));
        } catch (e) {
            // 집계 파일을 못 써도 라운드 결과는 남는다
            console.error(`user-${this.user}-w${this.workerIndex}.json 을 쓰지 못했다: ${e.message}`);
        }
    }
}

// fabric-common 2.2 의 EventService._callTransactionListener 는 블록의 tx 하나마다 등록된 리스너를 모두 훑고,
// 맞지 않는 리스너마다 logger.debug(...'not called') 를 부른다. 디버그가 꺼져 있어도 winston 인자 처리 비용이 든다.
// abort 된 tx 는 블록에 나오지 않아 그 커밋 리스너가 시간 초과까지 남으므로, Serializer 실행에서는 워커당 리스너가
// 2,000개 넘게 쌓여 이 호출이 Fabric 의 약 19배(워커당 1,700만 번)가 되고 워커 CPU 를 채워 보내는 TPS 가 떨어졌다(§68).
// 맞는 리스너만 원래 함수에 넘겨 같은 동작을 하되 'not called' 디버그 호출만 없앤다. WORKLOAD_SDK_FASTTX=0 이면 끈다.
let fastTxInstalled = false;
function installFastTxListener() {
    if (fastTxInstalled || process.env.WORKLOAD_SDK_FASTTX === '0') return;
    fastTxInstalled = true;
    try {
        const fc = require(require.resolve('fabric-common', { paths: ['/home/node/.npm-global/lib/node_modules/fabric-network'] }));
        const TX = fc.EventListener.TX, proto = fc.EventService.prototype, orig = proto._callTransactionListener;
        proto._callTransactionListener = function (txId, ...rest) {
            const all = this._eventListenerRegistrations;
            const sub = new Map();
            for (const [k, r] of all) {
                if (r.listenerType === TX && (r.event === txId || r.event === 'all')) sub.set(k, r);
            }
            if (sub.size === 0) return undefined;
            const matched = new Set(sub.keys());
            this._eventListenerRegistrations = sub;
            try {
                return orig.call(this, txId, ...rest);
            } finally {
                // 원래 함수가 지운 것(자동 해제)은 원래 표에서도 지우고, 그 사이 새로 등록된 것은 옮긴다
                this._eventListenerRegistrations = all;
                for (const k of matched) if (!sub.has(k)) all.delete(k);
                for (const [k, r] of sub) if (!matched.has(k)) all.set(k, r);
                // 해제할 때 SDK 는 그때의 표(위의 sub)로 리스너 유무 표시를 다시 계산한다. 원래 표로 다시 맞춘다
                let b = false, t = false, c = false;
                for (const r of all.values()) {
                    if (r.listenerType === fc.EventListener.BLOCK) b = true;
                    else if (r.listenerType === TX) t = true;
                    else if (r.listenerType === fc.EventListener.CHAINCODE) c = true;
                }
                this._haveBlockListeners = b; this._haveTxListeners = t; this._haveChaincodeListeners = c;
            }
        };
    } catch (e) {
        console.error(`SDK 리스너 우회를 설치하지 못했다: ${e.message}`);
    }
}

function createWorkloadModule() {
    return new UsersWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
