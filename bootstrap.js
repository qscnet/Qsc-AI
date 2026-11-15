#!/usr/bin/env node
/*!
 * 玄武 · 种子数据构建
 *
 * 干三件事：
 *   1. 读 seed/ai-samples.txt（模型生成的同题材片段），切成样本
 *   2. 读一本 AI 盛行前的真人小说（默认遮天），按章均匀抽段，切成样本
 *   3. 用引擎算出每条样本的 57 维特征，直接追加到 samples.jsonl
 *
 * 全程不需要启动服务，也不需要打标签——标签就是文件夹。
 *
 * 用法：
 *   node bootstrap.js                  # 用默认参数跑
 *   node bootstrap.js --dry            # 只统计，不写文件
 *   node bootstrap.js --human 40       # 从小说里抽 40 段
 *   node bootstrap.js --chunk 1500     # 每段 1500 字
 *   node bootstrap.js --novel "D:\其他小说.txt"
 *   node bootstrap.js --reset          # 清空 samples.jsonl 重来
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AN = require('./assets/engine.js');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'samples.jsonl');
const AI_FILE = path.join(ROOT, 'seed', 'ai-samples.txt');
const AI_DIR = path.join(ROOT, 'seed', 'ai');

/* 清掉模型爱加的客套话和 markdown */
function cleanGenerated(t) {
  let s = String(t).replace(/\r\n?/g, '\n');
  s = s.replace(/^\s*#{1,6}\s*/gm, '');          // markdown 标题
  s = s.replace(/\*\*/g, '').replace(/^---+$/gm, '');
  s = s.replace(/^(好的|当然|以下是|下面是|这是)[^\n]{0,40}\n+/i, '');  // 开场客套
  s = s.replace(/^\s*(正文|小说正文)[:：]\s*/i, '');
  return s.trim();
}

/** AI 样本：seed/ai-samples.txt + seed/ai/*.txt（每个文件一段，或用 ===== 分多段） */
function loadAiTexts(limit) {
  const out = [];
  if (fs.existsSync(AI_FILE)) {
    splitAi(readText(AI_FILE)).forEach((t, i) => out.push({ text: t, src: 'ai-samples.txt#' + (i + 1) }));
  }
  if (fs.existsSync(AI_DIR)) {
    fs.readdirSync(AI_DIR).filter(f => /\.txt$/i.test(f)).sort().forEach(f => {
      const parts = splitAi(readText(path.join(AI_DIR, f)));
      parts.forEach((t, i) => out.push({
        text: t,
        src: f.replace(/\.txt$/i, '') + (parts.length > 1 ? '#' + (i + 1) : '')
      }));
    });
  }
  return out.slice(0, limit);
}
const CAL_FILE = path.join(ROOT, 'calibration.json');
// 真人样本来源。
// 一个作者一本书 = 一个"作者指纹"，全用同一人的书，训出来的只是"作者鉴定"。
// 所以这里至少要有 2 个不同作者，题材还得和 AI 样本对得上（都是玄幻/仙侠）。
//
// 可选素材（F:\BaiduNetdiskDownload）：
//   遮天 (辰东)             玄幻
//   圣墟 (辰东)             玄幻  ← 同作者，加了只增流量不增多样性
//   大奉打更人 (卖报小郎君) 仙侠  ← 不同作者、同题材，最有价值
//   大秦帝国 (孙皓晖)       历史  ← 题材不匹配，加了会引入"历史词汇=人写"的泄漏
const DEFAULT_BOOKS = [
  { path: 'F:\\BaiduNetdiskDownload\\遮天 (辰东) (z-library.sk, 1lib.sk, z-lib.sk).txt', n: 14, tag: '辰东·玄幻' },
  { path: 'F:\\BaiduNetdiskDownload\\大奉打更人 (卖报小郎君).txt', n: 12, tag: '卖报小郎君·仙侠' },
  { path: 'F:\\BaiduNetdiskDownload\\最强弃少 (鹅是老五) .txt', n: 10, tag: '鹅是老五·都市修真' },
  // 倪匡《卫斯理》：对话流、第一人称、短段落。专治"对话密集被误判成 AI"。
  // 由 clean-corpus.js 从 F:\小说\小说资源\卫斯理全集 合并而来（155 个文件）。
  // 注意：加了它之后，《卫斯理》不再是独立测试集，原振侠系列继续留作测试。
  { path: 'E:\\qsc\\玄武AI检测\\seed\\raw\\倪匡-clean\\卫斯理-合本.txt', n: 12, tag: '倪匡·科幻对话流' },
  // 原振侠（奇数册）：现代都市背景 + 对白密集，补"现代短句对白流"这一档。
  // 偶数册留在 seed\test\原振侠 做测试，验证是真学会还是背下来。
  { path: 'E:\\qsc\\玄武AI检测\\seed\\raw\\原振侠-clean\\原振侠-训练.txt', n: 10, tag: '倪匡·现代都市对白' },
  // 步征《龙皇武神》：对话流都市玄幻，专门补"对话密集被误判"的盲区。
  // 由 clean-corpus.js 从手动摘录的章节清洗合并而来，文件不存在时自动跳过。
  { path: 'E:\\qsc\\玄武AI检测\\seed\\raw\\步征-clean\\龙皇武神-摘录.txt', n: 8, tag: '步征·都市玄幻' }
];
const novelArg = arg('novel', null);
const BOOKS = novelArg ? [{ path: String(novelArg) }] : DEFAULT_BOOKS;

// 有校准就用校准后的锚点算分，这样 --dry 报的区分度反映的是真实线上效果
let CAL = null;
try { CAL = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')); } catch (e) { CAL = null; }

/* ---------------- 参数 ---------------- */

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return (v && v.indexOf('--') !== 0) ? v : true;
}
const AI_COUNT = Number(arg('ai', 80)) || 80;
const HUMAN_COUNT = Number(arg('human', 30)) || 30;
// 1800 字：实测比 900 字稳定得多（真人书段落级误报 14.1% → 2.8%）
const CHUNK = Number(arg('chunk', 1800)) || 1800;
const DRY = !!arg('dry', false);
const RESET = !!arg('reset', false);

/* ---------------- 读取（自动识别 GBK） ---------------- */

function readText(file) {
  const buf = fs.readFileSync(file);
  let txt = buf.toString('utf8');
  if (txt.indexOf('\uFFFD') >= 0) {
    try {
      txt = new TextDecoder('gbk', { fatal: false }).decode(buf);
    } catch (e) {
      throw new Error(
        '这个文件不是 UTF-8，而且当前 Node 不支持 GBK 解码。\n' +
        '  办法一：用记事本打开另存为 UTF-8\n' +
        '  办法二：升级到 Node 18+（自带完整 ICU）'
      );
    }
  }
  return txt.replace(/\r\n?/g, '\n');
}

const hash = t => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);

/* ---------------- 切样本 ---------------- */

/** AI 样本：按 ===== 分隔（也兼容整篇不分的文件） */
function splitAi(text) {
  return text.split(/\n\s*={3,}\s*\n/)
    .map(s => cleanGenerated(s))
    .filter(s => s.length > 300);
}

/** 真人样本：按章切开，均匀抽 N 段 */
function splitHuman(text, count, size) {
  const marks = [];
  const re = /第[零〇一二三四五六七八九十百千万两0-9]{1,9}章/g;
  let m;
  while ((m = re.exec(text)) !== null) marks.push(m.index);

  // 没有章节标记就整本按长度切
  if (marks.length < 5) {
    const out = [];
    const step = Math.floor(text.length / count);
    for (let i = 0; i < count; i++) {
      const start = i * step + Math.floor(step * 0.3);
      out.push(text.slice(start, start + size));
    }
    return out.filter(s => s.trim().length > 200);
  }

  // 均匀分布到全书，避免只抽到开篇
  const per = Math.max(1, Math.floor(marks.length / count));
  const out = [];
  for (let k = 0; k < marks.length && out.length < count; k += per) {
    const start = marks[k];
    const end = (k + 1 < marks.length) ? marks[k + 1] : text.length;
    const chap = text.slice(start, end);
    if (chap.length < size * 1.4) continue;

    // 从章节 1/3 处开始取，避开标题和上一章残留
    let s = start + Math.floor(chap.length * 0.33);
    let seg = text.slice(s, s + size);

    // 对齐到段落边界：去掉开头的半句和结尾的半句
    const nl1 = seg.indexOf('\n');
    if (nl1 > 0 && nl1 < 120) seg = seg.slice(nl1 + 1);
    const nl2 = seg.lastIndexOf('\n');
    if (nl2 > seg.length - 120 && nl2 > 200) seg = seg.slice(0, nl2);

    seg = seg.trim();
    if (seg.replace(/\s/g, '').length > 300) out.push(seg);
  }
  return out;
}

/* ---------------- 转成样本 ---------------- */

function buildRecord(text, label, source) {
  const opts = { maxChars: 8000 };
  if (CAL) opts.calibration = CAL;
  const r = AN.analyze(text, opts);
  const features = {};
  (r.features || []).forEach(f => {
    if (!f.skipped && typeof f.value === 'number') features[f.id] = f.value;
  });
  if (Object.keys(features).length < 20) return null;

  const rec = {
    id: 'seed_' + hash(text).slice(0, 8),
    ts: new Date().toISOString(),
    label: label,
    hash: hash(text),
    score: r.score,
    verdict: r.verdict ? r.verdict.key : '',
    chars: r.text.cjk,
    source: source,
    note: 'bootstrap.js 种子样本',
    features: features
  };
  if (process.env.STORE_TEXT !== '0') rec.text = text.slice(0, 5000);
  return rec;
}

/* ---------------- 主流程 ---------------- */

function main() {
  console.log('\n  玄武 · 种子数据构建');
  console.log('  ' + '-'.repeat(52));

  if (DRY) console.log('  【--dry】只统计，不写文件');
  console.log('  校准状态：' + (CAL ? '已加载 calibration.json（用校准后的锚点算分）' : '未校准（用默认锚点）'));

  // 已存在的 hash，避免重复
  const seen = new Set();
  let existing = 0;
  if (fs.existsSync(OUT) && !RESET) {
    fs.readFileSync(OUT, 'utf8').split(/\r?\n/).forEach(line => {
      if (!line.trim()) return;
      existing++;
      try { const s = JSON.parse(line); if (s.hash) seen.add(s.hash); } catch (e) { /* ignore */ }
    });
    if (existing) console.log('  已有样本 ' + existing + ' 条，会去重追加');
  }

  const records = [];
  const stats = { ai: [], human: [] };

  /* ---- AI 类 ---- */
  const aiTexts = loadAiTexts(AI_COUNT);
  if (!aiTexts.length) {
    console.log('  ! AI 样本为空：把模型生成的片段放进 seed/ai/ 目录（一个 .txt 一段）');
  } else {
    console.log('  AI 样本：' + aiTexts.length + ' 段');
    const srcCount = {};
    aiTexts.forEach(it => {
      const rec = buildRecord(it.text, 'ai', it.src);
      if (rec) { records.push(rec); stats.ai.push(rec.score); }
      const model = String(it.src).split('-')[0].split('#')[0];
      srcCount[model] = (srcCount[model] || 0) + 1;
    });
    const names = Object.keys(srcCount);
    console.log('    来源：' + names.map(n => n + ' ' + srcCount[n]).join('、'));
    if (names.length < 2) {
      console.log('    ! 只有 1 个来源，模型会学成"这个模型的风格"。至少要 3 个不同模型。');
    }
  }

  /* ---- 真人小说（可多本，各自指定名额） ---- */
  const usable = BOOKS.filter(b => fs.existsSync(b.path || b));
  if (!usable.length) {
    console.log('  ! 一本真人小说都没找到');
    BOOKS.forEach(b => console.log('    ' + (b.path || b)));
    console.log('    用 --novel "路径" 指定单本，或改 bootstrap.js 里的 DEFAULT_BOOKS');
  } else {
    usable.forEach((b, bi) => {
      const file = b.path || b;
      try {
        const novel = readText(file);
        const want = b.n || Math.max(1, Math.round(HUMAN_COUNT / usable.length));
        const list = splitHuman(novel, want, CHUNK);
        console.log('  真人样本：' + path.basename(file).replace(/\.txt$/i, '') +
          (b.tag ? '（' + b.tag + '）' : '') + '，' + novel.length.toLocaleString() +
          ' 字 → 抽 ' + list.length + ' 段');
        list.forEach((t, i) => {
          const rec = buildRecord(t, 'human', (b.tag || ('book' + (bi + 1))) + '-' + (i + 1));
          if (rec) { records.push(rec); stats.human.push(rec.score); }
        });
      } catch (e) {
        console.log('  ! ' + path.basename(file) + ' 读取失败：' + e.message);
      }
    });
  }

  /* ---- 写入 ---- */
  const fresh = records.filter(r => !seen.has(r.hash));
  const dup = records.length - fresh.length;

  if (RESET && !DRY) {
    // 只清种子样本，人工复核过的（source=correct）必须留着——
    // 那是内测员一条条点出来的，比种子数据金贵得多。
    let keep = [];
    try {
      keep = fs.readFileSync(OUT, 'utf8').split(/\r?\n/).filter(l => {
        if (!l.trim()) return false;
        try { return JSON.parse(l).source === 'correct'; } catch (e) { return false; }
      });
    } catch (e) { keep = []; }
    fs.writeFileSync(OUT, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
    console.log('  已清空种子样本' + (keep.length ? '，保留人工复核样本 ' + keep.length + ' 条' : ''));
    keep.forEach(l => { try { const s = JSON.parse(l); if (s.hash) seen.add(s.hash); } catch (e) { /* 忽略 */ } });
  }
  // 重置后重新算一次"要跳过的"，避免把保留的人工样本又写一遍
  const freshFinal = records.filter(r => !seen.has(r.hash));
  if (!DRY && freshFinal.length) {
    fs.appendFileSync(OUT, freshFinal.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }

  /* ---- 汇总 ---- */
  const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
  const aiAvg = avg(stats.ai), huAvg = avg(stats.human);

  console.log('\n  ' + '-'.repeat(52));
  console.log('  写入 ' + (DRY ? 0 : fresh.length) + ' 条' + (dup ? '（跳过重复 ' + dup + ' 条）' : ''));
  console.log('');
  console.log('  AI 样本   ' + stats.ai.length + ' 条，平均分 ' + aiAvg);
  console.log('  真人样本  ' + stats.human.length + ' 条，平均分 ' + huAvg);
  console.log('  区分度    ' + (aiAvg - huAvg) + ' 分' +
    (aiAvg - huAvg < 15 ? '  ← 偏小，说明引擎对这个题材分辨力不足' : '  ← 正常'));
  console.log('');

  if (DRY) {
    console.log('  --dry 模式，没有写文件。去掉 --dry 再跑一次。\n');
    return;
  }
  let total = 0;
  try { total = fs.readFileSync(OUT, 'utf8').split(/\r?\n/).filter(l => l.trim()).length; } catch (e) { total = 0; }
  console.log('  现在 samples.jsonl 共 ' + total + ' 条。');
  console.log('  下一步：python train.py\n');
}

main();
