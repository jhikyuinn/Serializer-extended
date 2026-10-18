// §68 Node .cpuprofile 요약: 자기 시간(self) 기준 상위 함수와 패키지별 합
//   node cpuprof-top.js <파일.cpuprofile>... [--top 25]
const fs = require('fs');
const args = process.argv.slice(2);
const ti = args.indexOf('--top'); const TOP = ti >= 0 ? +args.splice(ti, 2)[1] : 25;
const pkgOf = (url) => {
  if (!url) return '(native/idle)';
  const m = url.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
  if (m) return m[m.length - 1].replace('node_modules/', '');
  if (url.startsWith('node:')) return 'node:' + url.slice(5).split('/')[0];
  if (url.includes('/workspace/')) return 'workspace';
  return url.split('/').slice(-2).join('/');
};
for (const f of args) {
  const p = JSON.parse(fs.readFileSync(f));
  const dt = p.timeDeltas.reduce((a, b) => a + b, 0) / p.timeDeltas.length / 1000; // ms / 샘플
  const total = p.nodes.reduce((a, n) => a + (n.hitCount || 0), 0);
  const byFn = new Map(), byPkg = new Map();
  for (const n of p.nodes) {
    const h = n.hitCount || 0; if (!h) continue;
    const cf = n.callFrame, pkg = pkgOf(cf.url);
    const key = `${cf.functionName || '(anon)'}  [${pkg}${cf.url ? ':' + (cf.lineNumber + 1) : ''}]`;
    byFn.set(key, (byFn.get(key) || 0) + h); byPkg.set(pkg, (byPkg.get(pkg) || 0) + h);
  }
  const idle = (byFn.get('(idle)  [(native/idle)]') || 0);
  const busy = total - idle;
  console.log(`\n== ${f}\n  전체 ${(total * dt / 1000).toFixed(1)} s, 바쁨 ${(busy * dt / 1000).toFixed(1)} s (${(100 * busy / total).toFixed(0)}%)`);
  console.log('  -- 패키지별 (바쁜 시간 중 %)');
  [...byPkg].filter(([k]) => k !== '(native/idle)' || true).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([k, v]) => console.log(`  ${(100 * v / busy).toFixed(1).padStart(5)}%  ${k}`));
  console.log(`  -- 함수별 상위 ${TOP}`);
  [...byFn].filter(([k]) => !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, TOP)
    .forEach(([k, v]) => console.log(`  ${(100 * v / busy).toFixed(1).padStart(5)}%  ${k}`));
}
