#!/usr/bin/env node
/*!
 * 玄武 · 校准脚本
 *
 * 干的活：把 samples.jsonl 里你标过「AI 写的 / 人写的」的样本，拿去重新学习
 * 46/55 项特征的锚点（人类均值、AI 均值）和权重（区分度），写进 calibration.json。
 *
 * 用法：
 *   node calibrate.js              读样本、训练、评估、写 calibration.json
 *   node calibrate.js --dry        只看结果，不写文件
 *   node calibrate.js --min 20     每类至少 20 条才训练（默认 8）
 *   node calibrate.js --cv 5       5 折交叉验证（默认用 20% 留出法）
 *
 * 判据是 Cohen's d（两类均值差 ÷ 合并标准差）：
 *   d >= 0.8 区分度很强，d 0.5～0.8 中等，d < 0.25 基本是噪声，直接权重降到 0。
 * 所以它不会"记住"样本，只会调整每个特征该有多敏感——仍然可解释。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const AN = require('./assets/engine.js');

const ROOT = __dirname;
const SAMPLES = path.join(ROOT, 'samples.jsonl');
const OUT = path.join(ROOT, 'calibration.json');
const BASELINE = path.join(ROOT, 'calibration.baseline.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const MIN = Number((argv[argv.indexOf('--min') + 1] && argv.indexOf('--min') >= 0) ? argv[argv.indexOf('--min') + 1] : 8) || 8;
const FOLDS = Number((argv[argv.indexOf('--cv') + 1] && argv.indexOf('--cv') >= 0) ? argv[argv.indexOf('--cv') + 1] : 0) || 0;

/* ---------------- 读样本 ---------------- */

function loadSamples() {
  if (!fs.existsSync(SAMPLES)) {
    console.error('\n  找不到 samples.jsonl。\n');
    console.error('  先做这一步：用网页检测后点「这是 AI 写的」或「这是人写的」标 20 条以上，');
    console.error('  或者在 API 里调 POST /api/v1/feedback 提交标签。\n');
    process.exit(1);
  }
  const lines = fs.readFileSync(SAMPLES, 'utf8').split(/\r?\n/).filter(Boolean);
  const out = [];
  let bad = 0;
  for (const line of lines) {
    try {
      const s = JSON.parse(line);
      if (!s || !s.label || !s.features) { bad++; continue; }
      if (s.label !== 'ai' && s.label !== 'human') continue;
      out.push(s);
    } catch (e) { bad++; }
  }
  return { samples: out, bad };
}

/* ---------------- 统计 ---------------- */

const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
const sd = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 语义方向由设计锁定的特征（不跟随数据翻转）
const LOCKED_DIR = {
  // 无实体句越多（纯气氛/心理，没有具体物、数字、对白）越像概述式生成
  n_setupRatio: 'up',
  // 抽象词占比越高越像模型腔（大道/命运/气息是模型的空壳词）
  n_abstractRatio: 'up',
  // 直接引语越少（讲多于演）越像概述式生成
  n_directRatio: 'down'
};
const round = (v, d = 4) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);

/** 用训练集学一套校准参数 */
function fit(samples) {
  const ai = samples.filter(s => s.label === 'ai');
  const human = samples.filter(s => s.label === 'human');
  const features = {};
  const report = [];

  for (const def of AN.featureDefs) {
    const hv = [], av = [];
    for (const s of human) { const v = s.features[def.id]; if (typeof v === 'number' && !isNaN(v)) hv.push(v); }
    for (const s of ai) { const v = s.features[def.id]; if (typeof v === 'number' && !isNaN(v)) av.push(v); }

    if (hv.length < MIN || av.length < MIN) {
      report.push({ id: def.id, name: def.name, status: '样本不足', d: null, w: null });
      continue;
    }

    const mh = mean(hv), ma = mean(av);
    const sh = sd(hv), sa = sd(av);
    const pooled = Math.sqrt((sh * sh + sa * sa) / 2) || 1e-6;
    const diff = ma - mh;
    const d = Math.abs(diff) / pooled;

    // 语病这类特征只服务「通顺度」，不参与「像不像 AI」打分。
    // 原因：真人网文比 AI 文本更容易有语病，校准会学成"越干净越像 AI"，
    // 于是精心校对的稿子反而被扣分。语病交给通顺度那条绝对线去管。
    if (def.dim === 'grammar') {
      features[def.id] = { dir: 'up', h: round(mh), a: round(ma), w: 0 };
      report.push({ id: def.id, name: def.name, status: '语病项，不计入 AI 分', d: round(d, 2), w: 0 });
      continue;
    }

    // 语义方向明确的特征：方向由设计决定，不允许语料构成把它翻过来。
    // 样本只有一百多条、来源五六个，方向很容易被"哪一侧碰巧对白多"带反。
    const LOCKED = LOCKED_DIR[def.id];
    if (LOCKED) {
      const conflict = (LOCKED === 'up' ? diff < 0 : diff > 0);
      if (conflict) {
        // 先验和数据打架：不用它，而不是让它朝反方向推
        features[def.id] = { dir: LOCKED, h: round(mh), a: round(ma), w: 0 };
        report.push({ id: def.id, name: def.name, status: '方向与数据冲突，已关闭', d: round(d, 2), w: 0 });
        continue;
      }
    }

    // 区分度太低就关掉这个特征，别让它制造噪声
    if (d < 0.25) {
      features[def.id] = { dir: diff >= 0 ? 'up' : 'down', h: round(mh), a: round(ma), w: 0 };
      report.push({ id: def.id, name: def.name, status: '噪声，已关闭', d: round(d, 2), w: 0 });
      continue;
    }

    const dir = LOCKED || (diff >= 0 ? 'up' : 'down');
    // 锚点别贴得太死：往对方方向让 20% 的标准差，给中间地带留缓冲
    const slack = pooled * 0.2;
    const h = dir === 'up' ? mh + slack : mh - slack;
    const a = dir === 'up' ? ma - slack : ma + slack;

    const w = clamp(d, 0.3, 2.5);
    features[def.id] = { dir, h: round(h), a: round(a), w: round(w, 2) };
    report.push({ id: def.id, name: def.name, status: '已校准', d: round(d, 2), w: round(w, 2), h: round(h), a: round(a) });
  }

  // 权重归一化：让有效特征的权重乘数平均为 1，保持总分尺度不变
  const active = Object.keys(features).filter(k => features[k].w > 0);
  if (active.length) {
    const avg = mean(active.map(k => features[k].w));
    if (avg > 0) for (const k of active) features[k].w = round(features[k].w / avg, 3);
  }

  return { features, report, counts: { ai: ai.length, human: human.length } };
}

/* ---------------- 评估 ---------------- */

function auc(pairs) {
  // pairs: [{score, isAi}]
  const pos = pairs.filter(p => p.isAi).map(p => p.score);
  const neg = pairs.filter(p => !p.isAi).map(p => p.score);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : (a === b ? 0.5 : 0);
  return wins / (pos.length * neg.length);
}

function evaluate(samples, calibration) {
  const pairs = [];
  for (const s of samples) {
    let sc;
    if (calibration === null) {
      // 基线：不清算，用默认锚点
      sc = AN.scoreFromFeatures(s.features, null).score;
    } else {
      sc = AN.scoreFromFeatures(s.features, calibration).score;
    }
    pairs.push({ score: sc, isAi: s.label === 'ai' });
  }
  const at50 = pairs.filter(p => (p.score >= 50) === p.isAi).length / Math.max(pairs.length, 1);
  const pos = pairs.filter(p => p.isAi), neg = pairs.filter(p => !p.isAi);
  const avgAi = pos.length ? mean(pos.map(p => p.score)) : 0;
  const avgHu = neg.length ? mean(neg.map(p => p.score)) : 0;

  // 找一个最优阈值
  let best = { t: 50, acc: at50 };
  for (let t = 20; t <= 80; t += 1) {
    const acc = pairs.filter(p => (p.score >= t) === p.isAi).length / Math.max(pairs.length, 1);
    if (acc > best.acc) best = { t, acc };
  }

  return {
    n: pairs.length,
    acc50: round(at50 * 100, 1),
    bestThreshold: best.t,
    bestAcc: round(best.acc * 100, 1),
    auc: auc(pairs) === null ? null : round(auc(pairs), 3),
    avgAi: round(avgAi, 1),
    avgHuman: round(avgHu, 1)
  };
}

/** k 折交叉验证：杜绝"自己考自己" */
function crossValidate(samples, k) {
  const foldSize = Math.ceil(samples.length / k);
  const results = [];
  for (let i = 0; i < k; i++) {
    const test = samples.slice(i * foldSize, (i + 1) * foldSize);
    const train = samples.filter((_, idx) => idx < i * foldSize || idx >= (i + 1) * foldSize);
    if (!test.length || !train.length) continue;
    const { features } = fit(train);
    results.push(evaluate(test, { features }));
  }
  const avg = key => round(mean(results.map(r => r[key])), 1);
  return { folds: k, acc50: avg('acc50'), bestAcc: avg('bestAcc'), auc: round(mean(results.map(r => r.auc || 0)), 3) };
}

/* ---------------- 主流程 ---------------- */

/* ---------------- 留出集 / 分数映射 ---------------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** 分层留出：两类各留 ratio，避免留出集里只有一类（样本文件是按类排的） */
function stratifiedSplit(samples, ratio) {
  const ai = shuffle(samples.filter(s => s.label === 'ai'));
  const hu = shuffle(samples.filter(s => s.label === 'human'));
  const nAi = Math.max(1, Math.round(ai.length * ratio));
  const nHu = Math.max(1, Math.round(hu.length * ratio));
  // 训练集每类至少要剩 3 条，否则不切
  if (ai.length - nAi < 3 || hu.length - nHu < 3) {
    return { test: samples.slice(), train: samples.slice() };
  }
  return {
    test: ai.slice(0, nAi).concat(hu.slice(0, nHu)),
    train: ai.slice(nAi).concat(hu.slice(nHu))
  };
}

/**
 * 校准后 rawScore 的整体位置会平移，0-100 的映射必须跟着重定：
 * 人类样本的 rawScore 均值 → 20 分，AI 样本 → 78 分。
 */
function computeScoreMap(sampleList, cal) {
  const aiR = [], huR = [];
  sampleList.forEach(s => {
    try {
      const r = AN.scoreFromFeatures(s.features, cal).rawScore;
      (s.label === 'ai' ? aiR : huR).push(r);
    } catch (e) { /* 跳过 */ }
  });
  if (!aiR.length || !huR.length) return null;
  return { h: round(mean(huR), 4), a: round(mean(aiR), 4) };
}

function main() {
  const { samples, bad } = loadSamples();
  const counts = {
    ai: samples.filter(s => s.label === 'ai').length,
    human: samples.filter(s => s.label === 'human').length
  };

  console.log('\n  玄武 · 校准\n  ' + '-'.repeat(52));
  console.log('  样本：AI ' + counts.ai + ' 条，人类 ' + counts.human + ' 条' + (bad ? '（跳过损坏行 ' + bad + '）' : ''));

  if (counts.ai < MIN || counts.human < MIN) {
    console.log('\n  样本还不够：每类至少 ' + MIN + ' 条才能训练。');
    console.log('  现在 AI ' + counts.ai + ' / 人类 ' + counts.human + '，点网页上的反馈按钮继续标。\n');
    process.exit(1);
  }

  // 1. 分层留出评估：打乱 + 每类各留 20%
  //    不能直接切前 N 条——样本文件里 AI 全写在前面，切出来会全是同一类
  const holdout = stratifiedSplit(samples, 0.2);
  const test = holdout.test;
  const train = holdout.train;
  const fitTrain = fit(train);
  const calTrain = { features: fitTrain.features };
  calTrain.scoreMap = computeScoreMap(train, calTrain);
  const before = evaluate(test, null);
  const after = evaluate(test, calTrain);

  const tAi = test.filter(s => s.label === 'ai').length;
  console.log('\n  留出集（' + test.length + ' 条：AI ' + tAi + ' / 人 ' + (test.length - tAi) + '，未参与训练）：');
  console.log('    校准前  准确率 ' + before.acc50 + '%   AUC ' + before.auc + '   平均分 AI ' + before.avgAi + ' / 人 ' + before.avgHuman);
  console.log('    校准后  准确率 ' + after.acc50 + '%   AUC ' + after.auc + '   平均分 AI ' + after.avgAi + ' / 人 ' + after.avgHuman);
  console.log('    提升    ' + round(after.acc50 - before.acc50, 1) + ' 个百分点（最优阈值 ' + after.bestThreshold + '，准确率 ' + after.bestAcc + '%）');

  if (FOLDS >= 2) {
    const cv = crossValidate(samples, FOLDS);
    console.log('\n  ' + FOLDS + ' 折交叉验证：准确率 ' + cv.acc50 + '%（最优阈值口径 ' + cv.bestAcc + '%），AUC ' + cv.auc);
    console.log('  这个数字比上面的留出法更可信，对外宣传请用这个。');
  }

  // 2. 用全部样本训练最终参数
  const finalFit = fit(samples);
  const all = evaluate(samples, { features: finalFit.features });
  console.log('\n  全量自评（仅供参考，有自欺风险）：准确率 ' + all.acc50 + '%   AUC ' + all.auc);

  // 3. 区分度排行
  const usable = finalFit.report.filter(r => r.status === '已校准').sort((a, b) => b.d - a.d);
  const noise = finalFit.report.filter(r => r.status !== '已校准');
  console.log('\n  区分度最强的前 8 项：');
  usable.slice(0, 8).forEach((r, i) => {
    console.log('    ' + (i + 1) + '. ' + r.name.padEnd(12, '　') + ' d=' + r.d + '  w=' + r.w);
  });
  if (noise.length) {
    console.log('\n  被关闭的噪声特征（' + noise.length + ' 项）：' + noise.map(r => r.name).join('、'));
  }

  const calibration = {
    version: AN.version,
    createdAt: new Date().toISOString(),
    sampleCount: samples.length,
    counts: finalFit.counts,
    method: 'cohen-d anchors',
    features: finalFit.features
  };

  // 重定 0-100 的映射锚点，否则校准后整体分数会偏移（真人文被判成"疑似AI"）
  const sm = computeScoreMap(samples, calibration);
  if (sm) {
    calibration.scoreMap = sm;
    console.log('\n  分数映射：人类均值 ' + sm.h + ' → 20 分，AI 均值 ' + sm.a + ' → 78 分');
  } else {
    console.log('\n  ! 样本不足，无法重定分数映射，沿用默认映射');
  }

  if (DRY) {
    console.log('\n  --dry 模式，没有写文件。\n');
    return;
  }

  // 备份旧校准
  if (fs.existsSync(OUT)) {
    try { fs.copyFileSync(OUT, BASELINE); } catch (e) { /* 忽略 */ }
  }
  fs.writeFileSync(OUT, JSON.stringify(calibration, null, 2), 'utf8');
  console.log('\n  已写入 calibration.json（' + Object.keys(calibration.features).length + ' 项特征）。');
  console.log('  重启 node server.js 生效；网页从服务端打开时会自动加载。');
  console.log('  想回滚：把 calibration.baseline.json 改回 calibration.json，或删掉 calibration.json。\n');
}

main();
