#!/usr/bin/env node
/*!
 * 玄武 · 小说 AI 味检测  API 服务
 * 零依赖，只需 Node 14+。
 *
 *   node server.js              启动（默认 http://127.0.0.1:8787）
 *   node server.js --selftest   跑引擎自检并退出
 *   PORT=9000 node server.js    换端口
 *
 * 环境变量：
 *   PORT            端口，默认 8787
 *   HOST            监听地址，默认 0.0.0.0
 *   MAX_BODY_MB     请求体上限，默认 4
 *   MAX_CHARS       单段文本字数上限，默认 200000
 *   DEFAULT_RPM     默认每分钟请求数，默认 30
 *   DEFAULT_DAILY   默认每日配额，默认 2000
 *   ALLOW_ANON=1    允许不带 Key 调用（仅建议内网调试）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AN = require('./assets/engine.js');
const JUDGE = require('./judge.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = Number(process.env.MAX_BODY_MB || 4) * 1024 * 1024;
const MAX_CHARS = Number(process.env.MAX_CHARS || 200000);
const DEFAULT_RPM = Number(process.env.DEFAULT_RPM || 30);
const DEFAULT_DAILY = Number(process.env.DEFAULT_DAILY || 2000);
const ALLOW_ANON = process.env.ALLOW_ANON === '1';
const ALLOW_LOCAL_UI = process.env.ALLOW_LOCAL_UI !== '0';
const WEB_DAILY_LIMIT = Number(process.env.WEB_DAILY_LIMIT || 40);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const START = Date.now();

/* ============================================================
 * 自检模式
 * ============================================================ */

if (process.argv.indexOf('--selftest') >= 0) {
  const r = AN.selfTest();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.passed ? 0 : 1);
}

/* ============================================================
 * API Key 与配额
 * ============================================================ */

const KEYS_FILE = path.join(ROOT, 'keys.json');
const USAGE_FILE = path.join(ROOT, 'usage.json');

let keys = [];

function loadKeys() {
  try {
    const arr = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    keys = Array.isArray(arr) ? arr : [];
  } catch (e) {
    keys = [];
  }
  // 角色约定：role === 'internal' 的内部测试 Key 才能看复核界面、调 /correct
  keys.forEach(k => { if (!k.role) k.role = 'public'; });
  if (!keys.length) {
    const k = 'xw_live_' + crypto.randomBytes(16).toString('hex');
    keys = [{
      key: k,
      name: 'default',
      plan: 'free',
      role: 'internal',
      rpm: DEFAULT_RPM,
      dailyQuota: DEFAULT_DAILY,
      enabled: true,
      createdAt: new Date().toISOString()
    }];
    try {
      fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
      console.log('\n  已生成 keys.json，你的 API Key：\n');
      console.log('      ' + k + '\n');
      console.log('  把它填进 keys.json 可以加更多客户 Key。\n');
    } catch (e) {
      console.log('  ! 无法写入 keys.json（' + e.message + '），本次使用临时 Key：' + k);
    }
  }
  // 环境变量兜底
  if (process.env.API_KEYS) {
    process.env.API_KEYS.split(',').map(s => s.trim()).filter(Boolean).forEach(k => {
      if (!keys.some(x => x.key === k)) {
        keys.push({ key: k, name: 'env', plan: 'env', rpm: DEFAULT_RPM, dailyQuota: DEFAULT_DAILY, enabled: true });
      }
    });
  }
}

const usage = new Map();
let usageDirty = false;

try {
  const saved = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  Object.keys(saved || {}).forEach(k => {
    usage.set(k, {
      day: saved[k].day,
      count: saved[k].count || 0,
      minutes: [],
      total: saved[k].total || 0,
      tokens: saved[k].tokens || 0
    });
  });
} catch (e) { /* 首次运行没有 usage.json，正常 */ }

/* 计费单位：1 token = TOKEN_CHARS 个中文字符。
   按字数折算比按次数公平——一千字和一万字的工作量不是一回事。 */
const TOKEN_CHARS = 1000;
function charsToTokens(n) { return Math.max(1, Math.ceil(Number(n || 0) / TOKEN_CHARS)); }

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function saveUsage() {
  if (!usageDirty) return;
  const obj = {};
  usage.forEach((v, k) => { obj[k] = { day: v.day, count: v.count, total: v.total, tokens: v.tokens || 0 }; });
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(obj, null, 2), 'utf8');
    usageDirty = false;
  } catch (e) { /* 忽略写盘失败 */ }
}
setInterval(saveUsage, 30000).unref();

/* ============================================================
 * 校准参数（由 calibrate.js 生成）
 * ============================================================ */

const CAL_FILE = path.join(ROOT, 'calibration.json');
const SAMPLES_FILE = path.join(ROOT, 'samples.jsonl');
const CORRECTIONS_FILE = path.join(ROOT, 'corrections.jsonl');
const LOGS_FILE = path.join(ROOT, 'testlogs.jsonl');
// 测试记录里保留多少正文。默认只留前 500 字（够定位问题，不是整篇存档）。
// 要存全文：设 LOG_TEXT_MAX=0
const LOG_TEXT_MAX = process.env.LOG_TEXT_MAX === '0' ? 0 : Number(process.env.LOG_TEXT_MAX || 500);

/** 记录一次测试：谁、什么时候、测了什么、结果如何 */
function logTest(req, recAny, text, report) {
  try {
    const ip = clientIp(req);
    const role = recAny && recAny.role ? recAny.role : (recAny && recAny.key && recAny.key.indexOf('__web__') === 0 ? 'web' : 'public');
    const item = {
      ts: new Date().toISOString(),
      ip: ip,
      role: role,
      keyName: (recAny && recAny.name) || '',
      chars: report && report.text ? report.text.cjk : (text || '').length,
      score: report ? report.score : null,
      verdict: report && report.verdict ? report.verdict.key : '',
      textType: report && report.textType ? report.textType.key : '',
      ua: String(req.headers['user-agent'] || '').slice(0, 160),
      text: LOG_TEXT_MAX ? String(text || '').slice(0, LOG_TEXT_MAX) : String(text || '')
    };
    fs.appendFileSync(LOGS_FILE, JSON.stringify(item) + '\n', 'utf8');
  } catch (e) { /* 记录失败不影响检测 */ }
}

/**
 * 人工复核白名单：整篇文本被人工认定为人写之后，重测直接给人写。
 * 这是"复核过的稿子不再报警"的即时生效通道，和"慢慢变准"的训练通道并行。
 */
const humanHashes = new Map();   // 原文 hash 和「去空白 hash」都收，粘贴差异不影响命中
function reviewHash(text) { return hashCode(String(text || '').replace(/\s+/g, '')); }
function loadCorrections() {
  humanHashes.clear();
  try {
    const lines = fs.readFileSync(CORRECTIONS_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        if (c && c.label === 'human') {
          const wf = { ts: c.ts, reason: c.reason || '', marked: c.marked || [], by: c.by || '' };
          if (c.hash) humanHashes.set(c.hash, wf);
          if (c.rhash) humanHashes.set(c.rhash, wf);
        }
      } catch (e) { /* 跳过坏行 */ }
    }
  } catch (e) { /* 还没有核对记录 */ }
}
loadCorrections();
// 默认不保存正文（隐私）。训练只需要特征，不需要原文。
// 本地自用想留原文对照时设 STORE_TEXT=1。
const STORE_TEXT = process.env.STORE_TEXT === '1';

let calibration = null;
let calMtime = 0;

function loadCalibration() {
  try {
    const st = fs.statSync(CAL_FILE);
    if (st.mtimeMs === calMtime) return;
    calibration = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
    calMtime = st.mtimeMs;
    console.log('  已加载 calibration.json（' + Object.keys(calibration.features || {}).length + ' 项特征已校准）');
  } catch (e) {
    if (calibration !== null) { calibration = null; calMtime = 0; }
  }
}
loadCalibration();
setInterval(loadCalibration, 15000).unref();

/* ============================================================
 * 训练好的模型（train.py 产出 model.json，有就优先用）
 * ============================================================ */

const MODEL_FILE = path.join(ROOT, 'model.json');
let model = null;
let modelMtime = 0;

function loadModel() {
  try {
    const st = fs.statSync(MODEL_FILE);
    if (st.mtimeMs === modelMtime) return;
    model = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
    modelMtime = st.mtimeMs;
    if (model.demo === true) {
      console.log('  ! model.json 是【演示数据】训出来的，已忽略；跑一次真的 python train.py 覆盖它');
      model = null;
      return;
    }
    console.log('  已加载 model.json（逻辑回归 ' + ((model.features || []).length) +
      ' 项特征，训练于 ' + (model.trainedAt || '') + '）');
  } catch (e) {
    if (model !== null) { model = null; modelMtime = 0; }
  }
}
loadModel();
setInterval(loadModel, 15000).unref();

/* ============================================================
 * 反馈样本
 * ============================================================ */

const seenHashes = new Set();
let sampleCount = 0;

function loadSampleIndex() {
  seenHashes.clear();
  sampleCount = 0;
  try {
    const lines = fs.readFileSync(SAMPLES_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line);
        if (s && s.hash) seenHashes.add(s.hash);
        sampleCount++;
      } catch (e) { /* 跳过坏行 */ }
    }
  } catch (e) { /* 还没有样本 */ }
}
loadSampleIndex();

function appendSample(record) {
  fs.appendFileSync(SAMPLES_FILE, JSON.stringify(record) + '\n', 'utf8');
  if (record.hash) seenHashes.add(record.hash);
  sampleCount++;
}

/* ============================================================
 * 训练数据统计
 * ============================================================ */

let statsCache = { at: 0, value: null };

function computeStats(force) {
  const now = Date.now();
  if (!force && statsCache.value && now - statsCache.at < 20000) return statsCache.value;

  let samples = [];
  try {
    samples = fs.readFileSync(SAMPLES_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(s => s && s.features && (s.label === 'ai' || s.label === 'human'));
  } catch (e) { samples = []; }

  const counts = {
    ai: samples.filter(s => s.label === 'ai').length,
    human: samples.filter(s => s.label === 'human').length
  };

  let acc = null, auc = null, avgAi = null, avgHuman = null;
  if (counts.ai >= 3 && counts.human >= 3 && typeof AN.scoreFromFeatures === 'function') {
    const pairs = [];
    for (const s of samples) {
      try {
        const sc = AN.scoreFromFeatures(s.features, calibration).score;
        pairs.push({ score: sc, isAi: s.label === 'ai' });
      } catch (e) { /* 跳过异常样本 */ }
    }
    if (pairs.length) {
      acc = Math.round(pairs.filter(p => (p.score >= 50) === p.isAi).length / pairs.length * 1000) / 10;
      const pos = pairs.filter(p => p.isAi), neg = pairs.filter(p => !p.isAi);
      avgAi = pos.length ? Math.round(pos.reduce((a, b) => a + b.score, 0) / pos.length * 10) / 10 : null;
      avgHuman = neg.length ? Math.round(neg.reduce((a, b) => a + b.score, 0) / neg.length * 10) / 10 : null;
      let wins = 0, total = 0;
      for (const a of pos) for (const b of neg) { total++; wins += a.score > b.score ? 1 : (a.score === b.score ? 0.5 : 0); }
      auc = total ? Math.round(wins / total * 1000) / 1000 : null;
    }
  }

  const value = {
    samples: { total: sampleCount, ai: counts.ai, human: counts.human, unusable: sampleCount - counts.ai - counts.human },
    calibration: calibration ? {
      applied: true,
      createdAt: calibration.createdAt || null,
      sampleCount: calibration.sampleCount || null,
      features: Object.keys(calibration.features || {}).length
    } : { applied: false },
    accuracy: { at50: acc, auc, avgAi, avgHuman },
    ready: counts.ai >= 8 && counts.human >= 8
  };
  statsCache = { at: now, value };
  return value;
}

/* ============================================================
 * 工具
 * ============================================================ */

function hashCode(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function findKey(raw) {
  if (!raw) return null;
  const hit = keys.find(k => k.key === raw);
  if (!hit || hit.enabled === false) return null;
  return hit;
}

/** 内部测试身份：只有 role=internal 的 Key 能复核、能改样本 */
function isInternal(rec) {
  return !!(rec && rec.role === 'internal');
}

/* ---- IP → 地区 ---- */
// 用 ip2region 的离线库：不出网、没有次数限制、返回中文地名。
// 库文件在 node_modules/ip2region/data/ 下，首次查询时加载，之后常驻内存。
let __ip2region = null;
let __ip2regionTried = false;
const __ipRegionCache = new Map();

function ipRegion(ip) {
  if (!ip || typeof ip !== 'string') return '';
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.indexOf(':') < 0) return '';
  if (__ipRegionCache.has(ip)) return __ipRegionCache.get(ip);

  if (!__ip2region && !__ip2regionTried) {
    __ip2regionTried = true;
    try {
      const { IP2Region } = require('ip2region/node');
      __ip2region = new IP2Region();
    } catch (e) {
      console.warn('[ip-region] ip2region 不可用：' + e.message);
    }
  }
  if (!__ip2region) { __ipRegionCache.set(ip, ''); return ''; }

  let out = '';
  try {
    const r = __ip2region.lookup(ip);
    if (r) {
      const country = (r.country && r.country.name) || '';
      const prov = (r.subdivisions && r.subdivisions[0] && r.subdivisions[0].name) || '';
      const city = (r.city && r.city.name) || '';
      const isp = r.isp || '';
      if (country && country !== '中国') {
        out = [country, prov, city].filter(x => x && x !== '0').join(' ');
      } else {
        // 国内：省 + 市，直辖市去重
        const parts = [];
        if (prov && prov !== '0') parts.push(prov);
        if (city && city !== '0' && city !== prov) parts.push(city);
        out = parts.join(' ') || country;
        if (isp && isp !== '0') out += ' · ' + isp;
      }
    }
  } catch (e) {
    out = '';
  }
  __ipRegionCache.set(ip, out);
  return out;
}


function isLocalUi(req) {
  const host = req.headers.host || '';
  if (!host) return false;
  const ref = String(req.headers.referer || req.headers.origin || '');
  if (!ref) return false;
  return ref.indexOf('http://' + host) === 0 || ref.indexOf('https://' + host) === 0;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  return ip.replace(/^::ffff:/, '');
}

/**
 * 按字数扣费：1 token = 1000 字。
 * tokenQuota 未设置（或为 0）视为不计费。
 */
function chargeTokens(keyRecord, chars) {
  const id = keyRecord.key;
  const quota = Number(keyRecord.tokenQuota || 0);
  if (!quota) return { ok: true, tokens: 0, remaining: null };
  const need = charsToTokens(chars);
  let u = usage.get(id);
  if (!u) { u = { day: todayStr(), count: 0, minutes: [], total: 0, tokens: 0 }; usage.set(id, u); }
  u.tokens = u.tokens || 0;
  const left = quota - u.tokens;
  if (need > left) {
    return {
      ok: false, status: 402, code: 'INSUFFICIENT_TOKENS',
      message: '字数额度不足：本次需要 ' + need + ' token（约 ' + Math.max(1, chars) + ' 字），剩余 ' + Math.max(0, left) + ' token',
      need, left: Math.max(0, left)
    };
  }
  u.tokens += need;
  usageDirty = true;
  return { ok: true, tokens: need, remaining: quota - u.tokens };
}

/**
 * 读取请求里的 Key。
 * 支持三种：X-API-Key 头、Authorization: Bearer、以及登录后下发的 HttpOnly Cookie。
 * Cookie 是网页端用的——这样内部 Key 不会出现在 URL 里，
 * 不会被浏览器历史、截图、转发链接泄露。
 */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; } }
  });
  return out;
}

function keyOf(req) {
  const h = req.headers['x-api-key'];
  if (h) return String(h).trim();
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const c = parseCookies(req).aitell_key;
  if (c) return String(c).trim();
  return '';
}

function consume(keyRecord) {
  const id = keyRecord.key;

  // 内部测试账号不设限：不限次数、不限速率（只做统计，不拦截）
  if (isInternal(keyRecord)) {
    const nowI = Date.now();
    const todayI = todayStr();
    let uI = usage.get(id);
    if (!uI) { uI = { day: todayI, count: 0, minutes: [], total: 0 }; usage.set(id, uI); }
    if (uI.day !== todayI) { uI.day = todayI; uI.count = 0; }
    uI.minutes = (uI.minutes || []).filter(t => nowI - t < 60000);
    uI.minutes.push(nowI);
    uI.count += 1; uI.total += 1;
    usageDirty = true;
    return { ok: true, remaining: null, quota: null };
  }

  const rpm = Number(keyRecord.rpm || DEFAULT_RPM);
  const daily = Number(keyRecord.dailyQuota || DEFAULT_DAILY);
  const now = Date.now();
  const today = todayStr();

  let rec = usage.get(id);
  if (!rec) { rec = { day: today, count: 0, minutes: [], total: 0 }; usage.set(id, rec); }
  if (rec.day !== today) { rec.day = today; rec.count = 0; }
  rec.minutes = (rec.minutes || []).filter(t => now - t < 60000);

  if (rec.minutes.length >= rpm) {
    return { ok: false, status: 429, code: 'RATE_LIMIT', message: '超出速率限制：每分钟最多 ' + rpm + ' 次', retryAfter: 60 };
  }
  if (rec.count >= daily) {
    return { ok: false, status: 429, code: 'QUOTA_EXCEEDED', message: '今日配额已用完（' + daily + ' 次）' };
  }
  rec.minutes.push(now);
  rec.count += 1;
  rec.total += 1;
  usageDirty = true;
  return {
    ok: true,
    remaining: daily - rec.count,
    quota: daily,
    rpmRemaining: rpm - rec.minutes.length
  };
}

/* ============================================================
 * 工具
 * ============================================================ */

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'X-Powered-By': 'xuanwu-aitell/' + AN.version
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}

function fail(res, status, code, message, extra) {
  sendJson(res, status, { ok: false, error: Object.assign({ code, message }, extra || {}) });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大，上限 ' + Math.round(limit / 1024 / 1024) + ' MB'), { code: 'PAYLOAD_TOO_LARGE', status: 413 }));
        try { req.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('JSON 解析失败：' + e.message), { code: 'BAD_JSON', status: 400 })); }
    });
    req.on('error', e => reject(Object.assign(new Error(e.message), { code: 'READ_ERROR', status: 400 })));
  });
}

function pickText(body) {
  const text = body && (typeof body.text === 'string' ? body.text : (typeof body.content === 'string' ? body.content : ''));
  if (!text || !text.trim()) {
    throw Object.assign(new Error('缺少参数 text（要检测的文本）'), { code: 'MISSING_TEXT', status: 422 });
  }
  if (text.length > MAX_CHARS) {
    throw Object.assign(new Error('文本超过 ' + MAX_CHARS + ' 字上限'), { code: 'TEXT_TOO_LARGE', status: 413 });
  }
  return text;
}

function engineOptions(body) {
  const o = (body && typeof body.options === 'object' && body.options) || {};
  const out = {};
  if (o.maxChars && Number(o.maxChars) > 0) out.maxChars = Math.min(Number(o.maxChars), 200000);
  if (o.dimWeights && typeof o.dimWeights === 'object') out.dimWeights = o.dimWeights;
  if (o.featureWeights && typeof o.featureWeights === 'object') out.featureWeights = o.featureWeights;
  if (calibration && o.noCalibration !== true) out.calibration = calibration;
  if (model && o.noModel !== true) out.model = model;
  return out;
}

/** 精简版报告，用于批量接口省流量 */
function slim(report) {
  return {
    ok: true,
    version: report.version,
    score: report.score,
    scoreMode: report.scoreMode,
    verdict: report.verdict,
    textType: report.textType,
    fluency: report.fluency,
    gate: report.gate,
    band: report.band,
    confidence: report.confidence,
    text: report.text,
    dimensions: report.dimensions,
    suspiciousParagraphs: report.suspiciousParagraphs,
    composition: report.composition,
    findings: report.findings,
    summary: report.summary,
    elapsedMs: report.elapsedMs
  };
}

/* ============================================================
 * 静态文件
 * ============================================================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/**
 * 静态文件只放行「站点必需」的路径，其余一律 404。
 *
 * 以前是黑名单（只挡 keys.json/usage.json/.env），结果
 * server.js、model.json、calibration.json 全被直接下载走了——
 * 拿到 model.json 就等于拿到了打分权重，可以针对性规避。
 * 白名单比黑名单可靠：新加的文件默认不暴露。
 */
const STATIC_ALLOW = [
  /^\/index\.html$/,
  /^\/admin\.html$/,
  /^\/assets\/[\w.-]+\.(css|js|png|svg|ico|woff2?|ttf)$/
];

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  rel = rel.replace(/\/{2,}/g, '/');
  const normalized = path.posix.normalize(rel);
  const filePath = path.normalize(path.join(ROOT, normalized));

  if (filePath.indexOf(ROOT) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 禁止访问');
  }
  // 白名单之外的路径：源码、模型、样本、日志、文档都不对外
  if (!STATIC_ALLOW.some(re => re.test(normalized))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 未找到');
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!MIME[ext]) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 未找到');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 未找到 ' + rel);
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    res.end(data);
  });
}

/* ============================================================
 * API 处理
 * ============================================================ */

async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  // 公开端点
  if (pathname === '/api/v1/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'xuanwu-aitell',
      version: AN.version,
      engine: 'heuristic-' + AN.featureDefs.length,
      features: AN.featureDefs.length,
      dimensions: AN.DIMS.length,
      uptimeSec: Math.round((Date.now() - START) / 1000),
      now: new Date().toISOString(),
      judge: JUDGE.info(),
      calibration: { applied: !!calibration, createdAt: calibration ? calibration.createdAt : null },
      model: model ? { applied: true, features: (model.features || []).length, trainedAt: model.trainedAt || null, metrics: model.metrics || null } : { applied: false },
      webDailyLimit: WEB_DAILY_LIMIT,
      samples: sampleCount
    });
  }
  if (pathname === '/api/v1/features') {
    return sendJson(res, 200, {
      ok: true,
      version: AN.version,
      bands: AN.BANDS,
      dimensions: AN.DIMS,
      features: AN.featureDefs
    });
  }
  if (pathname === '/api/v1/calibration') {
    return sendJson(res, 200, {
      ok: true,
      applied: !!calibration,
      createdAt: calibration ? calibration.createdAt : null,
      sampleCount: calibration ? calibration.sampleCount : null,
      calibration: calibration || null
    });
  }

  /* ---- 登录：用 Key 换一个 HttpOnly Cookie ----
     网页端走这条路，Key 就不会出现在地址栏里。
     HttpOnly 意味着 JS 读不到，XSS 也偷不走；SameSite=Lax 挡 CSRF。 */
  if (pathname === '/api/v1/auth') {
    if (method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '该端点只支持 POST');
    let abody = {};
    try { abody = await readBody(req, 8 * 1024); } catch (e) { abody = {}; }
    const k = String(abody.key || '').trim();
    if (!k) return fail(res, 422, 'NO_KEY', '请提供 Key');
    const recAuth = findKey(k);
    if (!recAuth) return fail(res, 401, 'BAD_KEY', 'Key 无效或已停用');
    const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
    const isHttps = proto === 'https' || Boolean(req.socket && req.socket.encrypted);
    const cookie = 'aitell_key=' + encodeURIComponent(k) +
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (30 * 24 * 3600) +
      (isHttps ? '; Secure' : '');
    res.setHeader('Set-Cookie', cookie);
    return sendJson(res, 200, {
      ok: true,
      role: recAuth.role || 'public',
      name: recAuth.name || '',
      internal: isInternal(recAuth)
    });
  }

  if (pathname === '/api/v1/logout') {
    if (method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '该端点只支持 POST');
    res.setHeader('Set-Cookie', 'aitell_key=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  /* ---- 领取 API Key（不需要鉴权，凭邀请码） ----
     规则：同名再次领取 = 老 Key 忘掉了 → 先删旧的再发新的。
     这样"忘了就重新生成"能自动完成，不用人工介入。 */
  if (pathname === '/api/v1/keys/register') {
    if (method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '该端点只支持 POST');
    let rbody = {};
    try { rbody = await readBody(req, 64 * 1024); } catch (e) { rbody = {}; }

    const name = String(rbody.name || '').trim().slice(0, 40);
    if (name.length < 2) return fail(res, 422, 'BAD_NAME', '请填写至少 2 个字的名称（用来区分是谁的 Key）');

    const invite = String(process.env.INVITE_CODE || '');
    if (invite && String(rbody.inviteCode || '') !== invite) {
      return fail(res, 403, 'BAD_INVITE', '邀请码不正确');
    }

    // 同一个名字只保留一把 Key：重新领取 = 换新 Key，旧的立刻作废
    const before = keys.length;
    keys = keys.filter(k => !(k.name === name && k.role !== 'internal'));
    const dropped = before - keys.length;

    const newKey = 'xw_pub_' + crypto.randomBytes(16).toString('hex');
    const rec2 = {
      key: newKey,
      name,
      plan: 'beta',
      role: 'public',
      rpm: Number(process.env.PUBLIC_RPM || 20),
      dailyQuota: Number(process.env.PUBLIC_DAILY || 2000),
      tokenQuota: Number(process.env.PUBLIC_TOKEN_QUOTA || 200),
      enabled: true,
      createdAt: new Date().toISOString()
    };
    keys.push(rec2);
    try { fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8'); }
    catch (e) { return fail(res, 500, 'KEY_WRITE_FAILED', 'Key 写入失败：' + e.message); }

    return sendJson(res, 200, {
      ok: true,
      key: newKey,
      name,
      plan: rec2.plan,
      tokenQuota: rec2.tokenQuota,
      tokenChars: TOKEN_CHARS,
      replaced: dropped > 0,
      message: dropped > 0
        ? '已作废同名旧 Key（' + dropped + ' 把），这是你的新 Key，只显示这一次，请立刻保存'
        : '这是你的新 Key，只显示这一次，请立刻保存'
    });
  }

  // 鉴权
  const rawKey = keyOf(req);
  let rec = findKey(rawKey);
  // 本地网页通道：浏览器直接从本服务打开的页面调用时免 Key。
  // 每天有免费次数上限（WEB_DAILY_LIMIT），按 IP 计，想放开就调大。
  // 若要完全收紧，设 ALLOW_LOCAL_UI=0。
  if (!rec && ALLOW_LOCAL_UI && isLocalUi(req)) {
    rec = {
      key: '__web__:' + clientIp(req),
      name: 'web',
      plan: 'web',
      rpm: 20,
      dailyQuota: WEB_DAILY_LIMIT
    };
  }

  if (!rec && !ALLOW_ANON) {
    return fail(res, 401, 'UNAUTHORIZED', rawKey ? 'API Key 无效或已禁用' : '缺少 API Key，请在请求头加 X-API-Key');
  }
  if (!rec) {
    rec = { key: '__anon__', rpm: 10, dailyQuota: 100 };
  }

  if (pathname === '/api/v1/quota' && method === 'GET') {
    const u = usage.get(rec.key) || { day: todayStr(), count: 0, total: 0 };
    const used = u.day === todayStr() ? u.count : 0;
    if (isInternal(rec)) {
      return sendJson(res, 200, {
        ok: true,
        plan: rec.plan || 'internal',
        role: 'internal',
        unlimited: true,
        limit: null,
        used,
        remaining: null,
        rpm: null,
        resetsAt: ''
      });
    }
    const limit = Number(rec.dailyQuota || DEFAULT_DAILY);
    const tokenQuota = Number(rec.tokenQuota || 0);
    return sendJson(res, 200, {
      ok: true,
      plan: rec.plan || '',
      role: 'public',
      unlimited: false,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      rpm: Number(rec.rpm || DEFAULT_RPM),
      tokenQuota: tokenQuota || null,
      tokensUsed: tokenQuota ? (u.tokens || 0) : null,
      tokensRemaining: tokenQuota ? Math.max(0, tokenQuota - (u.tokens || 0)) : null,
      tokenChars: TOKEN_CHARS,
      resetsAt: tokenQuota ? '额度用完后需续费' : '本地时间零点'
    });
  }

  if (pathname === '/api/v1/logs' && method === 'GET') {
    if (!isInternal(rec)) return fail(res, 403, 'FORBIDDEN', '测试记录仅对内部账号开放');
    const limit = Math.min(Number(query.get('limit') || 100) || 100, 1000);
    let rows = [];
    try {
      rows = fs.readFileSync(LOGS_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) { rows = []; }
    const ipFilter = query.get('ip');
    if (ipFilter) rows = rows.filter(r => r.ip === ipFilter);
    const total = rows.length;
    rows = rows.slice(-limit).reverse();     // 最新在前
    // 统计
    const ips = {}, days = {};
    rows.forEach(r => {
      ips[r.ip] = (ips[r.ip] || 0) + 1;
      const d = (r.ts || '').slice(0, 10);
      days[d] = (days[d] || 0) + 1;
    });
    return sendJson(res, 200, {
      ok: true, total, returned: rows.length,
      uniqueIps: Object.keys(ips).length,
      byIp: Object.keys(ips).map(k => ({ ip: k, count: ips[k] })).sort((a, b) => b.count - a.count).slice(0, 50),
      byDay: Object.keys(days).sort().map(k => ({ day: k, count: days[k] })),
      rows
    });
  }

  /* ---- 备份清单与下载（内部专用）----
     本地客户端靠这个接口做增量同步：先拿清单比对，只下载缺的。
     这样本地始终有一份和服务器一致的备份目录，随时可以打开看。 */
  if (pathname === '/api/v1/backups' && method === 'GET') {
    if (!isInternal(rec)) return fail(res, 403, 'FORBIDDEN', '备份仅对内部账号开放');
    const dir = process.env.BACKUP_DIR || '/root/backups';
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter(f => /\.(tar\.gz|conf|service)$/.test(f))
        .map(f => {
          try {
            const st = fs.statSync(path.join(dir, f));
            return { name: f, size: st.size, mtime: st.mtime.toISOString() };
          } catch (e) { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    } catch (e) { files = []; }
    const latest = files.find(f => /^aitell-.*\.tar\.gz$/.test(f.name)) || null;
    return sendJson(res, 200, {
      ok: true, dir, count: files.length,
      latest: latest ? latest.name : null,
      totalBytes: files.reduce((s, f) => s + f.size, 0),
      files
    });
  }

  if (pathname.indexOf('/api/v1/backups/') === 0 && method === 'GET') {
    if (!isInternal(rec)) return fail(res, 403, 'FORBIDDEN', '备份仅对内部账号开放');
    const name = decodeURIComponent(pathname.slice('/api/v1/backups/'.length));
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) {
      return fail(res, 400, 'BAD_NAME', '文件名不合法');
    }
    const dir = process.env.BACKUP_DIR || '/root/backups';
    const fp = path.join(dir, name);
    if (path.dirname(fp) !== dir && path.resolve(fp).indexOf(path.resolve(dir) + path.sep) !== 0) {
      return fail(res, 400, 'BAD_NAME', '文件名不合法');
    }
    let st;
    try { st = fs.statSync(fp); } catch (e) { return fail(res, 404, 'NOT_FOUND', '文件不存在'); }
    if (!st.isFile()) return fail(res, 404, 'NOT_FOUND', '不是文件');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'X-Backup-Mtime': st.mtime.toISOString()
    });
    return fs.createReadStream(fp).pipe(res);
  }

  if (pathname === '/api/v1/admin/health' && method === 'GET') {
    if (!isInternal(rec)) return fail(res, 403, 'FORBIDDEN', '后台仅对内部账号开放');
    // 健康检查脚本每 5 分钟写一次状态，这里只读不重算
    const statusFile = path.join('/var/lib/aitell-health/status.json');
    let status = null;
    try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch (e) { status = null; }
    if (!status) {
      return sendJson(res, 200, {
        ok: true, checked: false,
        note: '健康检查尚未运行（等 cron 触发，或手动执行 /usr/local/bin/health-check.sh）'
      });
    }
    // 状态文件超过 15 分钟没更新 = 检查脚本本身停摆
    const stale = !status.ts || (Date.now() - new Date(status.ts).getTime() > 15 * 60 * 1000);
    return sendJson(res, 200, { ok: true, checked: true, stale, status });
  }

  /* ---- IP 归属地（离线库，不往外发请求）---- */
  if (pathname === '/api/v1/admin/ip-region' && method === 'GET') {
    if (!isInternal(rec)) return fail(res, 403, 'FORBIDDEN', '后台仅对内部账号开放');
    const list = String(query.get('ips') || '')
      .split(',').map(x => x.trim()).filter(Boolean).slice(0, 200);
    const map = {};
    list.forEach(ip => { map[ip] = ipRegion(ip); });
    return sendJson(res, 200, { ok: true, map: map });
  }

  if (pathname === '/api/v1/admin/overview' && method === 'GET') {
    if (!isInternal(rec)) return fail(res, 403, 'FORBIDDEN', '后台仅对内部账号开放');
    let logs = [];
    try {
      logs = fs.readFileSync(LOGS_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) { logs = []; }

    const today = todayStr();
    const ipSet = new Set();
    const byDay = {};
    let todayCount = 0, todayIps = new Set();
    logs.forEach(r => {
      if (r.ip) ipSet.add(r.ip);
      const d = (r.ts || '').slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
      if (d === today) { todayCount++; if (r.ip) todayIps.add(r.ip); }
    });

    const st = computeStats(false);
    let corrections = 0;
    try {
      corrections = fs.readFileSync(CORRECTIONS_FILE, 'utf8').split(/\r?\n/).filter(Boolean).length;
    } catch (e) { corrections = 0; }

    return sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      detect: {
        total: logs.length,
        uniqueIps: ipSet.size,
        today: todayCount,
        todayIps: todayIps.size,
        byDay: Object.keys(byDay).sort().slice(-30).map(d => ({ day: d, count: byDay[d] }))
      },
      samples: st.samples,
      accuracy: st.accuracy,
      corrections: corrections,
      model: model ? { features: (model.features || []).length, trainedAt: model.trainedAt, metrics: model.metrics } : null,
      calibration: calibration ? { createdAt: calibration.createdAt, sampleCount: calibration.sampleCount } : null,
      keys: {
        total: keys.length,
        internal: keys.filter(k => k.role === 'internal').length,
        public: keys.filter(k => k.role !== 'internal').length,
        enabled: keys.filter(k => k.enabled !== false).length
      },
      privacy: { storeText: STORE_TEXT, logTextMax: LOG_TEXT_MAX }
    });
  }

  if (pathname === '/api/v1/admin/keys' && method === 'GET') {
    if (!isInternal(rec)) return fail(res, 403, 'FORBIDDEN', '后台仅对内部账号开放');
    const list = keys.map(k => {
      const u = usage.get(k.key) || {};
      return {
        key: k.key.length > 16 ? k.key.slice(0, 12) + '…' + k.key.slice(-4) : k.key,
        name: k.name, role: k.role || 'public', plan: k.plan || '',
        enabled: k.enabled !== false,
        tokenQuota: k.tokenQuota || null,
        tokensUsed: u.tokens || 0,
        dailyQuota: k.dailyQuota || null,
        count: u.count || 0, total: u.total || 0,
        createdAt: k.createdAt || ''
      };
    }).sort((a, b) => (a.role === 'internal' ? -1 : 1) - (b.role === 'internal' ? -1 : 1));
    return sendJson(res, 200, { ok: true, keys: list });
  }

  if (pathname === '/api/v1/admin/keys' && method === 'POST') {
    if (!isInternal(rec)) return fail(res, 403, 'FORBIDDEN', '后台仅对内部账号开放');
    const name = String(body.name || '').trim().slice(0, 40);
    if (name.length < 2) return fail(res, 422, 'BAD_NAME', '名字至少 2 个字');
    const role = String(body.role || 'public') === 'internal' ? 'internal' : 'public';
    const tokenQuota = body.tokenQuota === '' || body.tokenQuota === undefined || body.tokenQuota === null
      ? (role === 'internal' ? null : 200)
      : Number(body.tokenQuota);
    const existing = keys.find(k => k.name === name);
    if (existing) {
      existing.role = role;
      existing.tokenQuota = role === 'internal' ? null : tokenQuota;
      if (typeof body.enabled === 'boolean') existing.enabled = body.enabled;
    } else {
      const nk = (role === 'internal' ? 'xw_int_' : 'xw_pub_') + crypto.randomBytes(16).toString('hex');
      keys.push({
        key: nk, name, plan: role === 'internal' ? 'internal' : 'beta', role,
        rpm: Number(process.env.PUBLIC_RPM || 20),
        dailyQuota: role === 'internal' ? 999999 : Number(process.env.PUBLIC_DAILY || 2000),
        tokenQuota: role === 'internal' ? null : tokenQuota,
        enabled: true, createdAt: new Date().toISOString()
      });
    }
    try { fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8'); }
    catch (e) { return fail(res, 500, 'WRITE_FAILED', '写入 keys.json 失败：' + e.message); }
    return sendJson(res, 200, { ok: true, name, created: !existing });
  }

  if (pathname === '/api/v1/stats' && method === 'GET') {
    const s = computeStats(query.get('refresh') === '1');
    return sendJson(res, 200, Object.assign({ ok: true, version: AN.version }, s));
  }

  if (pathname === '/api/v1/usage' && method === 'GET') {
    const u = usage.get(rec.key) || { day: todayStr(), count: 0, total: 0 };
    return sendJson(res, 200, {
      ok: true,
      key: rec.key.slice(0, 10) + '…',
      name: rec.name || '',
      plan: rec.plan || '',
      day: u.day,
      usedToday: u.day === todayStr() ? u.count : 0,
      dailyQuota: Number(rec.dailyQuota || DEFAULT_DAILY),
      rpm: Number(rec.rpm || DEFAULT_RPM),
      totalUsed: u.total || 0
    });
  }

  if (method !== 'POST') {
    if (pathname === '/api/v1/me') {
      return sendJson(res, 200, {
        ok: true,
        role: rec.role || 'public',
        internal: isInternal(rec),
        name: rec.name || '',
        plan: rec.plan || ''
      });
    }
    return fail(res, 405, 'METHOD_NOT_ALLOWED', '该端点只支持 POST');
  }

  // 打标不占配额：反馈是帮我们变准，不该让用户付费
  let quota = { ok: true, remaining: null, quota: null };
  if (pathname !== '/api/v1/feedback') {
    quota = consume(rec);
    if (!quota.ok) {
      return fail(res, quota.status, quota.code, quota.message, { retryAfter: quota.retryAfter });
    }
  }

  let body;
  try {
    body = await readBody(req, MAX_BODY);
  } catch (e) {
    return fail(res, e.status || 400, e.code || 'BAD_REQUEST', e.message);
  }

  try {
    if (pathname === '/api/v1/detect') {
      const text = pickText(body);

      // 按字数计费（内部账号不计费）
      if (!isInternal(rec)) {
        const charge = chargeTokens(rec, text.length);
        if (!charge.ok) {
          return fail(res, charge.status, charge.code, charge.message,
            { need: charge.need, remaining: charge.left });
        }
      }

      const report = AN.analyze(text, engineOptions(body));

      // 人工已认定为人写的稿子：整篇翻案，段落也一起翻，重测不再报警
      const rHash = hashCode(text);
      const rHash2 = reviewHash(text);
      if (humanHashes.has(rHash) || humanHashes.has(rHash2)) {
        const wf = humanHashes.get(rHash) || humanHashes.get(rHash2);
        report.rawScoreBeforeReview = report.score;
        report.score = Math.min(report.score, 18);
        report.verdict = { key: 'human', label: '人写', short: '人写', min: 0, max: 39, color: '#16a34a' };
        report.band = { key: 'human', label: '人写', color: '#16a34a', advice: '已人工复核，可直接通过。' };

        // 段落翻案：记录原判（留证据），然后把判定全部改成 human
        const flipped = [];
        (report.paragraphs || []).forEach(p => {
          if (p.skip) return;
          if (p.verdict !== 'human') {
            flipped.push({ index: p.index, scoreBefore: p.score, chars: p.chars, text: (p.text || '').slice(0, 120) });
          }
          p.scoreBefore = p.score;
          p.score = Math.min(Number(p.score) || 0, 20);
          p.verdict = 'human';
          p.band = 'human';
          p.reviewed = true;
        });
        report.reviewedParagraphs = flipped;
        report.suspiciousParagraphs = [];

        // 环图也翻成 100% 人写
        let pc = 0;
        (report.paragraphs || []).forEach(p => { if (!p.skip) pc++; });
        report.composition = {
          human: { key: 'human', label: '人工特征', chars: report.text.cjk, paragraphs: pc, ratio: 100 },
          suspected: { key: 'suspected', label: '疑似 AI', chars: 0, paragraphs: 0, ratio: 0 },
          high: { key: 'high', label: 'AI 特征', chars: 0, paragraphs: 0, ratio: 0 }
        };

        report.summary = '全文 ' + report.text.cjk + ' 字，已被人工复核为人写（机器原判 ' +
          report.rawScoreBeforeReview + ' 分）。本次不再标注可疑段落。';
        report.reviewed = {
          applied: true, label: 'human',
          reason: wf.reason, marked: wf.marked, at: wf.ts, by: wf.by,
          flippedCount: flipped.length,
          note: '这篇已被人工复核为人写，检测结论以人工为准'
        };
      }
      // 谁能看到「人工复核」由服务端说了算，前端藏按钮不算数
      const review = { allowed: isInternal(rec), role: rec.role || 'public' };

      // 公测版只给结论，不给可反推的细节：
      // 特征名、各项实测值、改写建议——这三样的组合等于一份"怎么绕过"的说明书。
      if (!review.allowed) {
        const dimsPublic = (report.dimensions || []).map(d => ({
          key: d.key, name: d.name, score: d.score, weight: d.weight
        }));
        report.dimensions = dimsPublic;
        report.findings = [];
        report.features = [];
        report.fixes = [];
        // 段落保留判定（左栏着色要用），但抹掉"为什么"——flags/hits 里全是特征名
        report.paragraphs = (report.paragraphs || []).map(p => ({
          index: p.index, text: p.text, chars: p.chars, sentences: p.sentences,
          score: p.score, verdict: p.verdict, band: p.band, pct: p.pct,
          skip: p.skip, skipReason: p.skipReason
        }));
        report.sentences = (report.sentences || []).map(s => ({
          i: s.i, t: s.t, len: s.len, dlg: s.dlg, score: s.score
        }));
        report.suspiciousParagraphs = [];
        const vb = report.verdict || {};
        report.summary = '全文 ' + report.text.cjk + ' 字，判定「' + (vb.label || '') + '」，' +
          'AI 味指数 ' + report.score + '，置信度 ' + report.confidence.level +
          '（±' + report.confidence.margin + '）。';
      }
      if (body.judge === true) {
        if (!JUDGE.enabled()) {
          report.judge = { ok: false, enabled: false, error: { code: 'JUDGE_DISABLED', message: '服务端未配置 JUDGE_API_KEY' } };
        } else {
          report.judge = await JUDGE.judge(text, body.judgeOptions || {});
          report.combined = JUDGE.combine(report.score, report.judge);
        }
      }
      if (query.get('detail') === 'lite') {
        const lite = slim(report);
        lite.review = review;
        if (report.judge) lite.judge = report.judge;
        if (report.combined) lite.combined = report.combined;
        return sendJson(res, 200, lite);
      }
      report.review = review;
      logTest(req, rec, text, report);
      return sendJson(res, 200, report);
    }

    if (pathname === '/api/v1/feedback') {
      const text = pickText(body);
      const label = String(body.label || '').toLowerCase();
      if (['ai', 'human', 'unsure'].indexOf(label) < 0) {
        throw Object.assign(new Error('label 只能是 ai / human / unsure'), { code: 'INVALID_LABEL', status: 422 });
      }
      const hash = hashCode(text);
      if (seenHashes.has(hash)) {
        return sendJson(res, 200, { ok: true, duplicate: true, message: '这条文本已经标过了', total: sampleCount });
      }
      // 服务端自己重算特征，不信任客户端传来的数值，避免污染训练集
      const rep = AN.analyze(text, engineOptions(body));
      const features = {};
      rep.features.forEach(f => { if (!f.skipped && typeof f.value === 'number') features[f.id] = f.value; });

      const record = {
        id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: new Date().toISOString(),
        label,
        hash,
        score: rep.score,
        calibrated: !!calibration,
        chars: rep.text.cjk,
        source: typeof body.source === 'string' ? body.source.slice(0, 20) : 'api',
        note: typeof body.note === 'string' ? body.note.slice(0, 200) : '',
        features
      };
      if (STORE_TEXT) record.text = text.slice(0, 5000);
      appendSample(record);
      statsCache = { at: 0, value: null };

      return sendJson(res, 200, {
        ok: true,
        duplicate: false,
        id: record.id,
        label,
        score: rep.score,
        total: sampleCount,
        stats: computeStats(true)
      });
    }

    if (pathname === '/api/v1/correct') {
      if (!isInternal(rec)) {
        return fail(res, 403, 'FORBIDDEN', '人工复核仅对内部测试账号开放');
      }
      const text = pickText(body);
      const label = String(body.label || 'human').toLowerCase();
      if (['ai', 'human'].indexOf(label) < 0) {
        throw Object.assign(new Error('label 只能是 ai / human'), { code: 'INVALID_LABEL', status: 422 });
      }
      const marked = Array.isArray(body.marked) ? body.marked.slice(0, 50).map(Number) : [];
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : '';
      const reasonTags = Array.isArray(body.reasonTags) ? body.reasonTags.slice(0, 8).map(String) : [];

      // 服务端重算，不信任客户端传来的分数
      const rep = AN.analyze(text, engineOptions(body));
      const hash = hashCode(text);
      const rhash = reviewHash(text);

      const crec = {
        id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        ts: new Date().toISOString(),
        label,
        hash,
        rhash,
        score: rep.score,
        chars: rep.text.cjk,
        marked,
        reason,
        reasonTags,
        by: rec.name || rec.role || 'unknown',
        source: typeof body.source === 'string' ? body.source.slice(0, 20) : 'ui'
      };

      // 核对记录：无论长短都存，作为"人工推翻机器"的证据
      fs.appendFileSync(CORRECTIONS_FILE, JSON.stringify(crec) + '\n', 'utf8');
      // 人工认定人写 → 立刻进白名单，重测就不报警了
      if (label === 'human') {
        const wf = { ts: crec.ts, reason, marked, by: crec.by };
        humanHashes.set(hash, wf);
        humanHashes.set(rhash, wf);
      } else {
        humanHashes.delete(hash);
        humanHashes.delete(rhash);
      }

      // 只有够长的文本才进训练集（短文本算出来的特征不可靠）
      // 体裁不适用的（合同/公文）不进训练集，否则会把"模板腔"教成"人写"
      let added = false;
      let skipWhy = '';
      if (rep.textType && rep.textType.applicable === false) {
        skipWhy = '体裁不适用（' + rep.textType.label + '），不进入训练集';
      } else if (rep.text.cjk < 400) {
        skipWhy = '文本短于 400 字，特征不可靠，不进入训练集';
      } else if (seenHashes.has(hash)) {
        skipWhy = '这条文本已经收录过';
      } else {
        const features = {};
        rep.features.forEach(f => { if (!f.skipped && typeof f.value === 'number') features[f.id] = f.value; });
        appendSample({
          id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          ts: new Date().toISOString(),
          label,
          hash,
          score: rep.score,
          calibrated: !!calibration,
          chars: rep.text.cjk,
          source: 'correct',
          note: reasonTags.concat(reason ? [reason] : []).join(' / ').slice(0, 200),
          features
        });
        added = true;
        statsCache = { at: 0, value: null };
      }

      return sendJson(res, 200, {
        ok: true,
        added,
        label,
        score: rep.score,
        textType: rep.textType,
        total: sampleCount,
        stats: computeStats(true),
        note: added ? '已加入训练样本，下次训练生效' : ('已记录核对凭据；' + skipWhy)
      });
    }

    if (pathname === '/api/v1/judge') {
      const text = pickText(body);
      if (!JUDGE.enabled()) {
        return fail(res, 503, 'JUDGE_DISABLED', '服务端未配置 JUDGE_API_KEY，大模型裁判未启用');
      }
      const j = await JUDGE.judge(text, body.judgeOptions || {});
      if (!j.ok) {
        return sendJson(res, 502, { ok: false, version: AN.version, judge: j });
      }
      let heuristic = null;
      try { heuristic = AN.analyze(text, engineOptions(body)).score; } catch (e) { /* 忽略 */ }
      return sendJson(res, 200, {
        ok: true,
        version: AN.version,
        judge: j,
        heuristicScore: heuristic,
        combined: JUDGE.combine(heuristic, j)
      });
    }

    if (pathname === '/api/v1/batch') {
      let texts = body.texts;
      if (!Array.isArray(texts) || !texts.length) {
        throw Object.assign(new Error('缺少参数 texts（字符串数组，最多 50 条）'), { code: 'MISSING_TEXTS', status: 422 });
      }
      if (texts.length > 50) {
        throw Object.assign(new Error('一次最多 50 条，当前 ' + texts.length + ' 条'), { code: 'TOO_MANY_ITEMS', status: 422 });
      }
      const opts = engineOptions(body);
      const results = texts.map((item, i) => {
        const name = (item && typeof item === 'object' && item.name) || ('item-' + (i + 1));
        const t = typeof item === 'string' ? item : (item && item.text) || '';
        try {
          const r = AN.analyze(t, opts);
          return Object.assign({ name }, slim(r));
        } catch (e) {
          return { name, ok: false, error: { code: e.code || 'ANALYZE_FAILED', message: e.message } };
        }
      });
      const okOnes = results.filter(r => r.ok !== false);
      return sendJson(res, 200, {
        ok: true,
        version: AN.version,
        count: results.length,
        succeeded: okOnes.length,
        averageScore: okOnes.length ? Math.round(okOnes.reduce((a, b) => a + b.score, 0) / okOnes.length) : 0,
        quota: { remaining: quota.remaining, dailyQuota: quota.quota },
        results
      });
    }

    if (pathname === '/api/v1/chapters') {
      const text = pickText(body);
      const report = AN.analyzeChapters(text, engineOptions(body));
      return sendJson(res, 200, report);
    }

    if (pathname === '/api/v1/compare') {
      const a = body.a || body.baseline;
      const b = body.b || body.target;
      if (typeof a !== 'string' || typeof b !== 'string') {
        throw Object.assign(new Error('缺少参数 a / b（两段文本）'), { code: 'MISSING_TEXTS', status: 422 });
      }
      const opts = engineOptions(body);
      const ra = AN.analyze(a, opts);
      const rb = AN.analyze(b, opts);
      const diff = {};
      ra.dimensions.forEach((d, i) => {
        const other = rb.dimensions[i];
        diff[d.key] = (d.score === null || other.score === null) ? null : other.score - d.score;
      });
      return sendJson(res, 200, {
        ok: true,
        version: AN.version,
        a: slim(ra),
        b: slim(rb),
        scoreDiff: rb.score - ra.score,
        dimensionDiff: diff,
        verdict: (rb.score - ra.score) >= 15 ? 'B 显著更接近模型输出'
          : ((rb.score - ra.score) <= -15 ? 'B 比 A 更自然' : '两者差异不显著')
      });
    }

    return fail(res, 404, 'NOT_FOUND', '没有这个端点：' + pathname);
  } catch (e) {
    if (e && e.status) return fail(res, e.status, e.code || 'BAD_REQUEST', e.message);
    if (e && e.code && /TEXT_|BAD_INPUT|EMPTY|NOT_CHINESE|MISSING/.test(e.code)) {
      return fail(res, 422, e.code, e.message);
    }
    console.error('[analyze]', e);
    return fail(res, 500, 'INTERNAL_ERROR', '分析过程出错：' + (e && e.message));
  }
}

/* ============================================================
 * 主服务
 * ============================================================ */

const server = http.createServer((req, res) => {
  const started = Date.now();
  let pathname = '/';
  let query = new URLSearchParams('');
  try {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    pathname = u.pathname;
    query = u.searchParams;
  } catch (e) { /* 用默认值 */ }

  res.on('finish', () => {
    if (pathname.indexOf('/api/') === 0) {
      console.log(
        new Date().toISOString().slice(11, 19),
        req.method,
        pathname,
        res.statusCode,
        (Date.now() - started) + 'ms'
      );
    }
  });

  if (pathname.indexOf('/api/') === 0) {
    handleApi(req, res, pathname, query).catch(err => {
      console.error('[unhandled]', err);
      if (!res.headersSent) fail(res, 500, 'INTERNAL_ERROR', '服务内部错误');
      else try { res.end(); } catch (e) { /* ignore */ }
    });
    return;
  }

  serveStatic(req, res, pathname);
});

loadKeys();

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log('');
  console.log('  AI 味体检（内测版）  引擎 v' + AN.version + '，' + AN.featureDefs.length + ' 项特征');
  console.log('  ----------------------------------------------------');
  console.log('  网页      http://' + shown + ':' + PORT + '/');
  console.log('  健康检查  http://' + shown + ':' + PORT + '/api/v1/health');
  console.log('  特征字典  http://' + shown + ':' + PORT + '/api/v1/features');
  console.log('  Key 数量  ' + keys.length + '（配置文件 keys.json）');
  console.log('  网页免 Key ' + (ALLOW_LOCAL_UI ? '开（每 IP 每日 ' + WEB_DAILY_LIMIT + ' 次）' : '关'));
  console.log('  反馈样本  ' + sampleCount + ' 条（samples.jsonl）');
  console.log('  隐私模式  ' + (STORE_TEXT ? '！保存正文前 5000 字（STORE_TEXT=1）' : '只存特征，不存正文'));
  console.log('  校准状态  ' + (calibration ? '已启用，训练于 ' + (calibration.createdAt || '').slice(0, 19) : '未校准（node calibrate.js）'));
  console.log('  打分引擎  ' + (model
    ? '逻辑回归模型（' + (model.features || []).length + ' 项特征，' +
      (model.metrics && model.metrics.cvAccuracy != null ? 'CV 准确率 ' + (model.metrics.cvAccuracy * 100).toFixed(1) + '%' : '未评估') + '）'
    : '人工权重（python train.py 可训练模型）'));
  const ji = JUDGE.info();
  console.log('  大模型裁判 ' + (ji.enabled ? '已启用 → ' + ji.model : '未配置（设 JUDGE_API_KEY 可开启）'));
  console.log('');
});

process.on('SIGINT', () => { saveUsage(); console.log('\n  已保存用量，服务退出。'); process.exit(0); });
process.on('SIGTERM', () => { saveUsage(); process.exit(0); });
