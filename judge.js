/*!
 * 玄武 · 大模型裁判（可选的第二意见）
 *
 * 只在服务端调用，浏览器永远拿不到 Key。
 * 默认关闭：只有配了 JUDGE_API_KEY 才启用。
 *
 *   JUDGE_BASE_URL   OpenAI 兼容的 base，默认 https://api.deepseek.com/v1
 *   JUDGE_API_KEY    必填才启用
 *   JUDGE_MODEL      默认 deepseek-chat
 *   JUDGE_TIMEOUT_MS 默认 25000
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG = {
  baseUrl: process.env.JUDGE_BASE_URL || 'https://api.deepseek.com/v1',
  apiKey: process.env.JUDGE_API_KEY || '',
  model: process.env.JUDGE_MODEL || 'deepseek-chat',
  timeoutMs: Number(process.env.JUDGE_TIMEOUT_MS || 25000)
};

function enabled() { return !!CONFIG.apiKey; }

function info() {
  return {
    enabled: enabled(),
    model: CONFIG.model,
    endpoint: CONFIG.baseUrl.replace(/\/+$/, '').replace(/^https?:\/\//, '') + '/chat/completions'
  };
}

const SYSTEM_PROMPT = [
  '你是一名中文小说资深编辑，专门识别"网络文学平台上用大模型生成的稿子"。',
  '你会拿到一段小说正文（可能是片段）。请只做一件事：判断它多大程度上像 AI 生成的。',
  '',
  '判断时重点看这些中文模型腔特征：',
  '1. 叠词副词泛滥：轻轻、缓缓、淡淡、微微、静静、"X地"结构；',
  '2. 表情包套路：眼底闪过、嘴角勾起一抹、深吸一口气、瞳孔微缩；',
  '3. 模糊限定词：似乎、仿佛、某种、说不清、下意识、不由得；',
  '4. 抽象大词与升华式收尾：命运、时间、世界、一切、寂静、终究；',
  '5. 句式整齐：句长集中在 15–35 字，缺少极短句和极长句；',
  '6. 标点单调：几乎只用逗号和句号，罕见破折号、感叹号、括号；',
  '7. 缺少具体物、数字、口语、方言、脏话、打字毛边；',
  '8. 信息空转：通篇情绪和气氛，没有可验证的具体事件。',
  '',
  '注意：文笔好、用词讲究、情感克制的真人写作不算 AI；反过来，被人改过的 AI 稿可能特征减弱。',
  '如果拿不准，就给 40–60 之间的分数，不要硬给极端值。',
  '',
  '只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块，格式：',
  '{"ai_probability": 0到100的整数,',
  ' "verdict": "一句话结论，不超过30字",',
  ' "reasons": ["最多4条，每条不超过40字，要具体"],',
  ' "suspicious_spans": [{"text": "原文里的片段，10到30字", "why": "为什么可疑，不超过20字"}],',
  ' "human_signals": ["如果发现了像人写的地方，最多3条，没有就给空数组"]}'
].join('\n');

function buildUserPrompt(text) {
  const limit = 9000;
  const body = text.length > limit ? text.slice(0, limit) : text;
  const cut = text.length > limit ? '\n（原文过长，已截取前 ' + limit + ' 字）' : '';
  return '下面是小说的正文，请按系统要求判断并输出 JSON：\n\n<<<TEXT\n' + body + '\nTEXT>>>' + cut;
}

function postJson(urlStr, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('JUDGE_BASE_URL 不是合法 URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'Accept': 'application/json'
      }, headers)
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 交给调用方处理 */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('大模型请求超时（' + Math.round(timeoutMs / 1000) + 's）'));
    });
    req.write(data);
    req.end();
  });
}

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch (e) { /* 继续尝试 */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) { /* 放弃 */ }
  }
  return null;
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function toStringArray(v, max) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => typeof x === 'string' && x.trim()).slice(0, max).map(x => x.trim());
}

/**
 * 调用大模型裁判
 * @returns {Promise<object>} 永远 resolve，失败时 ok:false
 */
async function judge(text, options) {
  const t0 = Date.now();
  if (!enabled()) {
    return { ok: false, enabled: false, error: { code: 'JUDGE_DISABLED', message: '未配置 JUDGE_API_KEY，大模型裁判未启用' } };
  }
  if (typeof text !== 'string' || text.replace(/\s/g, '').length < 100) {
    return { ok: false, enabled: true, error: { code: 'TEXT_TOO_SHORT', message: '大模型裁判需要至少 100 字' } };
  }

  const opts = options || {};
  const model = opts.model || CONFIG.model;
  const url = CONFIG.baseUrl.replace(/\/+$/, '') + '/chat/completions';

  let res;
  try {
    res = await postJson(url, {
      'Authorization': 'Bearer ' + CONFIG.apiKey
    }, {
      model: model,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(text) }
      ]
    }, CONFIG.timeoutMs);
  } catch (e) {
    return {
      ok: false, enabled: true, model,
      error: { code: 'JUDGE_NETWORK', message: '调用大模型失败：' + e.message },
      elapsedMs: Date.now() - t0
    };
  }

  if (res.status < 200 || res.status >= 300) {
    const msg = (res.json && res.json.error && (res.json.error.message || res.json.error.type)) || String(res.raw || '').slice(0, 200);
    return {
      ok: false, enabled: true, model,
      error: { code: 'JUDGE_HTTP_' + res.status, message: '大模型接口返回 ' + res.status + '：' + msg },
      elapsedMs: Date.now() - t0
    };
  }

  const content = res.json && res.json.choices && res.json.choices[0] &&
    res.json.choices[0].message && res.json.choices[0].message.content;
  const parsed = extractJson(content);
  if (!parsed) {
    return {
      ok: false, enabled: true, model,
      error: { code: 'JUDGE_BAD_OUTPUT', message: '大模型没返回可解析的 JSON' },
      rawExcerpt: String(content || '').slice(0, 400),
      elapsedMs: Date.now() - t0
    };
  }

  const spans = Array.isArray(parsed.suspicious_spans) ? parsed.suspicious_spans.slice(0, 5)
    .filter(x => x && typeof x.text === 'string')
    .map(x => ({ text: String(x.text).slice(0, 80), why: String(x.why || '').slice(0, 60) })) : [];

  return {
    ok: true,
    enabled: true,
    model,
    score: clampNum(parsed.ai_probability, 0, 100, 50),
    verdict: typeof parsed.verdict === 'string' ? parsed.verdict.slice(0, 60) : '',
    reasons: toStringArray(parsed.reasons, 4),
    spans,
    humanSignals: toStringArray(parsed.human_signals, 3),
    usage: (res.json && res.json.usage) || null,
    elapsedMs: Date.now() - t0
  };
}

/** 把规则引擎分和大模型分合成一个数，并给出分歧提示 */
function combine(heuristicScore, judgeResult) {
  if (!judgeResult || !judgeResult.ok) return null;
  const a = Number(heuristicScore) || 0;
  const b = Number(judgeResult.score) || 0;
  const combined = Math.round(a * 0.6 + b * 0.4);
  const gap = Math.abs(a - b);
  let note;
  if (gap >= 25) note = '两套引擎分歧较大（相差 ' + gap + ' 分），建议人工复核这段';
  else if (gap >= 12) note = '两套引擎略有分歧，可以采信分数更高的那一个';
  else note = '规则引擎与大模型判断一致';
  return { combined, heuristic: a, judge: b, gap, note };
}

module.exports = { enabled, info, judge, combine, CONFIG };
