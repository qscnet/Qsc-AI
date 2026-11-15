#!/usr/bin/env node
/*!
 * 玄武 · 外部验证
 *
 * 拿一批**没有参与训练**的文本，测 model.json 在它们身上的准确率。
 * 这是唯一能回答"到底能不能泛化"的办法——内部交叉验证永远偏乐观。
 *
 * 用法：
 *   node eval.js --ai  "seed/ai-test" --human "seed/human-test"
 *   node eval.js --ai  "seed/ai-test/豆包-02.txt" --human "seed/human-test/某书片段.txt"
 *   node eval.js --ai ... --human ... --model model.json --json
 *
 * 目录下所有 .txt 都会被读；单个文件里可用 ===== 分隔多段。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AN = require('./assets/engine.js');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v && v.indexOf('--') !== 0) ? v : true;
}
const AI_ARG = arg('ai', null);
const HU_ARG = arg('human', null);
const AI_FILTER = arg('ai-filter', null);
const HU_FILTER = arg('human-filter', null);
const MODEL_FILE = String(arg('model', path.join(__dirname, 'model.json')));
const AS_JSON = !!arg('json', false);

if (!AI_ARG && !HU_ARG) {
  console.error('\n  用法：node eval.js --ai <目录或文件> --human <目录或文件>\n');
  process.exit(1);
}

/* ---------------- 读文本 ---------------- */

function readAny(file) {
  const buf = fs.readFileSync(file);
  let t = buf.toString('utf8');
  if (t.indexOf('\uFFFD') >= 0) {
    try { t = new TextDecoder('gbk', { fatal: false }).decode(buf); } catch (e) { /* keep */ }
  }
  return t.replace(/\r\n?/g, '\n');
}

function gather(p, filter) {
  const out = [];
  if (!p) return out;
  const full = path.resolve(String(p));
  if (!fs.existsSync(full)) { console.log('  ! 找不到 ' + full); return out; }
  const stat = fs.statSync(full);
  const re = filter ? new RegExp(String(filter)) : null;
  if (stat.isDirectory()) {
    fs.readdirSync(full).filter(f => /\.(txt|md)$/i.test(f)).filter(f => !re || re.test(f)).sort().forEach(f => {
      readAny(path.join(full, f)).split(/\n\s*={3,}\s*\n/)
        .map(s => s.trim()).filter(s => s.length > 300)
        .forEach(s => out.push({ text: s, from: f }));
    });
  } else {
    readAny(full).split(/\n\s*={3,}\s*\n/)
      .map(s => s.trim()).filter(s => s.length > 300)
      .forEach((s, i) => out.push({ text: s, from: path.basename(full) + '#' + (i + 1) }));
  }
  return out;
}

/* ---------------- 加载模型 ---------------- */

let model = null;
try {
  model = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
  if (model.demo) { console.log('  ! model.json 是演示模型，忽略'); model = null; }
} catch (e) { model = null; }

if (!model) {
  console.log('\n  ! 没有可用的 model.json，改用规则引擎（未校准的人工权重）');
}

/* ---------------- 打分 ---------------- */

function score(list) {
  const out = [];
  list.forEach(it => {
    try {
      const opts = { maxChars: 8000 };
      if (model) opts.model = model;
      const r = AN.analyze(it.text, opts);
      out.push({ score: r.score, verdict: r.verdict.key, from: it.from, chars: r.text.cjk });
    } catch (e) {
      out.push({ score: null, error: e.message, from: it.from });
    }
  });
  return out.filter(x => x.score !== null);
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const fmt = v => (Math.round(v * 10) / 10).toString();

const aiRes = score(gather(AI_ARG, AI_FILTER));
const huRes = score(gather(HU_ARG, HU_FILTER));

/* ---------------- 输出 ---------------- */

if (AS_JSON) {
  console.log(JSON.stringify({ model: model ? { trainedAt: model.trainedAt, metrics: model.metrics } : null, ai: aiRes, human: huRes }, null, 2));
  process.exit(0);
}

console.log('\n  玄武 · 外部验证');
console.log('  ' + '-'.repeat(56));
console.log('  模型：' + (model ? 'model.json（训练于 ' + (model.trainedAt || '') + '）' : '无（用规则引擎）'));

function line(label, res) {
  if (!res.length) return;
  const s = res.map(x => x.score).sort((a, b) => a - b);
  console.log('  ' + label + '：' + res.length + ' 条，平均 ' + fmt(mean(s)) +
    '，最低 ' + s[0] + '，最高 ' + s[s.length - 1]);
}
line('AI 样本  ', aiRes);
line('真人样本', huRes);

const all = aiRes.map(x => ({ ...x, isAi: true })).concat(huRes.map(x => ({ ...x, isAi: false })));
if (all.length) {
  const thr = 50;   // 40 分是"疑似"线，用 50 作为判定中点
  const correct = all.filter(x => (x.score >= thr) === x.isAi).length;
  const acc = correct / all.length * 100;
  console.log('');
  console.log('  阈值 ' + thr + ' 判定准确率：' + Math.round(acc * 10) / 10 + '%（' + correct + '/' + all.length + '）');

  if (aiRes.length && huRes.length) {
    let wins = 0, total = 0;
    aiRes.forEach(a => huRes.forEach(h => { total++; wins += a.score > h.score ? 1 : (a.score === h.score ? 0.5 : 0); }));
    console.log('  AUC：' + (Math.round(wins / total * 1000) / 1000));
  }

  const wrong = all.filter(x => (x.score >= thr) !== x.isAi);
  if (wrong.length) {
    console.log('');
    console.log('  判错的 ' + wrong.length + ' 条：');
    wrong.slice(0, 10).forEach(x => {
      console.log('    ' + (x.isAi ? '[AI  ]' : '[真人]') + ' ' + x.score + ' 分  ' + x.from);
    });
  }
}
console.log('');
