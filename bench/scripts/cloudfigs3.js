// §60 Serializer 장점 그림 4~6 (계좌 100, s 0~2 × 배치 100/500/1000 × 1,000 TPS, §54 3회)
//   그림 4 Query(읽기 전용) 성공률, 그림 5 블록에 담긴 tx 구성(성공 / 피어 무효 / 미리 걸러냄), 그림 6 사용자별 성공 처리량
//   node cloudfigs3.js [출력 폴더]
const fs = require('fs'), path = require('path');
// CLOUD_DIR·CLOUD_PREFIX 로 다른 묶음을 쓸 수 있다(§78 재측정: results/cloud2, cloud2)
const R = process.env.CLOUD_DIR || path.join(__dirname, '../zipfbench/results/cloud');
const PFX = process.env.CLOUD_PREFIX || 'cloud';
const OUT = process.argv[2] || path.join(__dirname, '../../experiments/01-contention-batch/figures');
const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - m(a)) ** 2, 0) / (a.length - 1));
const SS = ['0', '0.5', '1.0', '1.5', '2.0'], BS = [100, 500, 1000], SYS = ['A1', 'BE'];
const USERS = ['User1', 'User2', 'User3', 'User4', 'User5'], ULAT = { User1: 4.5, User2: 50, User3: 50, User4: 50, User5: 100 };

const D = {};
for (const b of BS) for (const s of SS) for (const sys of SYS) {
  const dir = path.join(R, `${PFX}-s${s}-b${b}`, sys, 'u0'); const reps = [];
  for (const rep of fs.readdirSync(dir)) {
    const d = path.join(dir, rep); if (!fs.existsSync(path.join(d, 'meta.json'))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'))); const dur = meta.duration - (meta.warmupSec || 0);
    const a = {}, q = {}, u = {};
    for (const f of fs.readdirSync(d).filter((f) => f.startsWith('user-'))) {
      const j = JSON.parse(fs.readFileSync(path.join(d, f))), t = j.tallySteady;
      for (const [k, x] of Object.entries(t.all)) a[k] = (a[k] || 0) + x;
      for (const [k, x] of Object.entries(t.query)) q[k] = (q[k] || 0) + x;
      u[j.user] = (u[j.user] || 0) + t.all.success / dur;
    }
    reps.push({
      q: 100 * q.success / q.total,
      succ: a.success / dur, inval: a.failFast / dur, pre: a.failNotified / dur,
      invShare: 100 * a.failFast / (a.success + a.failFast),
      ...Object.fromEntries(USERS.map((x) => ['u_' + x, u[x] || 0])),
    });
  }
  const st = {}; for (const k of Object.keys(reps[0])) st[k] = [m(reps.map((r) => r[k])), sd(reps.map((r) => r[k]))];
  (D[b] ??= {})[s] ??= {}; D[b][s][sys] = st;
}
fs.writeFileSync(path.join(OUT, 'fig456-data.json'), JSON.stringify(D, null, 1));

// ---- SVG 도우미 ----
const FONT = "font-family=\"'Malgun Gothic','Noto Sans KR','Apple SD Gothic Neo',sans-serif\"";
const C = { A1: '#8a8f98', BE: '#2563eb', inv: '#ef4444', invF: '#fca5a5', pre: '#f59e0b' };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, t, o = '') => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" ${o}>${esc(t)}</text>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT} font-size="12">\n<rect width="${w}" height="${h}" fill="#fff"/>\n${body}\n</svg>\n`;
function panel(x0, y0, w, h, ymax, title, ylabel, cats, xlabel, nt = 5, fmt = (v) => +v.toFixed(1)) {
  const ym = (v) => y0 - (v / ymax) * h; let s = '';
  for (let i = 0; i <= nt; i++) { const v = ymax * i / nt, y = ym(v); s += `<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="#e5e7eb"/>` + T(x0 - 6, y + 4, fmt(v), 'text-anchor="end" font-size="11"'); }
  s += `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 - h}" stroke="#333"/><line x1="${x0}" y1="${y0}" x2="${x0 + w}" y2="${y0}" stroke="#333"/>`;
  s += T(x0 + w / 2, y0 - h - 10, title, 'text-anchor="middle" font-weight="bold" font-size="13"');
  if (ylabel) s += T(x0 - 46, y0 - h / 2, ylabel, `text-anchor="middle" transform="rotate(-90 ${x0 - 46} ${y0 - h / 2})"`);
  const xs = (i) => x0 + (i + 0.5) * w / cats.length;
  cats.forEach((v, i) => { s += T(xs(i), y0 + 16, v, 'text-anchor="middle" font-size="11.5"'); });
  if (xlabel) s += T(x0 + w / 2, y0 + 34, xlabel, 'text-anchor="middle" fill="#444"');
  return { s, ym, xs };
}
const errbar = (x, y1, y2, col = '#111') => `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${col}"/><line x1="${x - 3}" y1="${y1}" x2="${x + 3}" y2="${y1}" stroke="${col}"/><line x1="${x - 3}" y1="${y2}" x2="${x + 3}" y2="${y2}" stroke="${col}"/>`;
const key = (x, y, items) => { let s = '', xx = x; for (const [lab, col, kind] of items) { s += kind === 'line' ? `<line x1="${xx}" y1="${y - 4}" x2="${xx + 18}" y2="${y - 4}" stroke="${col}" stroke-width="2.5"/><circle cx="${xx + 9}" cy="${y - 4}" r="3.5" fill="${col}"/>` : kind === 'outline' ? `<rect x="${xx}" y="${y - 11}" width="14" height="12" fill="#fff" stroke="${col}" stroke-width="1.8" stroke-dasharray="3 2"/>` : `<rect x="${xx}" y="${y - 11}" width="14" height="12" fill="${col}"/>`; s += T(xx + 20, y, lab); xx += 34 + lab.length * 9.2; } return s; };
const foot = (W, H, t) => T(W / 2, H - 12, t, 'text-anchor="middle" fill="#555" font-size="11"');
const COND = 'smallbank, 계좌 100, 1,000 TPS, Query 50%, 사용자 5명, 긴급 0 · AWS 4 VM · 30초(앞 5초 제외) × 3회 평균';
const W = 1080, X0 = 95, gx = 340, pw = 270;

// ---- 그림 4: Query 성공률 ----
{
  const H = 400; let body = '';
  BS.forEach((b, j) => {
    const P = panel(X0 + j * gx, 330, pw, 250, 100, `배치 ${b}`, j === 0 ? '읽기 전용 tx(Query) 성공률 (%)' : '', SS, 'Zipf s', 5, (v) => v.toFixed(0));
    body += P.s;
    for (const sys of SYS) {
      body += `<polyline points="${SS.map((s, i) => `${P.xs(i)},${P.ym(D[b][s][sys].q[0])}`).join(' ')}" fill="none" stroke="${C[sys]}" stroke-width="2.4"/>`;
      SS.forEach((s, i) => { const v = D[b][s][sys].q; body += `<circle cx="${P.xs(i)}" cy="${P.ym(v[0])}" r="4" fill="${C[sys]}"/>` + errbar(P.xs(i), P.ym(v[0] + v[1]), P.ym(v[0] - v[1]), C[sys]); });
    }
    for (const i of [0, 4]) { const s = SS[i];
      body += T(P.xs(i), P.ym(D[b][s].BE.q[0]) - 10, `${D[b][s].BE.q[0].toFixed(0)}%`, `text-anchor="middle" font-size="11" font-weight="bold" fill="${C.BE}"`);
      body += T(P.xs(i), D[b][s].A1.q[0] < 8 ? P.ym(D[b][s].A1.q[0]) - 9 : P.ym(D[b][s].A1.q[0]) + 18, `${D[b][s].A1.q[0].toFixed(0)}%`, `text-anchor="middle" font-size="11" font-weight="bold" fill="#555"`); }
  });
  body += key(340, 30, [['Fabric (같은 소스, A1)', C.A1, 'line'], ['Serializer (일반 ε 0.75, 긴급 0)', C.BE, 'line']]);
  body += foot(W, H, COND + ' · 막대는 ± 표준편차');
  fs.writeFileSync(path.join(OUT, 'fig4-query.svg'), svg(W, H, body));
}

// ---- 그림 5: 블록에 담긴 tx 구성 ----
{
  const H = 490; let body = '';
  BS.forEach((b, j) => {
    const P = panel(X0 + j * gx, 400, pw, 270, 1200, `배치 ${b}`, j === 0 ? '초당 tx 수' : '', SS, 'Zipf s', 6, (v) => v.toFixed(0));
    body += P.s;
    SS.forEach((s, i) => {
      const bw = 20;
      SYS.forEach((sys, k) => {
        const v = D[b][s][sys], x = P.xs(i) + (k ? 1 : -bw - 1);
        const segs = sys === 'BE' ? [['succ', C.BE], ['inval', C.inv], ['pre', C.pre, 'outline']] : [['succ', C.A1], ['inval', C.invF]];
        let acc = 0;
        for (const [kk, col, kind] of segs) {
          const h = v[kk][0], y1 = P.ym(acc + h), hh = P.ym(acc) - y1;
          body += kind === 'outline' ? `<rect x="${x + 1}" y="${y1 + 1}" width="${bw - 2}" height="${Math.max(0, hh - 2)}" fill="#fff" stroke="${col}" stroke-width="1.6" stroke-dasharray="3 2"/>`
            : `<rect x="${x}" y="${y1}" width="${bw}" height="${hh}" fill="${col}"/>`;
          acc += h;
        }
      });
      body += T(P.xs(i) - 11, P.ym(D[b][s].A1.succ[0] + D[b][s].A1.inval[0]) - 5, `${D[b][s].A1.invShare[0].toFixed(0)}`, 'text-anchor="middle" font-size="9.5" fill="#b91c1c"');
      body += T(P.xs(i) + 11, P.ym(D[b][s].BE.succ[0] + D[b][s].BE.inval[0] + D[b][s].BE.pre[0]) - 5, `${D[b][s].BE.invShare[0].toFixed(0)}`, 'text-anchor="middle" font-size="9.5" fill="#b91c1c"');
    });
  });
  body += T(40, 36, '블록에 담긴 tx: 성공 + 피어에서 무효(MVCC). Serializer는 프로세서가 미리 걸러낸 tx(점선)를 블록에 넣지 않는다. 막대 위 숫자 = 블록 안 무효 비율(%)', 'font-size="12.5" font-weight="bold"');
  body += key(60, 64, [['Fabric 성공', C.A1], ['Fabric 블록 안 무효', C.invF], ['Serializer 성공', C.BE], ['Serializer 블록 안 무효', C.inv], ['Serializer 미리 걸러냄(블록 밖)', C.pre, 'outline']]);
  body += foot(W, H, COND + ' · 왼쪽 막대 Fabric, 오른쪽 막대 Serializer');
  fs.writeFileSync(path.join(OUT, 'fig5-block-waste.svg'), svg(W, H, body));
}

// ---- 그림 6: 사용자별 성공 처리량 (s 1.0) ----
{
  const H = 440; let body = ''; const s = '1.0';
  const cats = USERS.map((u) => u.replace('User', 'U'));
  BS.forEach((b, j) => {
    const top = Math.ceil(Math.max(...USERS.map((u) => D[b][s].BE['u_' + u][0] + D[b][s].BE['u_' + u][1])) * 1.2 / 20) * 20;
    const P = panel(X0 + j * gx, 340, pw, 250, top, `배치 ${b}`, j === 0 ? '사용자별 초당 성공 tx' : '', cats, '사용자 (지연 U1 4.5 · U2~U4 50 · U5 100 ms)', 5, (v) => v.toFixed(0));
    body += P.s;
    USERS.forEach((u, i) => {
      const bw = 18;
      SYS.forEach((sys, k) => { const v = D[b][s][sys]['u_' + u], x = P.xs(i) + (k ? 1 : -bw - 1);
        body += `<rect x="${x}" y="${P.ym(v[0])}" width="${bw}" height="${P.ym(0) - P.ym(v[0])}" fill="${C[sys]}"/>` + errbar(x + bw / 2, P.ym(v[0] + v[1]), P.ym(Math.max(0, v[0] - v[1]))); });
      const g = 100 * (D[b][s].BE['u_' + u][0] / D[b][s].A1['u_' + u][0] - 1);
      body += T(P.xs(i), P.ym(D[b][s].BE['u_' + u][0] + D[b][s].BE['u_' + u][1]) - 7, `+${g.toFixed(0)}%`, `text-anchor="middle" font-size="10.5" font-weight="bold" fill="${C.BE}"`);
    });
    const rF = D[b][s].A1.u_User5[0] / D[b][s].A1.u_User1[0], rS = D[b][s].BE.u_User5[0] / D[b][s].BE.u_User1[0];
    body += T(X0 + j * gx + pw / 2, 398, `U5 / U1 성공 비: Fabric ${rF.toFixed(2)} → Serializer ${rS.toFixed(2)}`, 'text-anchor="middle" font-size="11" fill="#111"');
  });
  body += key(340, 30, [['Fabric (같은 소스, A1)', C.A1], ['Serializer (일반 ε 0.75, 긴급 0)', C.BE]]);
  body += foot(W, H, COND.replace('계좌 100,', '계좌 100, s 1.0,') + ' · 숫자는 사용자별 Serializer 증가율');
  fs.writeFileSync(path.join(OUT, 'fig6-per-user.svg'), svg(W, H, body));
}

// 표
console.log('| 배치 | s | Query 성공률 F / S | 블록 안 무효 비율 F / S | 블록 안 무효 /s F / S | 미리 걸러냄 /s (S) | U5/U1 F / S |');
console.log('|---|---|---|---|---|---|---|');
for (const b of BS) for (const s of SS) { const F = D[b][s].A1, S = D[b][s].BE;
  console.log(`| ${b} | ${s} | ${F.q[0].toFixed(1)} / ${S.q[0].toFixed(1)}% | ${F.invShare[0].toFixed(1)} / ${S.invShare[0].toFixed(1)}% | ${F.inval[0].toFixed(0)} / ${S.inval[0].toFixed(0)} | ${S.pre[0].toFixed(0)} | ${(F.u_User5[0] / F.u_User1[0]).toFixed(2)} / ${(S.u_User5[0] / S.u_User1[0]).toFixed(2)} |`); }
