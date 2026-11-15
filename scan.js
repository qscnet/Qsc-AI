#!/usr/bin/env node
/*!
 * 玄武 · 全书扫描
 *
 * 拿一堆**没参与训练**的真人小说，看模型会不会误判成 AI。
 * 这是检测器最重要的指标：误报率。
 *
 * 用法：
 *   node scan.js "F:\小说\小说资源" --n 8
 *   node scan.js "F:\BaiduNetdiskDownload\大秦帝国全六部十一卷_.txt" --n 10
 *   node scan.js "F:\小说" --n 6 --min-kb 200 --top 40
 *
 * 参数：
 *   --n N        每本书抽几段（默认 8）
 *   --chunk N    每段多少字（默认 900）
 *   --min-kb N   只扫大于多少 KB 的文件（默认 150）
 *   --top N      最多显示几个文件（默认 50）
 *   --depth N    目录递归深度（默认 8）
 *   --json       输出 JSON
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AN = require('./assets/engine.js');

/* ---------------- 参数 ---------------- */

function flag(n) { return process.argv.indexOf('--' + n) >= 0; }
function opt(n, d) {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return (v && v.indexOf('--') !== 0) ? v : d;
}
const VALUE_FLAGS = ['n', 'chunk', 'min-kb', 'top', 'depth', 'model'];
const targets = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) { if (VALUE_FLAGS.indexOf(a.slice(2)) >= 0) i++; continue; }
    targets.push(a);
  }
}

const PER_BOOK = Number(opt('n', 8)) || 8;
const CHUNK = Number(opt('chunk', 900)) || 900;
const MIN_KB = Number(opt('min-kb', 150)) || 150;
const TOP = Number(opt('top', 50)) || 50;
const DEPTH = Number(opt('depth', 8)) || 8;
const AS_JSON = flag('json');

if (!targets.length) {
  console.error('\n  用法：node scan.js <目录或文件...> [--n 8] [--min-kb 150]\n');
  process.exit(1);
}

/* ---------------- 模型 ---------------- */

let model = null;
try {
  model = JSON.parse(fs.readFileSync(path.join(__dirname, 'model.json'), 'utf8'));
  if (model.demo) model = null;
} catch (e) { model = null; }

/* ---------------- 排除名单 ---------------- */

// 训练集里的书（含进去就失去意义）
const TRAINED = /遮天|大奉打更人|最强弃少|圣墟/;
// 不是小说：设定集、大纲、风格分析、我们的输出文件
const NOT_NOVEL = /锁在人体|宇宙启示录|格物致圣|华夏上古史|校验清单|全书-|总表|设定|大纲|卷纲|章纲|风格|style|analysis|语料|corpus|out-|素材|参考样本原稿/i;

/* ---------------- 读文本 ---------------- */

function readAny(file) {
  const buf = fs.readFileSync(file);
  let t = buf.toString('utf8');
  if (t.indexOf('\uFFFD') >= 0) {
    try { t = new TextDecoder('gbk', { fatal: false }).decode(buf); } catch (e) { /* keep */ }
  }
  return t.replace(/\r\n?/g, '\n');
}

/* ---------------- 抽段 ---------------- */

function sampleChunks(text, count, size) {
  const marks = [];
  const re = /第[零〇一二三四五六七八九十百千万两0-9]{1,9}章/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  const out = [];
  if (marks.length >= 5) {
    const per = Math.max(1, Math.floor(marks.length / count));
    for (let k = 0; k < marks.length && out.length < count; k += per) {
      const end = (k + 1 < marks.length) ? marks[k + 1] : text.length;
      const start = marks[k] + Math.floor((end - marks[k]) * 0.3);
      let seg = text.slice(start, start + size).trim();
      if (seg.replace(/\s/g, '').length > 400) out.push(seg);
    }
  } else {
    const step = Math.floor(text.length / (count + 1));
    for (let i = 1; i <= count; i++) {
      let seg = text.slice(i * step, i * step + size).trim();
      if (seg.replace(/\s/g, '').length > 400) out.push(seg);
    }
  }
  return out;
}

/* ---------------- 遍历 ---------------- */

function walk(p, depth, acc) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return acc; }
  if (st.isDirectory()) {
    if (depth <= 0) return acc;
    let ents = [];
    try { ents = fs.readdirSync(p); } catch (e) { return acc; }
    ents.forEach(e => walk(path.join(p, e), depth - 1, acc));
  } else if (/\.txt$/i.test(p) && st.size > MIN_KB * 1024) {
    acc.push({ file: p, size: st.size });
  }
  return acc;
}

let files = [];
targets.forEach(t => walk(path.resolve(t), DEPTH, files));

const skipped = [];
files = files.filter(f => {
  const base = path.basename(f.file);
  if (TRAINED.test(base)) { skipped.push(['训练集', base]); return false; }
  if (NOT_NOVEL.test(f.file)) { skipped.push(['非小说', base]); return false; }
  return true;
});

/* ---------------- 打分 ---------------- */

const results = [];
files.forEach(f => {
  let text;
  try { text = readAny(f.file); } catch (e) { return; }
  const chunks = sampleChunks(text, PER_BOOK, CHUNK);
  if (!chunks.length) return;

  const scores = [];
  chunks.forEach(c => {
    try {
      const r = AN.analyze(c, model ? { maxChars: 4000, model } : { maxChars: 4000 });
      scores.push(r.score);
    } catch (e) { /* skip */ }
  });
  if (!scores.length) return;

  scores.sort((a, b) => a - b);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  results.push({
    name: path.basename(f.file).replace(/\.txt$/i, '').slice(0, 40),
    path: f.file,
    mb: Math.round(f.size / 1024 / 10) / 100,
    n: scores.length,
    mean: Math.round(mean * 10) / 10,
    min: scores[0],
    max: scores[scores.length - 1],
    over50: scores.filter(s => s >= 50).length,
    over70: scores.filter(s => s >= 70).length
  });
});

results.sort((a, b) => b.mean - a.mean);

/* ---------------- 输出 ---------------- */

if (AS_JSON) {
  console.log(JSON.stringify({ model: model && model.metrics, results }, null, 2));
  process.exit(0);
}

console.log('\n  玄武 · 全书扫描（真人小说误报检测）');
console.log('  ' + '='.repeat(84));
console.log('  模型：' + (model ? 'model.json，' + model.features.length + ' 项特征' +
  (model.metrics && model.metrics.cvAccuracy != null ? '，CV ' + (model.metrics.cvAccuracy * 100).toFixed(1) + '%' : '')
  : '无（规则引擎）'));
console.log('  每本抽 ' + PER_BOOK + ' 段 × ' + CHUNK + ' 字，共 ' + results.length + ' 本');
console.log('');
console.log('  均分   区间      超50  书');
console.log('  ' + '-'.repeat(84));
results.slice(0, TOP).forEach(r => {
  const bar = r.mean >= 50 ? '！！' : (r.mean >= 35 ? '  !' : '   ');
  console.log('  ' + String(r.mean).padStart(4) + bar + '  ' +
    String(r.min).padStart(3) + '-' + String(r.max).padStart(3) + '  ' +
    String(r.over50 + '/' + r.n).padStart(6) + '  ' + r.name);
});

const books = results.length;
const flagged = results.filter(r => r.mean >= 50);
const borderline = results.filter(r => r.mean >= 35 && r.mean < 50);
const clean = results.filter(r => r.mean < 35);
const allChunks = results.reduce((s, r) => s + r.n, 0);
const allOver50 = results.reduce((s, r) => s + r.over50, 0);

console.log('');
console.log('  ' + '='.repeat(84));
console.log('  ' + books + ' 本书，' + allChunks + ' 段');
console.log('    干净（<35 分）      ' + clean.length + ' 本');
console.log('    边界（35–49 分）    ' + borderline.length + ' 本');
console.log('    误判（≥50 分）      ' + flagged.length + ' 本');
console.log('    段落级误报率        ' + (allOver50 / allChunks * 100).toFixed(1) + '%（' + allOver50 + '/' + allChunks + '）');
if (flagged.length) {
  console.log('');
  console.log('  误判最严重的书：');
  flagged.slice(0, 8).forEach(r => console.log('    ' + String(r.mean).padStart(4) + ' 分  ' + r.name));
}
console.log('');
