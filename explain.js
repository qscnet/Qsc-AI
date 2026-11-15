#!/usr/bin/env node
/*!
 * 玄武 · 单项解释
 *
 * 回答一个问题：这段文本为什么得到这个分数？
 * 把逻辑回归拆成「每一项特征值 × 权重 = 贡献」，按贡献排序打出来。
 *
 * 用法：
 *   node explain.js "F:\...\ch046-原文.txt"
 *   node explain.js "F:\...\矿藏\圣墟-蒸馏" --summary
 *   node explain.js 文件1 文件2 --top 12
 *
 * 参数：
 *   --summary   每个文件只打一行总分，不打明细
 *   --top N     明细最多显示几项（默认 15）
 *   --model F   指定模型文件（默认 model.json）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AN = require('./assets/engine.js');

/* ---------------- 参数 ---------------- */

function flag(name) { return process.argv.indexOf('--' + name) >= 0; }
function opt(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v && v.indexOf('--') !== 0) ? v : dflt;
}
const SUMMARY = flag('summary');
const TOP = Number(opt('top', 15)) || 15;
const MODEL_FILE = path.join(__dirname, String(opt('model', 'model.json')));

// 预设路径：中文路径写在 .bat 里会被 GBK 解析搞坏，放在 JS 里没事
const PRESETS = {
  // 圣墟原著里被判成 AI 的 3 章（误判排查）
  outliers: [
    'F:\\网文写作系统mimi\\矿藏\\圣墟-蒸馏\\ch046-原文.txt',
    'F:\\网文写作系统mimi\\矿藏\\圣墟-蒸馏\\ch052-原文.txt',
    'F:\\网文写作系统mimi\\矿藏\\圣墟-蒸馏\\ch054-原文.txt'
  ],
  // 对照：一本正常得分的原著
  'human-ok': [
    'F:\\网文写作系统mimi\\矿藏\\圣墟-蒸馏\\ch041-原文.txt'
  ],
  // 去AI味之后仍是 100 分的那本
  'ai-book': [
    'F:\\Harness\\网文写作系统\\books\\锁在人体里的神\\正文\\ch-010.md'
  ],
  // 整本扫描（只看总分）
  'ai-dir': [
    'F:\\Harness\\网文写作系统\\books\\锁在人体里的神\\正文'
  ]
};

const VALUE_FLAGS = ['preset', 'top', 'model'];
const targets = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.indexOf('--') === 0) {
      if (VALUE_FLAGS.indexOf(a.slice(2)) >= 0) i++;  // 跳过该参数的值
      continue;
    }
    targets.push(a);
  }
}
const presetArg = opt('preset', null);
if (presetArg) {
  const p = PRESETS[String(presetArg)];
  if (!p) {
    console.error('\n  没有这个预设：' + presetArg + '\n  可用：' + Object.keys(PRESETS).join('、') + '\n');
    process.exit(1);
  }
  targets.push.apply(targets, p);
}
if (!targets.length) {
  console.error('\n  用法：node explain.js <文件或目录> [--preset outliers] [--summary] [--top 15]\n');
  process.exit(1);
}

/* ---------------- 模型 ---------------- */

let model = null;
try {
  model = JSON.parse(fs.readFileSync(path.join(__dirname, 'model.json'), 'utf8'));
} catch (e) { /* 用下面的路径 */ }
try { model = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')); } catch (e) { model = null; }
if (model && model.demo) { console.log('  ! model.json 是演示模型'); model = null; }

const byId = {};
if (model) (model.features || []).forEach(f => { byId[f.id] = f; });

/* ---------------- 读文本 ---------------- */

function readAny(file) {
  const buf = fs.readFileSync(file);
  let t = buf.toString('utf8');
  if (t.indexOf('\uFFFD') >= 0) {
    try { t = new TextDecoder('gbk', { fatal: false }).decode(buf); } catch (e) { /* keep */ }
  }
  return t.replace(/\r\n?/g, '\n');
}

function collect(p) {
  const out = [];
  const full = path.resolve(p);
  if (!fs.existsSync(full)) { console.log('  ! 找不到 ' + full); return out; }
  const st = fs.statSync(full);
  if (st.isDirectory()) {
    fs.readdirSync(full).filter(f => /\.(txt|md)$/i.test(f)).sort()
      .forEach(f => out.push(path.join(full, f)));
  } else {
    out.push(full);
  }
  return out;
}

/* ---------------- 解释 ---------------- */

const fmt = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
const sign = v => (v >= 0 ? '+' : '');

function explainOne(file) {
  const text = readAny(file);
  let r;
  try { r = AN.analyze(text, model ? { maxChars: 8000, model } : { maxChars: 8000 }); }
  catch (e) { console.log('  ! ' + path.basename(file) + ' 分析失败：' + e.message); return; }

  const vals = {};
  (r.features || []).forEach(f => { if (!f.skipped && typeof f.value === 'number') vals[f.id] = f.value; });

  const rows = [];
  let zSum = model ? (model.intercept || 0) : 0;
  const clip = model && Number(model.zClip) > 0 ? Number(model.zClip) : 3;
  (model ? model.features : []).forEach(mf => {
    const raw = vals[mf.id];
    const missing = raw === undefined;
    let z = missing ? 0 : (raw - mf.mean) / (Math.abs(mf.std) < 1e-9 ? 1 : mf.std);
    if (z > clip) z = clip; else if (z < -clip) z = -clip;
    const contrib = (mf.w || 0) * z;
    zSum += contrib;
    rows.push({ id: mf.id, raw: missing ? null : raw, mean: mf.mean, z: z, w: mf.w, contrib: contrib, missing: missing });
  });
  rows.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));

  const nameOf = id => {
    const def = AN.featureDefs.filter(d => d.id === id)[0];
    return def ? def.name : id;
  };
  const dimOf = id => {
    const def = AN.featureDefs.filter(d => d.id === id)[0];
    return def ? def.dim : '';
  };

  if (SUMMARY) {
    console.log('  ' + String(r.score).padStart(3) + ' 分  ' + path.basename(file));
    return;
  }

  console.log('');
  console.log('  ' + path.basename(file));
  console.log('  ' + '-'.repeat(78));
  console.log('  ' + r.text.cjk + ' 字，' + r.text.sentences + ' 句，' + r.text.paragraphs + ' 段');
  console.log('  分数 ' + r.score + '（' + (r.verdict ? r.verdict.label : '') + '）' +
    (model ? '　模型 z=' + fmt(zSum) : '　规则引擎'));

  if (!model) { console.log('  ! 没有 model.json，只能给规则分数，无法拆贡献'); return; }

  console.log('');
  console.log('  特征　　　　　　　维度　　  实测值    训练均值      z      权重     贡献');
  console.log('  ' + '-'.repeat(78));
  rows.slice(0, TOP).forEach(row => {
    if (row.missing && Math.abs(row.contrib) < 1e-9) return;
    const nm = (nameOf(row.id) + '　　　　　　　　　').slice(0, 9);
    const dim = (dimOf(row.id) + '　　　').slice(0, 4);
    const rawTxt = row.missing ? '  ——  ' : String(fmt(row.raw)).padStart(8);
    console.log('  ' + nm + ' ' + dim + '  ' + rawTxt + '  ' +
      fmt(row.mean).padStart(8) + '  ' + (sign(row.z) + fmt(row.z)).padStart(7) + '  ' +
      (sign(row.w) + fmt(row.w)).padStart(6) + '  ' + (sign(row.contrib) + fmt(row.contrib)).padStart(7));
  });

  const pos = rows.filter(x => x.contrib > 0).reduce((s, x) => s + x.contrib, 0);
  const neg = rows.filter(x => x.contrib < 0).reduce((s, x) => s + x.contrib, 0);
  const missingN = rows.filter(x => x.missing).length;
  console.log('  ' + '-'.repeat(78));
  console.log('  推向 AI 合计 +' + fmt(pos) + '　推向人写合计 ' + fmt(neg) +
    '　截距 ' + fmt(model.intercept || 0) + '　→ z=' + fmt(zSum));
  if (missingN) console.log('  有 ' + missingN + ' 项因文本过短未计算，按均值处理（贡献 0）');
}

/* ---------------- 主 ---------------- */

let files = [];
targets.forEach(t => { files = files.concat(collect(t)); });
if (!files.length) process.exit(1);

console.log('\n  玄武 · 单项解释' + (SUMMARY ? '（汇总模式）' : ''));
if (!SUMMARY) console.log('  模型：' + (model ? 'model.json，' + (model.features || []).length + ' 项特征' +
  (model.metrics && model.metrics.cvAccuracy != null ? '，CV ' + (model.metrics.cvAccuracy * 100).toFixed(1) + '%' : '')
  : '无'));

files.forEach(explainOne);
console.log('');
