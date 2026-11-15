#!/usr/bin/env node
/*!
 * 玄武 · 语料清洗
 *
 * 把手动复制/摘录的章节文本洗干净，变成可以喂给训练的语料。
 * 专治：笔记 App 的元数据、网站广告、"本章未完"、全角空格、GBK 编码。
 *
 * 用法：
 *   node clean-corpus.js --in "F:\某目录" --out "seed\raw\步征"
 *   node clean-corpus.js --in 第一章.txt 第二章.txt --out "seed\raw\步征"
 *   node clean-corpus.js --in "F:\某目录" --merge "步征-全本.txt"
 *
 * 参数：
 *   --in      输入：目录或若干文件（必需）
 *   --out     输出目录（默认 seed\raw\cleaned）
 *   --merge   额外输出一个合并文件
 *   --min     丢掉少于多少字的片段（默认 300）
 *   --dry     只统计不写文件
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------------- 参数 ---------------- */

const VALUE_FLAGS = ['in', 'out', 'merge', 'min'];
const inputs = [];
let outDir = null, mergeTo = null, minChars = 300, dry = false;

{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') { dry = true; continue; }
    if (a.indexOf('--') === 0) {
      const name = a.slice(2);
      const val = argv[i + 1];
      if (VALUE_FLAGS.indexOf(name) >= 0) {
        i++;
        if (name === 'out') outDir = val;
        else if (name === 'merge') mergeTo = val;
        else if (name === 'min') minChars = Number(val) || 300;
        else if (name === 'in') inputs.push(val);
      }
      continue;
    }
    inputs.push(a);
  }
}

if (!inputs.length) {
  console.error('\n  用法：node clean-corpus.js --in <目录或文件...> [--out 目录] [--merge 文件名]\n');
  process.exit(1);
}

outDir = outDir || path.join(__dirname, 'seed', 'raw', 'cleaned');

/* ---------------- 读文本（自动识别 GBK） ---------------- */

function readAny(file) {
  const buf = fs.readFileSync(file);
  let t = buf.toString('utf8');
  if (t.indexOf('\uFFFD') >= 0) {
    try { t = new TextDecoder('gbk', { fatal: false }).decode(buf); } catch (e) { /* keep */ }
  }
  return t.replace(/\r\n?/g, '\n');
}

/* ---------------- 清洗规则 ---------------- */

// 网站/App 的垃圾行
const JUNK = [
  /本章未完[，,]?点击下一页继续阅读/,
  /请收藏本站|加入书签|返回目录|上一章|下一章|章节目录/,
  /最新网址|最新章节|全文阅读|无弹窗|手机版阅读|手机用户请浏览/,
  /https?:\/\/|www\.|\.com|\.net|\.org|\.cc|\.la|\.me\b/i,
  /^\s*(?:第\s*\d+\s*[\/／]\s*\d+\s*页|Page\s*\d+)\s*$/i,
  /^\s*[-=*_—]{3,}\s*$/,
  /^\s*\d{1,4}\s*$/,
  /^.{0,6}(微信|公众号|QQ群|书友群).{0,20}$/,
  /TXT下载|电子书下载|免费下载/
];

// 笔记 App 的元数据行
const META = [
  /^\s*《[^》]{1,40}》\s*$/,
  /^\s*作者[:：]/,
  /^\s*第\s*\d+\s*页\s*$/,
  /^\s*\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/,
  /^\s*(标注|笔记|想法|划线)\s*[:：]?\s*$/,
  /^\s*\d{1,2}:\d{2}(:\d{2})?\s*$/
];

function cleanLine(line) {
  let s = line.replace(/\u3000/g, ' ')            // 全角空格
              .replace(/[\u00a0\u200b\ufeff]/g, '') // 不换行空格 / 零宽
              .replace(/^[ \t]+|[ \t]+$/g, '')       // 首尾空白
              .replace(/[ \t]{2,}/g, ' ');           // 连续空格
  return s;
}

function cleanText(raw) {
  const lines = raw.split('\n');
  const kept = [];
  let dropped = 0;
  for (const rawLine of lines) {
    const s = cleanLine(rawLine);
    if (!s) { kept.push(''); continue; }
    if (JUNK.some(p => p.test(s)) || META.some(p => p.test(s))) { dropped++; continue; }
    kept.push(s);
  }
  let text = kept.join('\n')
    .replace(/\n{3,}/g, '\n\n')   // 最多一个空行
    .replace(/^\n+|\n+$/g, '');
  return { text: text.trim(), dropped: dropped };
}

/* ---------------- 收集输入 ---------------- */

function collect(p, acc, depth) {
  if (depth === undefined) depth = 6;
  let st;
  try { st = fs.statSync(p); } catch (e) { console.log('  ! 找不到 ' + p); return acc; }
  if (st.isDirectory()) {
    if (depth <= 0) return acc;
    fs.readdirSync(p).sort().forEach(f => collect(path.join(p, f), acc, depth - 1));
  } else if (/\.(txt|md)$/i.test(p)) {
    acc.push(p);
  }
  return acc;
}

let files = [];
inputs.forEach(i => collect(path.resolve(i), files));
if (!files.length) { console.error('\n  没有找到 .txt / .md 文件\n'); process.exit(1); }

/* ---------------- 主流程 ---------------- */

console.log('\n  玄武 · 语料清洗');
console.log('  ' + '-'.repeat(60));
console.log('  输入 ' + files.length + ' 个文件' + (dry ? '　【--dry】不写文件' : ''));

if (!dry && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const cleaned = [];
let totalChars = 0, totalDropped = 0, skipped = 0;

files.forEach(f => {
  let raw;
  try { raw = readAny(f); } catch (e) { console.log('  ! 读取失败 ' + path.basename(f)); return; }
  const r = cleanText(raw);
  const n = r.text.replace(/\s/g, '').length;
  totalDropped += r.dropped;
  if (n < minChars) {
    skipped++;
    console.log('  - 跳过 ' + path.basename(f) + '（清洗后仅 ' + n + ' 字）');
    return;
  }
  totalChars += n;
  cleaned.push({ name: path.basename(f), text: r.text, chars: n });
  if (!dry) fs.writeFileSync(path.join(outDir, path.basename(f)), r.text + '\n', 'utf8');
});

cleaned.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

console.log('');
console.log('  保留 ' + cleaned.length + ' 个文件，共 ' + totalChars.toLocaleString() + ' 字');
console.log('  剔除垃圾行 ' + totalDropped + ' 行' + (skipped ? '，跳过过短文件 ' + skipped + ' 个' : ''));

cleaned.forEach(c => console.log('    ' + String(c.chars).padStart(6) + ' 字  ' + c.name));

if (mergeTo && !dry) {
  const parts = cleaned.map(c => {
    const title = c.name.replace(/\.(txt|md)$/i, '');
    return title + '\n\n' + c.text;
  });
  const merged = parts.join('\n\n\n');
  const outPath = path.isAbsolute(mergeTo) ? mergeTo : path.join(outDir, mergeTo);
  fs.writeFileSync(outPath, merged + '\n', 'utf8');
  console.log('\n  合并输出：' + outPath + '（' + merged.length.toLocaleString() + ' 字）');
}

if (!dry) console.log('\n  输出目录：' + outDir + '\n');
else console.log('');
