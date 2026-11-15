#!/usr/bin/env node
/*!
 * 玄武 · 改写建议（给写作系统调用）
 *
 * 输出「哪些特征在把分数推高、每一项要改到什么值」，
 * 直接可以塞进 LLM 的改写提示词里。
 *
 * 用法：
 *   node advise.js "章节.txt"
 *   node advise.js "章节.txt" --target 35 --top 12
 *   node advise.js "章节.txt" --json          # 给程序读
 *   node advise.js --preset chapter
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AN = require('./assets/engine.js');

const VALUE_FLAGS = ['target', 'top', 'model', 'preset'];
function flag(n) { return process.argv.indexOf('--' + n) >= 0; }
function opt(n, d) {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return (v && v.indexOf('--') !== 0) ? v : d;
}

const TARGET = Number(opt('target', 35)) || 35;
const TOP = Number(opt('top', 12)) || 12;
const AS_JSON = flag('json');

const PRESETS = {
  chapter: 'E:\\qsc\\玄武AI检测\\seed\\raw\\_user-chapter.txt',
  rewrite: 'E:\\qsc\\玄武AI检测\\seed\\raw\\_chapter-rewrite.txt'
};

const targets = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) { if (VALUE_FLAGS.indexOf(a.slice(2)) >= 0) i++; continue; }
    targets.push(a);
  }
}
const preset = opt('preset', null);
if (preset) {
  if (!PRESETS[preset]) { console.error('没有这个预设：' + preset); process.exit(1); }
  targets.push(PRESETS[preset]);
}
if (!targets.length) {
  console.error('\n  用法：node advise.js <文件> [--target 35] [--top 12] [--json]\n');
  process.exit(1);
}

let model = null;
try {
  model = JSON.parse(fs.readFileSync(path.join(__dirname, 'model.json'), 'utf8'));
  if (model.demo) model = null;
} catch (e) { model = null; }
if (!model) { console.error('  没有可用的 model.json，先 python train.py'); process.exit(1); }

function readAny(file) {
  const buf = fs.readFileSync(file);
  let t = buf.toString('utf8');
  if (t.indexOf('\uFFFD') >= 0) {
    try { t = new TextDecoder('gbk', { fatal: false }).decode(buf); } catch (e) { /* keep */ }
  }
  return t.replace(/\r\n?/g, '\n');
}

const file = path.resolve(targets[0]);
if (!fs.existsSync(file)) { console.error('  找不到 ' + file); process.exit(1); }
const text = readAny(file);

let r;
try { r = AN.analyze(text, { maxChars: 20000, model }); }
catch (e) { console.error('  分析失败：' + e.message); process.exit(1); }

/* ---------------- 拆贡献 ---------------- */

const vals = {};
(r.features || []).forEach(f => { if (!f.skipped && typeof f.value === 'number') vals[f.id] = f.value; });

const clip = Number(model.zClip) > 0 ? Number(model.zClip) : 3;
const rows = [];
const conflicts = [];
let z = Number(model.intercept) || 0;
model.features.forEach(mf => {
  const v = vals[mf.id];
  if (v === undefined) return;
  let zi = (v - mf.mean) / (Math.abs(mf.std) < 1e-9 ? 1 : mf.std);
  zi = Math.max(-clip, Math.min(clip, zi));
  const c = (mf.w || 0) * zi;
  z += c;

  const def = AN.featureDefs.find(d => d.id === mf.id) || {};
  // 模型学到的方向 vs 特征设计时的方向，反了就记一笔
  const designUp = def.dir !== 'down';
  const learnedUp = (mf.w || 0) >= 0;
  if (def.dir && designUp !== learnedUp) {
    conflicts.push({ name: def.name || mf.id, design: designUp ? '越高越像AI' : '越低越像AI', learned: learnedUp ? '越高越像AI' : '越低越像AI' });
  }

  if (Math.abs(c) < 0.08) return;
  rows.push({
    id: mf.id,
    name: def.name || mf.id,
    value: Math.round(v * 1000) / 1000,
    mean: Math.round(mf.mean * 1000) / 1000,
    contrib: Math.round(c * 100) / 100,
    // 要降低这一项的影响，就是把值拉回均值方向
    toMean: v > mf.mean ? 'down' : 'up'
  });
});
rows.sort((a, b) => b.contrib - a.contrib);

const pushing = rows.filter(x => x.contrib > 0);
const pulling = rows.filter(x => x.contrib < 0);
const totalPush = pushing.reduce((s, x) => s + x.contrib, 0);
const totalPull = pulling.reduce((s, x) => s + x.contrib, 0);

function instr(x) {
  return (x.toMean === 'down' ? '↓ 降到约 ' : '↑ 提到约 ') + x.mean;
}

// 目标分对应的 z 大概在哪：分数 = 100*sigmoid(z)，反推
function scoreToZ(s) {
  const p = Math.min(0.999, Math.max(0.001, s / 100));
  return Math.log(p / (1 - p));
}
const zNow = z;
const zTarget = scoreToZ(TARGET);
const need = (totalPush + totalPull) - (zTarget - Number(model.intercept || 0));

/* ---------------- 输出 ---------------- */

if (AS_JSON) {
  console.log(JSON.stringify({
    file: path.basename(file),
    chars: r.text.cjk,
    score: r.score,
    verdict: r.verdict.label,
    target: TARGET,
    z: Math.round(zNow * 1000) / 1000,
    zTarget: Math.round(zTarget * 1000) / 1000,
    mustShed: Math.round(need * 100) / 100,
    push: pushing.slice(0, TOP),
    pull: pulling.slice(0, 6)
  }, null, 2));
  process.exit(0);
}

console.log('\n  玄武 · 改写建议');
console.log('  ' + '='.repeat(70));
console.log('  ' + path.basename(file) + '　' + r.text.cjk + ' 字');
console.log('  当前 ' + r.score + ' 分（' + r.verdict.label + '）　目标 < ' + TARGET + ' 分（人写）');
console.log('  当前 z = ' + zNow.toFixed(2) + '，目标 z 需 ≤ ' + zTarget.toFixed(2) +
  '，还差 ' + Math.max(0, need).toFixed(2));

console.log('');
console.log('  把分数推高的项（按影响排序）：');
console.log('  ' + '-'.repeat(70));
console.log('  特征　　　　　　 当前值     人类均值   影响    改法');
console.log('  ' + '-'.repeat(70));
pushing.slice(0, TOP).forEach(x => {
  const nm = (x.name + '　　　　　　　').slice(0, 9);
  console.log('  ' + nm + ' ' + String(x.value).padStart(8) + '  ' + String(x.mean).padStart(8) + '  ' +
    ('+' + x.contrib.toFixed(2)).padStart(6) + '  ' + instr(x));
});

if (pulling.length) {
  console.log('');
  console.log('  已经在帮你拉回人写的项（别动它们）：');
  pulling.slice(0, 6).forEach(x => {
    console.log('  ' + (x.name + '　　　　　　　').slice(0, 9) + ' ' + String(x.value).padStart(8) +
      '  ' + x.contrib.toFixed(2));
  });
}

console.log('');
console.log('  ' + '='.repeat(70));
if (conflicts.length) {
  console.log('  ⚠ 这 ' + conflicts.length + ' 项，模型学到的方向和特征定义相反（多半是语料题材差异导致）：');
  conflicts.slice(0, 6).forEach(c => {
    console.log('    ' + (c.name + '　　　　　').slice(0, 7) + ' 设计：' + c.design + '　实际学到：' + c.learned);
  });
  console.log('    照这些指标改，可能让文字变差。建议先只动方向一致的项。');
  console.log('');
}
console.log('  改写优先级：先动影响最大的三项，改完重测，再决定下一步。');
console.log('  ' + '='.repeat(70));
console.log('');

// 给 LLM 的提示词片段
if (flag('prompt')) {
  console.log('【可直接粘进改写提示词】');
  console.log('请改写下面这段文字，把下列指标拉回人类写作区间（按优先级）：');
  pushing.slice(0, 5).forEach((x, i) => {
    console.log((i + 1) + '. 「' + x.name + '」当前 ' + x.value + '，' + instr(x));
  });
  console.log('保持情节、人物、对话内容不变，只调整叙述方式。');
  console.log('');
}
