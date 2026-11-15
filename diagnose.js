#!/usr/bin/env node
/*!
 * 玄武 · 特征诊断
 *
 * 逐项对比「AI 样本」和「真人样本」在每个特征上的分布，
 * 用 Cohen's d 衡量这一项到底有多能区分——d 越大越有用，d < 0.2 等于噪声。
 *
 * 目的：当总体区分度很差时，一眼看出引擎是"瞎在哪几项"。
 *
 * 用法：
 *   node diagnose.js               # 输出全部 57 项，按区分度排序
 *   node diagnose.js --top 10      # 只看前 10 项
 *   node diagnose.js --dim lexicon # 只看某个维度
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AN = require('./assets/engine.js');

const OUT = path.join(__dirname, 'samples.jsonl');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v && v.indexOf('--') !== 0) ? v : true;
}
const TOP = Number(arg('top', 0)) || 0;
const ONLY_DIM = arg('dim', null);

/* ---------- 读样本 ---------- */

if (!fs.existsSync(OUT)) {
  console.error('\n  找不到 samples.jsonl，先跑 node bootstrap.js\n');
  process.exit(1);
}

const ai = [], human = [];
let total = 0;
fs.readFileSync(OUT, 'utf8').split(/\r?\n/).forEach(line => {
  if (!line.trim()) return;
  let s;
  try { s = JSON.parse(line); } catch (e) { return; }
  if (!s.features) return;
  total++;
  if (s.label === 'ai') ai.push(s.features);
  else if (s.label === 'human') human.push(s.features);
});

if (ai.length < 3 || human.length < 3) {
  console.error('\n  样本太少：AI ' + ai.length + ' 条，真人 ' + human.length + ' 条，至少各 3 条\n');
  process.exit(1);
}

/* ---------- 统计 ---------- */

const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
const sd = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
};
const fmt = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));

const dimName = {};
AN.DIMS.forEach(d => { dimName[d.key] = d.name; });

const rows = [];
AN.featureDefs.forEach(def => {
  if (ONLY_DIM && def.dim !== ONLY_DIM) return;
  const av = [], hv = [];
  ai.forEach(f => { if (typeof f[def.id] === 'number') av.push(f[def.id]); });
  human.forEach(f => { if (typeof f[def.id] === 'number') hv.push(f[def.id]); });
  if (av.length < 2 || hv.length < 2) {
    rows.push({ def, usable: false, na: av.length, nh: hv.length });
    return;
  }
  const ma = mean(av), mh = mean(hv);
  const sa = sd(av), sh = sd(hv);
  const pooled = Math.sqrt((sa * sa + sh * sh) / 2) || 1e-9;
  const d = Math.abs(ma - mh) / pooled;
  rows.push({
    def, usable: true, ma, mh, d,
    dir: ma > mh ? 'up' : 'down',
    // 引擎当前给这一项的方向对不对
    engineDir: def.dir,
    ok: (ma > mh ? 'up' : 'down') === def.dir
  });
});

rows.sort((a, b) => (b.usable ? b.d : -1) - (a.usable ? a.d : -1));

/* ---------- 输出 ---------- */

console.log('\n  玄武 · 特征诊断');
console.log('  ' + '-'.repeat(64));
console.log('  AI 样本 ' + ai.length + ' 条，真人样本 ' + human.length + ' 条，共 ' + total + ' 条');
console.log('');
console.log('  ' + '特征'.padEnd(16, '　') + '维度'.padEnd(7, '　') + 'AI均值'.padStart(9) + '  ' + '真人均值'.padStart(9) + '   d值   评价');
console.log('  ' + '-'.repeat(64));

const list = TOP ? rows.slice(0, TOP) : rows;
list.forEach(r => {
  if (!r.usable) {
    console.log('  ' + (r.def.name + '　　').slice(0, 15) + ' ' + (dimName[r.def.dim] || '').padEnd(5, '　') +
      '   有效值不足（AI ' + r.na + ' / 人 ' + r.nh + '）');
    return;
  }
  let tag = '';
  if (r.d >= 0.8) tag = '★ 强';
  else if (r.d >= 0.5) tag = '○ 可用';
  else if (r.d >= 0.2) tag = '· 弱';
  else tag = '× 噪声';
  if (!r.ok) tag += '（方向反了）';
  const name = (r.def.name + '　　　　　　　　').slice(0, 15);
  console.log('  ' + name + ' ' + (dimName[r.def.dim] || '').padEnd(5, '　') +
    fmt(r.ma).padStart(9) + '  ' + fmt(r.mh).padStart(9) + '   ' + r.d.toFixed(2).padStart(4) + '  ' + tag);
});

/* ---------- 按维度汇总 ---------- */

console.log('');
console.log('  按维度汇总（维度内各特征 d 的平均值）：');
const byDim = {};
rows.forEach(r => {
  if (!r.usable) return;
  (byDim[r.def.dim] = byDim[r.def.dim] || []).push(r.d);
});
Object.keys(byDim).sort((a, b) => mean(byDim[b]) - mean(byDim[a])).forEach(k => {
  const v = mean(byDim[k]);
  const bar = '█'.repeat(Math.min(20, Math.round(v * 20))) || '·';
  console.log('    ' + (dimName[k] || k).padEnd(5, '　') + ' ' + v.toFixed(2) + '  ' + bar);
});

/* ---------- 结论 ---------- */

const good = rows.filter(r => r.usable && r.d >= 0.5);
const noise = rows.filter(r => r.usable && r.d < 0.2);
const flipped = rows.filter(r => r.usable && !r.ok);

console.log('');
console.log('  ' + '-'.repeat(64));
console.log('  可用特征（d≥0.5）：' + good.length + ' 项' +
  (good.length ? '　' + good.slice(0, 6).map(r => r.def.name).join('、') : '　——没有一项真正能区分'));
console.log('  噪声特征（d<0.2）：' + noise.length + ' 项');
if (flipped.length) {
  console.log('  ! 方向反了：' + flipped.map(r => r.def.name).join('、'));
  console.log('    这些特征在引擎里被判为"越高越像 AI"，但你的数据里恰恰相反，需要改 dir。');
}
console.log('');
if (good.length < 5) {
  console.log('  结论：这套特征在本题材上几乎没有分辨力。');
  console.log('        再堆样本也没用，得先补特征或换模型（字符 n-gram）。\n');
} else if (good.length < 12) {
  console.log('  结论：有一点信号，但偏弱。建议先跑 node calibrate.js 把噪声特征关掉，再训练。\n');
} else {
  console.log('  结论：特征基本够用，可以 python train.py 了。\n');
}
