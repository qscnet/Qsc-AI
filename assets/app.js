/*!
 * 玄武 · 小说 AI 味检测  前端逻辑
 * 依赖 assets/engine.js 暴露的全局 AN
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------
   * 身份：内部测试账号用 ?key=xxx 打开一次，之后记住。
   * 复核按钮显不显示，最终由服务端返回的 review.allowed 决定，
   * 前端藏/露只是省事，接口那一层才是真关口。
   * ---------------------------------------------------------- */
  /**
   * 身份：优先用 HttpOnly Cookie（浏览器自动携带，JS 读不到），
   * 这样内部 Key 不会留在地址栏、浏览器历史、分享链接和截图里。
   *
   * 兼容老链接的方式：如果 URL 里带了 ?key=，立刻用它换 Cookie，
   * 然后从地址栏抹掉，再重载一次——用户看到的就是干净的 https://qsclh.cn/。
   */
  var APP_KEY = '';

  (function bootstrapKey() {
    var m = String(location.search || '').match(/[?&]key=([^&]+)/);
    var urlKey = m ? decodeURIComponent(m[1]) : '';
    var lsKey = '';
    try { lsKey = localStorage.getItem('xw_key') || ''; } catch (e) { lsKey = ''; }
    var candidate = urlKey || lsKey;
    if (!candidate) return;                      // 没有 Key，走公测身份

    // 用 Key 换 Cookie，换完把 URL 和 localStorage 都清干净
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', 'api/v1/auth', false);    // 同步：要在首屏请求之前完成
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ key: candidate }));
      if (xhr.status === 200) {
        try { localStorage.removeItem('xw_key'); } catch (e) { /* 忽略 */ }
        if (urlKey) {
          try {
            var q = location.search.replace(/([?&])key=[^&]*&?/, '$1').replace(/[?&]$/, '');
            history.replaceState(null, '', location.pathname + q + location.hash);
          } catch (e) { /* 忽略 */ }
        }
      } else if (urlKey) {
        // Key 无效：也不要把它留在地址栏
        try {
          var q2 = location.search.replace(/([?&])key=[^&]*&?/, '$1').replace(/[?&]$/, '');
          history.replaceState(null, '', location.pathname + q2 + location.hash);
        } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 网络异常就当没登录 */ }
  })();

  function apiHeaders(extra) {
    var h = extra || {};
    if (APP_KEY) h['X-API-Key'] = APP_KEY;   // 一般用不到，Cookie 已足够
    return h;
  }

  /** 切回公测身份（清掉 Cookie） */
  function clearIdentity() {
    try { localStorage.removeItem('xw_key'); } catch (e) { /* 忽略 */ }
    fetch('api/v1/logout', { method: 'POST' }).then(function () { location.reload(); })
      .catch(function () { location.reload(); });
  }

  /**
   * 身份初始化：问服务端"我是谁"，据此露出/收起内部功能。
   * 记住：服务端才是真关口，这里只是别把按钮摆在公测用户面前。
   */
  var ROLE = 'public';
  fetch('api/v1/me', { headers: apiHeaders() }).then(function (r) { return r.json(); })
    .then(function (j) {
      ROLE = (j && j.internal) ? 'internal' : 'public';
      applyRole();
    }).catch(function () { ROLE = 'public'; applyRole(); });

  function applyRole() {
    var internal = ROLE === 'internal';
    document.querySelectorAll('[data-internal="1"]').forEach(function (el) {
      if (internal) { el.hidden = false; el.style.display = ''; }
      else { el.hidden = true; el.style.display = 'none'; }
    });
    var badge = $('role-badge');
    if (badge) {
      badge.textContent = internal ? '内部测试' : '公测';
      badge.className = 'badge-live' + (internal ? ' badge-internal' : '');
      badge.style.cursor = internal ? 'pointer' : 'default';
      badge.title = internal ? '点击切回公测视图' : '';
      badge.onclick = internal ? clearIdentity : null;
    }
    applyTabGating(internal);
  }

  /**
   * 公测只开放「检测」。
   * 其余功能（整本拆章 / 批量 / 对照 / API / 说明）暂时置灰，等做扎实了再逐个放开。
   * 放开某个页签：把它的名字加进 PUBLIC_TABS 即可。
   * 内部账号不受影响，全部可用。
   */
  var PUBLIC_TABS = ['detect'];

  function applyTabGating(internal) {
    document.querySelectorAll('nav button[data-tab]').forEach(function (b) {
      var tab = b.dataset.tab;
      var ok = internal || PUBLIC_TABS.indexOf(tab) >= 0;
      if (ok) {
        b.classList.remove('tab-locked');
        b.removeAttribute('disabled');
        b.removeAttribute('title');
        if (b._lockHandler) { b.removeEventListener('click', b._lockHandler, true); b._lockHandler = null; }
      } else {
        b.classList.add('tab-locked');
        b.setAttribute('disabled', 'disabled');
        b.title = '公测暂未开放，等做扎实了再放开。需要的话加微信 smart-360';
        if (!b._lockHandler) {
          // disabled 的 button 在部分浏览器仍会触发 click，这里兜一层
          b._lockHandler = function (e) {
            e.preventDefault();
            e.stopPropagation();
            showRaw(b, '<div class="tip-d">公测暂未开放。<br>需要这个功能，加微信 <b>smart-360</b></div>');
          };
          b.addEventListener('click', b._lockHandler, true);
        }
        // 如果它正开着，切回检测
        if (b.classList.contains('active')) {
          var d = document.querySelector('nav button[data-tab="detect"]');
          if (d) d.click();
        }
      }
    });
  }
  var qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function scoreColor(s, alpha) {
    s = Math.max(0, Math.min(100, s || 0));
    var h = s <= 50 ? 145 - (145 - 38) * (s / 50) : 38 - 38 * ((s - 50) / 50);
    return 'hsla(' + Math.round(h) + ',76%,42%,' + alpha + ')';
  }

  function scorePill(s) {
    if (s === null || s === undefined) return '<span class="score-pill" style="background:#f2f4f9;color:#98a2b3">—</span>';
    var v = verdictOf(s);
    return '<span class="score-pill" style="background:' + v.color + '1f;color:' + v.color + '">' + s + '</span>';
  }

  function verdictOf(s) {
    if (window.AN && AN.verdictOf) return AN.verdictOf(Number(s) || 0);
    return { key: 'human', label: '人写', short: '人写', color: '#16a34a', desc: '', advice: '' };
  }

  function verdictByKey(k) {
    var list = (window.AN && AN.VERDICTS) || [];
    for (var i = 0; i < list.length; i++) { if (list[i].key === k) return list[i]; }
    return verdictOf(0);
  }

  function setBusy(btn, busy, text) {
    if (!btn) return;
    if (busy) {
      btn.dataset.old = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span>' + (text || '分析中');
    } else {
      btn.disabled = false;
      btn.innerHTML = btn.dataset.old || text;
    }
  }

  function readTextFile(file, cb) {
    var fr = new FileReader();
    fr.onload = function () {
      var buf = fr.result, txt = '';
      try { txt = new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch (e) { txt = ''; }
      if (!txt || txt.indexOf('\uFFFD') >= 0) {
        try { txt = new TextDecoder('gbk').decode(buf); } catch (e2) { /* 保留 utf-8 结果 */ }
      }
      cb(txt || '');
    };
    fr.onerror = function () { cb(''); };
    fr.readAsArrayBuffer(file);
  }

  /* ---------------- 页签 ---------------- */

  qsa('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      qsa('#tabs button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      qsa('.view').forEach(function (v) { v.classList.remove('active'); });
      var v = $('view-' + b.dataset.tab);
      if (v) v.classList.add('active');
      if (b.dataset.tab === 'train') loadStats();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  /* ---------------- 字数统计 ---------------- */

  function bindCounter(taId, outId) {
    var ta = $(taId), out = $(outId);
    if (!ta || !out) return;
    ta.addEventListener('input', function () {
      out.textContent = ta.value.replace(/\s/g, '').length.toLocaleString() + ' 字';
    });
  }
  bindCounter('input', 'counter');
  bindCounter('ch-input', 'ch-counter');

  // 一改文本，上一次的段落标注就作废
  $('input').addEventListener('input', function () {
    if (annotated) resetAnnot();
  });

  /* ============================================================
   * 报告渲染
   * ============================================================ */

  /** 段落级判定卡片——这是内部（审核）才看得到的证据，公测不展示 */
  function paraBlock(r) {
    var ps = r.suspiciousParagraphs || [];
    var canReview = !!(r.review && r.review.allowed);   // 只有内部测试账号能看段落证据
    if (!canReview) return '';                          // 公测：一根羽毛都不露
    var h = [];
    if (ps.length) {
      var nHigh = ps.filter(function (p) { return verdictOf(p.score).key === 'high'; }).length;
      var nSus = ps.length - nHigh;
      h.push('<div class="block-title">可疑段落<span class="sub">高度怀疑 ' + nHigh + ' 段 · 疑似 ' + nSus +
        ' 段，可一键复制给作者</span></div>');
      h.push('<div class="paras">');
      ps.forEach(function (p) {
        var pv = verdictByKey(p.verdict || verdictOf(p.score).key);
        var tags = [], seen = {};
        (p.flags || []).forEach(function (f) { tags.push(f.name + (f.count > 1 ? ' ×' + f.count : '')); });
        (p.hits || []).forEach(function (f) { tags.push(f.name + ' ×' + f.count); });
        tags = tags.filter(function (t) { if (seen[t]) return false; seen[t] = 1; return true; });
        h.push('<div class="para-card" data-pi="' + p.index + '" style="border-left-color:' + pv.color + '">');
        h.push('<div class="para-head"><b>第 ' + p.index + ' 段</b>' +
          '<span class="para-score" style="background:' + pv.color + '1f;color:' + pv.color + '">' +
          esc(pv.label) + ' · ' + p.score + ' 分</span>' +
          (typeof p.pct === 'number' ? '<span class="chip">占比 ' + pctText(p.pct) + '</span>' : '') +
          '<span class="small muted">' + p.chars + ' 字 / ' + p.sentences + ' 句</span></div>');
        h.push('<p class="para-text">' + esc(p.text.length > 320 ? p.text.slice(0, 320) + '…' : p.text) + '</p>');
        if (tags.length) {
          h.push('<div class="row" style="gap:5px">' + tags.slice(0, 6).map(function (t) {
            return '<span class="chip">' + esc(t) + '</span>';
          }).join('') + '</div>');
        }
        // 改写建议：把这段"该怎么改"摊开讲（不需要大模型，指得出原文里的字）
        // 没抓到具体问题的段落不放按钮，免得点开一片空白
        var plan = buildRewritePlan(p);
        if (plan.length) {
          h.push('<div class="rw-row" data-pi="' + p.index + '">' +
            '<button class="rw-btn" data-pi="' + p.index + '">怎么改</button>' +
            '<span class="rw-hint">' + plan.length + ' 条改写要点</span></div>');
        }
        // 人工复核：让编辑推翻机器判断，并说明原因（仅内部测试账号可见）
        if (canReview) {
          h.push('<div class="cor-row" data-pi="' + p.index + '">' +
            '<span class="cor-ask">这段判错了吗？</span>' +
            '<button class="cor-btn" data-pi="' + p.index + '" data-label="human">这是人写的</button>' +
            '<button class="cor-btn" data-pi="' + p.index + '" data-label="ai">确实是 AI</button>' +
            '<span class="cor-done" hidden></span></div>');
          h.push('<div class="cor-panel" data-pi="' + p.index + '" hidden>' +
            '<div class="cor-tags">' +
            ['对话体/口语', '半文半白', '数据太少', '短段对白', '风格特殊', '其他']
              .map(function (t) { return '<button class="cor-tag" data-tag="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') +
            '</div>' +
            '<input class="cor-note" placeholder="补充说明（可选，会存进核对记录）" maxlength="200">' +
            '<div class="cor-actions"><button class="cor-submit">提交</button>' +
            '<button class="cor-cancel">取消</button></div></div>');
        }
        h.push('</div>');
      });
      h.push('</div>');
    } else {
      h.push('<div class="block-title">可疑段落</div>');
      h.push('<p class="small muted">没有段落越过「疑似」线（40 分），全文未检出成规模的模型书写特征。</p>');
    }
    return h.join('');
  }

  function renderReport(r) {
    var isInternalView = !!(r.review && r.review.allowed);
    var h = [];

    // 顶部工具栏：复制报告 / 导出 JSON 都属于内部证据导出，公测不提供
    if (isInternalView) {
      h.push('<div class="row" style="justify-content:flex-end;gap:7px;margin-bottom:10px">' +
        '<button class="ghost" data-act="copy">复制段落报告</button>' +
        '<button class="ghost" data-act="export">导出 JSON</button></div>');
    }

    // --- 头部：结论横幅 → 提示 → 环形图 → 图例 → 操作 ---
    var vd = r.verdict || verdictOf(r.score);
    var comp = r.composition || {
      human: { ratio: vd.key === 'human' ? 100 : 0 },
      suspected: { ratio: vd.key === 'suspected' ? 100 : 0 },
      high: { ratio: vd.key === 'high' ? 100 : 0 }
    };

    var BANNER = {
      human: { text: '人工创作特征显著', bg: '#e8f9e4', fg: '#2f7d32' },
      suspected: { text: '疑似 AI 特征明显', bg: '#fff7e0', fg: '#9a6300' },
      high: { text: 'AI 创作特征显著', bg: '#fdecea', fg: '#b3261e' }
    };
    var bn = BANNER[vd.key] || BANNER.human;
    var fl = r.fluency || { score: null, label: '', pass: true };
    var gate = r.gate || { pass: true, reason: '' };
    // 明明是人写，但读不通——这种情况单独提示，不能因为"像人"就放过去
    if (vd.key === 'human' && fl.pass === false) {
      bn = { text: '文字质量不达标（不通顺）', bg: '#fff7e0', fg: '#9a6300' };
    }

    // 人工复核过 → 结论以人工为准，直接给人写
    var tt = r.textType || null;
    var rv = r.reviewed || null;
    if (rv && rv.applied) {
      h.push('<div class="verdict-banner" style="background:#eafbf0;color:#15803d">' +
        '<span>已人工复核：人写（机器原判 ' + (r.rawScoreBeforeReview != null ? r.rawScoreBeforeReview : r.score) + ' 分）</span>' +
        '<button class="dl" data-act="report">⭳ 下载报告</button></div>');
      h.push('<div class="warn-box" style="background:#f6fdf8;border-color:#cfeedd;color:#2f6b46">' +
        '这篇已被内部人员复核为<b>人写</b>' +
        (rv.reason ? '，理由：' + esc(rv.reason) : '') +
        (rv.marked && rv.marked.length ? '　涉及段落：第 ' + rv.marked.join('、') + ' 段' : '') +
        '。检测结论以人工复核为准。</div>');
    } else if (tt && tt.applicable === false) {
      h.push('<div class="verdict-banner" style="background:#eef2f8;color:#4a5a72">' +
        '<span>体裁不适用：' + esc(tt.label) + '</span>' +
        '<button class="dl" data-act="report">⭳ 下载报告</button></div>');
      h.push('<div class="warn-box" style="background:#f8fafd;border-color:#dbe4f0;color:#4a5a72">' +
        esc(tt.note) + '　下面这些数字仅供形式参考，<b>不要据此判断作者</b>。</div>');
    } else {
      h.push('<div class="verdict-banner" style="background:' + bn.bg + ';color:' + bn.fg + '">' +
        '<span>' + esc(bn.text) + '</span>' +
        '<button class="dl" data-act="report">⭳ 下载报告</button></div>');
    }

    h.push('<div class="warn-box">提示：本结果仅为辅助判断，不应作为任何审核或处罚的决策性依据。</div>');

    var RING = { human: '#8ada80', suspected: '#ffd264', high: '#ff9f9f' };
    var hR = Math.max(0, Math.min(100, Number(comp.human.ratio) || 0));
    var sR = Math.max(0, Math.min(100 - hR, Number(comp.suspected.ratio) || 0));
    var aR = Math.max(0, Math.round((100 - hR - sR) * 10) / 10);
    var grad = 'conic-gradient(' +
      RING.human + ' 0% ' + hR + '%,' +
      RING.suspected + ' ' + hR + '% ' + (hR + sR) + '%,' +
      RING.high + ' ' + (hR + sR) + '% 100%)';

    h.push('<div class="ring-wrap">');
    h.push('<div class="ring-stage">');
    h.push('<div class="ring" style="background:' + grad + '"></div>');

    // 环外浮动的百分比标签（0% 的档只标第一个，避免两个 0% 叠在一起）
    var ringParts = [
      { v: hR, label: '人工特征', desc: '判为人工书写的那部分字数，占全文的比例。' },
      { v: sR, label: '疑似 AI', desc: 'AI 味落在 40–69 的段落字数占比，这部分需要人工复核。' },
      { v: aR, label: 'AI 特征', desc: 'AI 味落在 70–100 的段落字数占比，模型书写特征最集中。' }
    ];
    var stageW = 280, stageH = 244, sCx = stageW / 2, sCy = stageH / 2;
    var accP = 0, zeroShown = false;
    var placed = [];   // 已放标签的位置，用来错开重叠
    ringParts.forEach(function (p) {
      var isZero = p.v <= 0;
      var skip = isZero && zeroShown;
      if (isZero) zeroShown = true;
      var mid = accP + p.v / 2;
      var ang = -Math.PI / 2 + (mid / 100) * Math.PI * 2;
      accP += p.v;
      if (skip) return;
      // 很小的扇区标签容易挤在一起：按比例往外推，再和已放的错开
      var small = p.v < 6;
      var rr = isZero ? 98 : (small ? 116 : 106);
      var lx = sCx + Math.cos(ang) * rr;
      var ly = sCy + Math.sin(ang) * rr;
      for (var guard = 0; guard < 6; guard++) {
        var hit = placed.some(function (q) {
          return Math.abs(q.x - lx) < 34 && Math.abs(q.y - ly) < 15;
        });
        if (!hit) break;
        ly += (ly < sCy ? -15 : 15);
        if (ly < 6) ly = 6;
        if (ly > stageH - 12) ly = stageH - 12;
      }
      placed.push({ x: lx, y: ly });
      h.push('<span class="ring-lab" style="left:' + lx.toFixed(1) + 'px;top:' + ly.toFixed(1) + 'px">' +
        (Math.round(p.v * 10) / 10) + '%' +
        '<i class="ring-i" data-i="' + esc(p.label + '：' + p.desc) + '">i</i></span>');
    });
    h.push('</div>');

    h.push('<div class="ring-legend">' +
      '<div><i style="background:' + RING.human + '"></i>人工特征</div>' +
      '<div><i style="background:' + RING.suspected + '"></i>疑似 AI</div>' +
      '<div><i style="background:' + RING.high + '"></i>AI 特征</div>' +
      '</div>');
    h.push('<div class="ring-actions">' +
      (isInternalView
        ? '<button data-act="fb-up" title="判断准确：这段确实是' + esc(vd.label) + '">👍</button>' +
          '<button data-act="fb-down" title="判断有误：帮我纠正，样本会进训练集">👎</button>'
        : '') +
      '<button data-act="report" title="生成可打印报告单（另存为 PDF）">⭳</button>' +
      '</div>');
    h.push('</div>');

    // ============================================================
    // 公测版到此为止：只给「结论 + 圈 + 三个百分比」，和朱雀同级的信息量。
    // 具体段落、命中特征、维度拆解、改写建议都属于内部证据，不对外。
    // ============================================================
    if (!(r.review && r.review.allowed)) {
      h.push('<p class="pub-foot">检测为统计估计，不构成对作品来源的认定。如需逐段证据与复核，请联系我们开通审核账号。</p>');
      return h.join('');
    }

    h.push('<p class="summary">' + esc(r.summary) + '</p>');
    h.push('<div class="meta mt8">');
    h.push('<span class="chip" style="background:' + vd.color + '1f;border-color:' + vd.color +
      '33;color:' + vd.color + '">AI 味指数 ' + r.score + '</span>');
    if (r.scoreMode === 'model') {
      h.push('<span class="chip" title="分数来自 train.py 训练出的逻辑回归模型">模型打分</span>');
    }
    h.push('<span class="chip">' + r.text.cjk.toLocaleString() + ' 字</span>');
    h.push('<span class="chip">' + r.text.sentences + ' 句</span>');
    h.push('<span class="chip">' + r.text.paragraphs + ' 段</span>');
    h.push('<span class="chip">平均句长 ' + r.text.meanSentLen + '</span>');
    if (fl.score !== null && fl.score !== undefined) {
      var fcolor = fl.score >= 85 ? '#15803d' : (fl.score >= 65 ? '#b45309' : '#b91c1c');
      h.push('<span class="chip" style="color:' + fcolor + ';border-color:' + fcolor +
        '33;background:' + fcolor + '12">通顺度 ' + fl.score + ' · ' + esc(fl.label) + '</span>');
    }
    h.push('<span class="chip ' + (r.confidence.margin > 15 ? 'warn' : '') + '">置信度 ' + r.confidence.level + ' ±' + r.confidence.margin + '</span>');
    h.push('<span class="chip">' + r.elapsedMs + ' ms</span>');
    h.push('</div>');
    if (vd.advice) {
      h.push('<p class="small mt8" style="color:' + vd.color + '">处置建议：' + esc(vd.advice) + '</p>');
    }
    if (vd.key === 'human' && fl.pass === false) {
      h.push('<p class="small mt8" style="color:#b45309">处置建议：机器痕迹不明显，但句子读不通（通顺度 ' +
        fl.score + '，' + esc(fl.label) + '），建议退稿或要求返修。</p>');
    }
    if (r.confidence.margin >= 18) {
      h.push('<p class="small" style="color:#b54708;margin-top:6px">⚠ ' + esc(r.confidence.note) + '</p>');
    }

    if (r.warnings && r.warnings.length) {
      h.push('<div class="notice mt16" style="border-color:#e4e7ec;background:#f8f9fc;color:#475467">' +
        r.warnings.map(esc).join('；') + '</div>');
    }

    // 段落级判定直接放最上面：客户只看这一段
    h.push(paraBlock(r));

    // --- 雷达 + 维度 ---
    h.push('<div class="block-title">维度拆解<span class="sub">越靠外越像 AI</span></div>');
    h.push('<div class="radar-wrap"><canvas id="radar"></canvas></div>');
    h.push('<div class="dims">');
    r.dimensions.forEach(function (d) {
      var na = d.score === null;
      h.push('<div class="dim-row' + (na ? ' na' : '') + '" title="' + esc(d.desc) + '">' +
        '<span class="dim-name">' + esc(d.name) + '</span>' +
        '<span class="dim-track"><span class="dim-fill" style="width:' + (na ? 0 : d.score) + '%;background:' +
        (na ? '#cbd5e1' : scoreColor(d.score, .85)) + '"></span></span>' +
        '<span class="dim-val">' + (na ? '—' : d.score) + '</span></div>');
    });
    h.push('</div>');

    // --- 命中证据（内部专用：公测版服务端已清空 findings）---
    if (r.findings && r.findings.length) {
      h.push('<div class="block-title">命中证据<span class="sub">' + r.findings.length + ' 条，按权重排序</span></div>');
      h.push('<div class="findings">');
      r.findings.forEach(function (f) {
        h.push('<div class="finding ' + f.severity + '">');
        h.push('<div class="fh"><strong>' + esc(f.title) + '</strong>' +
          '<span class="tag">' + esc(f.dimName) + '</span>' +
          '<span class="metric">' + esc(f.metric) + '</span></div>');
        h.push('<div class="fdesc">' + esc(f.desc) + '</div>');
        h.push('<div class="ref">人类参考 ' + esc(f.humanRef) + ' ｜ AI 参考 ' + esc(f.aiRef) + ' ｜ 偏离 ' + f.deviation + '%</div>');
        if (f.evidence && f.evidence.length) {
          h.push('<div class="evidences">');
          f.evidence.forEach(function (e) { h.push('<q>' + esc(e) + '</q>'); });
          h.push('</div>');
        }
        if (f.fix) h.push('<div class="fix"><b>怎么改：</b>' + esc(f.fix) + '</div>');
        h.push('</div>');
      });
      h.push('</div>');
    }

    // --- 特征明细（内部专用：公测版服务端已清空 features）---
    if (!r.features || !r.features.length) {
      // 公测版：给个不带具体特征的说明，不暴露可反推的清单
      h.push('<div class="block-title">判定依据<span class="sub">按维度汇总</span></div>');
      h.push('<p class="small muted">引擎从用词、句式、标点、结构等多个维度与人类写作样本比对，' +
        '各维度的偏离程度见上方柱状图。具体特征权重不对外公开，避免被针对性规避。</p>');
      h.push('');
      return h.join('');
    }
    h.push('<details class="mt16"><summary style="cursor:pointer;font-size:13px;color:#4f46e5;font-weight:600">' +
      '查看 ' + r.features.length + ' 项特征明细（可核对每一项的实测值与参考值）</summary>');
    h.push('<div class="tbl-scroll mt8"><table class="tbl"><thead><tr>' +
      '<th>特征</th><th>维度</th><th>实测</th><th>人类参考</th><th>AI 参考</th><th style="width:96px">偏离</th></tr></thead><tbody>');
    var dimName = {};
    r.dimensions.forEach(function (d) { dimName[d.key] = d.name; });
    r.features.forEach(function (f) {
      if (f.skipped) {
        h.push('<tr style="opacity:.45"><td>' + esc(f.name) + '</td><td class="small">' + esc(dimName[f.dim] || f.dim) +
          '</td><td colspan="4" class="small muted">' + esc(f.display || '样本不足') + '</td></tr>');
        return;
      }
      var pctv = Math.round((f.norm || 0) * 100);
      h.push('<tr><td>' + esc(f.name) + '</td>' +
        '<td class="small muted">' + esc(dimName[f.dim] || f.dim) + '</td>' +
        '<td class="num mono" style="font-size:12px">' + esc(f.display) + '</td>' +
        '<td class="num mono small muted">' + esc(f.humanRef) + '</td>' +
        '<td class="num mono small muted">' + esc(f.aiRef) + '</td>' +
        '<td><span class="dim-track" style="display:block"><span class="dim-fill" style="width:' + pctv +
        '%;background:' + scoreColor(pctv, .8) + '"></span></span></td></tr>');
    });
    h.push('</tbody></table></div></details>');

    // --- 可疑段落（已提前到报告顶部渲染） ---

    // --- 逐句热力图（收进细节里，客户不需要看这么细） ---
    h.push('<details class="mt16"><summary style="cursor:pointer;font-size:13px;color:#4f46e5;font-weight:600">' +
      '逐句热力图（编辑细看用，红色＝该句最像模型输出）</summary>');
    h.push('<div class="heat mt8">');
    var sents = r.sentences || [], shown = 0;
    (r.paragraphs || []).forEach(function (p) {
      var inner = '';
      (p.sents || []).forEach(function (idx) {
        if (shown >= 1600) return;
        var s = sents[idx];
        if (!s) return;
        shown++;
        var fl = (s.flags || []).map(function (f) { return f.name; }).join('、');
        var tip = '第 ' + (idx + 1) + ' 句 · ' + s.score + ' 分' + (fl ? ' · ' + fl : '');
        inner += '<span class="s" style="background:' + scoreColor(s.score, .15) +
          ';border-bottom:2px solid ' + scoreColor(s.score, .55) + '" title="' + esc(tip) + '">' +
          esc(s.t) + '</span>';
      });
      if (inner) h.push('<p>' + inner + '</p>');
    });
    h.push('</div>');
    h.push('<div class="legend"><span>人类感</span>' +
      '<span class="sw" style="background:linear-gradient(90deg,' + scoreColor(0, .8) + ',' + scoreColor(50, .8) + ',' + scoreColor(100, .8) + ')"></span>' +
      '<span>AI 感</span><span class="muted">（最多渲染 1600 句，完整数据见 JSON / API）</span></div>');
    h.push('</details>');

    // --- 改写清单 ---
    if (r.fixes && r.fixes.length) {
      h.push('<div class="block-title">去 AI 味清单<span class="sub">按顺序改，效果最明显</span></div>');
      h.push('<ol class="small" style="line-height:2;padding-left:20px;margin:0;color:#344054">');
      r.fixes.forEach(function (f) {
        h.push('<li><b>' + esc(f.title) + '</b>：' + esc(f.fix) + '</li>');
      });
      h.push('</ol>');
    }

    return h.join('');
  }

  /* ---------------- 雷达图 ---------------- */

  /**
   * 章节曲线：每章一个点，纵轴 0–100 分。
   * 背景按人写/疑似/高度怀疑分三条色带，一眼看出哪几章跳高了。
   * （这个函数之前一直没实现，整本拆章点下去会报 drawChapterChart is not defined）
   */
  function drawChapterChart(canvas, chapters) {
    if (!canvas || !chapters || !chapters.length) return;

    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var W = Math.max(rect.width || 640, 320);
    var H = rect.height || 260;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    var padL = 40, padR = 14, padT = 14, padB = 30;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    var yOf = function (score) { return padT + plotH * (1 - score / 100); };

    // 三条色带
    var bands = [
      { from: 0, to: 40, color: 'rgba(22,163,74,.07)', line: '#16a34a' },
      { from: 40, to: 70, color: 'rgba(217,119,6,.08)', line: '#d97706' },
      { from: 70, to: 100, color: 'rgba(220,38,38,.07)', line: '#dc2626' }
    ];
    bands.forEach(function (b) {
      ctx.fillStyle = b.color;
      ctx.fillRect(padL, yOf(b.to), plotW, yOf(b.from) - yOf(b.to));
    });

    // 横向刻度
    ctx.font = '10px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 40, 70, 100].forEach(function (v) {
      var y = yOf(v);
      ctx.strokeStyle = v === 0 ? '#d5dae8' : '#e9ecf5';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = '#98a2b3';
      ctx.fillText(String(v), padL - 7, y);
    });

    // 找出有效点（score 可能是 null）
    var pts = [];
    var n = chapters.length;
    chapters.forEach(function (c, i) {
      var x = n === 1 ? padL + plotW / 2 : padL + plotW * (i / (n - 1));
      pts.push({ x: x, y: c.score === null ? null : yOf(c.score), score: c.score, ch: c });
    });

    // 折线（遇到 null 断开）
    ctx.beginPath();
    ctx.strokeStyle = '#4a6cf7';
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    var started = false;
    pts.forEach(function (p) {
      if (p.y === null) { started = false; return; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // 点：按判定上色
    var r = n > 60 ? 1.6 : (n > 30 ? 2.2 : 3);
    pts.forEach(function (p) {
      if (p.y === null) return;
      var c = p.score >= 70 ? '#dc2626' : (p.score >= 40 ? '#d97706' : '#16a34a');
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
    });

    // 横轴：章节号，密的时候每若干章标一个
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#98a2b3';
    var step = Math.max(1, Math.ceil(n / 12));
    pts.forEach(function (p, i) {
      if (i % step !== 0 && i !== n - 1) return;
      ctx.fillText(String(chapters[i].index != null ? chapters[i].index : i + 1), p.x, padT + plotH + 8);
    });

    // 平均值参考线
    var scored = chapters.filter(function (c) { return c.score !== null; });
    if (scored.length > 1) {
      var avg = scored.reduce(function (s, c) { return s + c.score; }, 0) / scored.length;
      var ya = yOf(avg);
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.moveTo(padL, ya);
      ctx.lineTo(padL + plotW, ya);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#64748b';
      ctx.fillText('均值 ' + Math.round(avg), padL + 4, ya - 3);
    }
  }

  /* ---------------- 段落改写建议 ----------------
     段落卡片里点「怎么改」，直接从原文里把"犯事的字"挑出来，
     配上引擎里那份 FIXES 的改法，一条条列给用户。
     不依赖大模型，所以是免费的、即时的、而且指得出具体位置。 */

  // 能在原文里找到确切证据的特征；找不到的就只给通用建议
  var REWRITE_EVIDENCE = {
    lex_degree:   { re: /非常|十分|极其|格外|异常|相当|颇为|尤其|最为|极度|分外/g, label: '程度副词' },
    syn_metaphor: { re: /仿佛|似乎|宛如|犹如|好似|像是|如同|恍若/g, label: '比喻词' },
    h_hedge:      { re: /可能|也许|或许|大概|似乎|好像|大致|大约|恐怕|或是/g, label: '模糊词' },
    h_absolute:   { re: /一定|必然|绝对|无疑|毫无疑问|肯定|势必|注定/g, label: '绝对化说法' },
    h_empty:      { re: /某种|一种|某个|一些|某些|一股/g, label: '空泛量词' },
    syn_gaze:     { re: /看了[他她它]一眼|目光|眼神|视线|凝视|注视|打量|瞥了/g, label: '眼神描写' },
    syn_notbut:   { re: /不是[^，。！？]{1,12}而是|并非[^，。！？]{1,12}而是/g, label: '不是…而是' },
    syn_parallel: { re: /既是[^，。！？]{1,16}又是|不但[^，。！？]{1,16}而且|不仅[^，。！？]{1,16}还/g, label: '排比套式' },
    syn_connector:{ re: /然而|因此|此外|同时|而且|并且|总之|首先|其次|最后|尽管如此/g, label: '关联词' },
    syn_tag:      { re: /淡淡地|轻轻地|微微|缓缓|静静地|默默地|悄悄地|悄然|轻声/g, label: '动作套话' },
    syn_psych:    { re: /心中|心里|心头|内心|思绪|不由得|忍不住|暗想/g, label: '心理直述' },
    lex_redupDi:  { re: /[\u4e00-\u9fa5]地|[\u4e00-\u9fa5]{2}地/g, label: '状语「地」' },
    p_excl:       { re: /[！!]/g, label: '感叹号' },
    p_ellipsis:   { re: /……/g, label: '省略号' },
    p_dash:       { re: /——/g, label: '破折号' },
    p_semicolon:  { re: /[；;]/g, label: '分号' },
    p_modal:      { re: /[吗呢吧啊呀嘛]/g, label: '语气词' },
    coh_jump:     { re: /而另一边|与此同时|话说回来|另一边/g, label: '转折词' },
    q_pred:       { re: /会[^，。]{0,6}|将[^，。]{0,6}/g, label: '预告式表达' }
  };

  /** 按句号切句，返回每句字数（去掉空白） */
  function sentenceLengths(text) {
    return String(text || '')
      .split(/[。！？!?…]+/)
      .map(function (s) { return s.replace(/\s/g, '').length; })
      .filter(function (n) { return n > 0; });
  }

  // 段落 flags 里用的是短 id（hedge / metaphor），FIXES 里是完整 id（h_hedge / syn_metaphor）。
  // 这张表把两边对上，才能拿到对应的改法。
  var SHORT_TO_FULL = {
    redup: 'lex_redup', hedge: 'h_hedge', gaze: 'syn_gaze', metaphor: 'syn_metaphor',
    psych: 'syn_psych', connector: 'syn_connector', abstract: 'lex_abstract',
    parallel: 'syn_parallel', empty: 'h_empty'
  };

  // 没有对应 FIXES 条目的短 id，单独给改法
  var SHORT_FIX = {
    len: '这段的句子都卡在中间长度（20–40 字）。挑一处压到 5 字以内，只写动作或反应；另一处拉到 60 字以上，把一个动作拆成三四个小动作连起来写。',
    sim: '这一段和上一段句式太像了。换个开头：上一段如果先写人，这段就先用环境或声音起头。',
    empty: '句子在空转——说了一堆但没推进。删掉纯议论的句子，换成具体的动作、物件或对话。'
  };

  /**
   * 生成一段的改写要点
   * 优先用引擎已经摘好的 p.hits.samples（那是真的从文里抠出来的字），
   * 再用 p.flags 补齐，最后看句长是否过于整齐。
   */
  function buildRewritePlan(p) {
    var text = p.text || '';
    var items = [];
    var covered = {};

    // ① 引擎已摘好的证据
    (p.hits || []).forEach(function (h) {
      if (covered[h.id]) return;
      covered[h.id] = 1;
      items.push({
        name: h.name,
        count: h.count || 1,
        fix: (window.AN && AN.FIXES && AN.FIXES[h.id]) || '',
        examples: Array.from(new Set(h.samples || [])).slice(0, 6),
        evLabel: '文中'
      });
    });

    // ② 段落级 flags 补齐
    (p.flags || []).slice(0, 4).forEach(function (f) {
      var full = SHORT_TO_FULL[f.id];
      if (full && covered[full]) return;
      if (full) covered[full] = 1;

      var fix = SHORT_FIX[f.id] || (full && window.AN && AN.FIXES && AN.FIXES[full]) || '';
      var examples = [];
      var ev = REWRITE_EVIDENCE[full];
      if (ev) {
        var m = text.match(ev.re) || [];
        m.forEach(function (x) {
          if (examples.indexOf(x) < 0 && examples.length < 6) examples.push(x);
        });
      }
      items.push({
        name: f.name,
        count: f.count || 1,
        fix: fix,
        examples: examples,
        evLabel: ev ? ev.label : '文中'
      });
    });

    // ③ 句长太整齐是最好改的，直接算数字给他
    var lens = sentenceLengths(text);
    if (lens.length >= 4) {
      var mn = Math.min.apply(null, lens);
      var mx = Math.max.apply(null, lens);
      if (mx - mn <= 8) {
        items.push({
          name: '句长几乎一样',
          count: lens.length,
          fix: '这段 ' + lens.length + ' 句，最长 ' + mx + ' 字、最短 ' + mn + ' 字，一个模子。' +
            '挑一处压到 4–6 字（只写动作或反应），另一处拉到 40 字以上。',
          examples: [],
          evLabel: '实测'
        });
      }
    }

    return items.filter(function (it) { return it.fix || it.examples.length; });
  }

  /** 把改写要点拼成可复制的纯文本 */
  function rewritePlanText(p, items) {
    var lines = ['第 ' + p.index + ' 段改写要点（' + (items.length) + ' 条）', ''];
    items.forEach(function (it, i) {
      lines.push((i + 1) + '. ' + it.name + (it.count > 1 ? ' ×' + it.count : ''));
      if (it.fix) lines.push('   改法：' + it.fix);
      if (it.examples.length) {
        lines.push('   文中：' + it.examples.join('、'));
      }
      lines.push('');
    });
    return lines.join('\n');
  }

  /** 渲染改写要点面板的 HTML */
  function renderRewritePanel(p) {
    var items = buildRewritePlan(p);
    if (!items.length) {
      return '<div class="rw-panel"><p class="small muted" style="margin:0">' +
        '这段没有抓到具体可改的点，读起来应该还算自然。</p></div>';
    }
    var h = ['<div class="rw-panel">'];
    h.push('<div class="rw-title">改写要点 · ' + items.length + ' 条</div>');
    items.forEach(function (it, i) {
      h.push('<div class="rw-item">');
      h.push('<div class="rw-item-head"><b>' + (i + 1) + '. ' + esc(it.name) +
        (it.count > 1 ? '<span class="rw-count">×' + it.count + '</span>' : '') + '</b></div>');
      if (it.fix) h.push('<div class="rw-fix">' + esc(it.fix) + '</div>');
      if (it.examples.length) {
        h.push('<div class="rw-ev"><span class="rw-ev-label">' + esc(it.evLabel || '文中') +
          '</span>' + it.examples.map(function (x) {
            return '<code>' + esc(x) + '</code>';
          }).join(' ') + '</div>');
      }
      h.push('</div>');
    });
    h.push('<div class="rw-actions"><button class="rw-copy" data-pi="' + p.index + '">复制要点</button></div>');
    h.push('</div>');
    return h.join('');
  }

  function drawRadar(canvas, dims) {    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var W = rect.width || 320, H = rect.height || 250;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    var cx = W / 2, cy = H / 2 + 4, R = Math.min(W, H) * 0.34;
    var n = dims.length;
    var angle = function (i) { return -Math.PI / 2 + (i * 2 * Math.PI) / n; };

    // 网格
    for (var ring = 1; ring <= 4; ring++) {
      ctx.beginPath();
      for (var i = 0; i < n; i++) {
        var a = angle(i), rr = R * ring / 4;
        var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = ring === 4 ? '#d5dae8' : '#e9ecf5';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // 轴线 + 标签
    ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var j = 0; j < n; j++) {
      var ang = angle(j);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
      ctx.strokeStyle = '#eef0f7';
      ctx.stroke();
      var lx = cx + Math.cos(ang) * (R + 22), ly = cy + Math.sin(ang) * (R + 16);
      ctx.fillStyle = '#667085';
      ctx.fillText(dims[j].name, lx, ly);
    }
    // 数据
    ctx.beginPath();
    for (var k = 0; k < n; k++) {
      var s = dims[k].score === null ? 0 : dims[k].score;
      var ang2 = angle(k), rr2 = R * Math.max(s, 2) / 100;
      var px = cx + Math.cos(ang2) * rr2, py = cy + Math.sin(ang2) * rr2;
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(79,70,229,.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(79,70,229,.85)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    for (var m = 0; m < n; m++) {
      var s2 = dims[m].score === null ? 0 : dims[m].score;
      var ang3 = angle(m), rr3 = R * Math.max(s2, 2) / 100;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang3) * rr3, cy + Math.sin(ang3) * rr3, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = s2 >= 60 ? '#dc2626' : '#4f46e5';
      ctx.fill();
    }
  }

  /* ============================================================
   * 单段检测
   * ============================================================ */

  var lastReport = null;
  var lastText = '';
  var quotaText = '';

  /* ---- 配额显示（写进主按钮里，和朱雀一样） ---- */

  function refreshQuota() {
    if (!apiOnline) return;
    fetch('api/v1/quota', { headers: apiHeaders() }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) return;
      if (j.unlimited) {
        quotaText = '（内部测试 · 不限次数）';
      } else {
        quotaText = j.remaining > 0 ? '（今日剩余 ' + j.remaining + ' 次）' : '（今日已用完）';
      }
      applyDetectLabel();
      var el = $('quota-badge');
      if (el) el.textContent = '';
    }).catch(function () { /* 忽略 */ });
  }

  function applyDetectLabel() {
    var btn = $('btn-detect');
    if (btn && !btn.disabled) btn.textContent = '立即检测' + quotaText;
  }

  /* ---- 领取 API Key ---- */

  if ($('btn-register')) {
    $('btn-register').addEventListener('click', function () {
      var name = ($('reg-name').value || '').trim();
      var invite = ($('reg-invite').value || '').trim();
      var out = $('reg-out');
      if (name.length < 2) {
        out.hidden = false;
        out.textContent = '请先填一个 2 个字以上的名字';
        return;
      }
      fetch('/api/v1/keys/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, inviteCode: invite })
      }).then(function (r) { return r.json(); }).then(function (j) {
        out.hidden = false;
        if (!j.ok) {
          out.textContent = '领取失败：' + ((j.error && j.error.message) || '未知错误');
          return;
        }
        out.textContent = (j.message || '') + '\n\n' +
          'X-API-Key: ' + j.key + '\n' +
          '名称: ' + j.name + '　套餐: ' + j.plan + '\n' +
          '额度: ' + j.tokenQuota + ' token（1 token = ' + j.tokenChars + ' 字）';
        var kEl = $('api-key');
        if (kEl) kEl.value = j.key;
      }).catch(function (e) {
        out.hidden = false;
        out.textContent = '领取失败：' + e.message;
      });
    });
  }

  /* ---- 测试记录 ---- */

  var logsCache = [];

  function loadLogs() {
    var sum = $('logs-summary');
    if (sum) sum.textContent = '读取中…';
    fetch('api/v1/logs?limit=200', { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) {
          if (sum) sum.textContent = (j && j.error && j.error.message) || '读取失败';
          return;
        }
        logsCache = j.rows || [];
        if (sum) sum.textContent = '共 ' + j.total + ' 条，独立 IP ' + j.uniqueIps + ' 个（显示最近 ' + j.returned + ' 条）';
        var tb = $('logs-body');
        if (!tb) return;
        if (!logsCache.length) {
          tb.innerHTML = '<tr><td colspan="6" class="small muted">还没有测试记录</td></tr>';
          return;
        }
        tb.innerHTML = logsCache.map(function (r) {
          var t = String(r.ts || '');
          var hhmm = t.slice(11, 19);
          var day = t.slice(5, 10);
          var vd = verdictByKey(r.verdict || 'human');
          return '<tr>' +
            '<td class="small" title="' + esc(t) + '">' + esc(day) + ' ' + esc(hhmm) + '</td>' +
            '<td class="small mono" title="' + esc(r.ua || '') + '">' + esc(r.ip) + '</td>' +
            '<td class="small">' + esc(r.role === 'internal' ? '内部' : (r.role === 'web' ? '网页' : 'Key')) + '</td>' +
            '<td class="small">' + (r.chars || 0) + '</td>' +
            '<td class="small" style="color:' + vd.color + ';font-weight:600">' + (r.score === null ? '—' : r.score) + '</td>' +
            '<td class="small" style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' +
              esc(r.text || '') + '">' + esc(String(r.text || '').slice(0, 60).replace(/\s+/g, ' ')) + '</td>' +
            '</tr>';
        }).join('');
      }).catch(function (e) {
        if (sum) sum.textContent = '读取失败：' + e.message;
      });
  }

  function exportLogsCsv() {
    if (!logsCache.length) { showTip('先点「刷新记录」'); return; }
    function q(v) { return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"'; }
    var head = ['时间', 'IP', '身份', '字数', '分数', '判定', '体裁', '内容', 'UA'];
    var lines = [head.map(q).join(',')];
    logsCache.forEach(function (r) {
      lines.push([r.ts, r.ip, r.role, r.chars, r.score, r.verdict, r.textType, r.text, r.ua].map(q).join(','));
    });
    downloadFile('aitell-testlogs-' + rTs() + '.csv', '\ufeff' + lines.join('\r\n'));
  }

  if ($('btn-logs-refresh')) $('btn-logs-refresh').addEventListener('click', loadLogs);
  if ($('btn-logs-csv')) $('btn-logs-csv').addEventListener('click', exportLogsCsv);

  /* ---- 反馈打标 ---- */

  function appendFeedback(text) {
    if (!apiOnline) return;
    // 公测用户不打标：打标区属于内部工具，外面只给结论
    if (!(lastReport && lastReport.review && lastReport.review.allowed)) {
      var gone = $('feedback-box');
      if (gone && gone.parentNode) gone.parentNode.removeChild(gone);
      return;
    }
    var old = $('feedback-box');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = 'feedback-box';
    box.innerHTML = '<div class="block-title">这条判断准吗<span class="sub">标一下，攒够样本跑 calibrate.js，系统会更准</span></div>' +
      '<div class="row" style="gap:8px">' +
      '<button class="ghost" data-fb="ai">这是 AI 写的</button>' +
      '<button class="ghost" data-fb="human">这是人写的</button>' +
      '<button class="ghost" data-fb="unsure">说不准</button>' +
      '<span class="small muted" id="fb-status"></span></div>';
    $('result-body').appendChild(box);
    box.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-fb]') : null;
      if (!b || b.disabled) return;
      sendFeedback(text, b.getAttribute('data-fb'), box);
    });
  }

  function sendFeedback(text, label, box) {
    var st = $('fb-status');
    if (st) st.textContent = '提交中…';
    fetch('api/v1/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, label: label, source: 'web' })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      var b = res.body || {};
      if (!b.ok) {
        if (st) st.textContent = '提交失败：' + ((b.error && b.error.message) || ('HTTP ' + res.status));
        return;
      }
      if (b.duplicate) {
        if (st) st.textContent = '这条已经标过了';
        return;
      }
      box.querySelectorAll('[data-fb]').forEach(function (x) { x.disabled = true; });
      var s = b.stats || {};
      if (st) {
        st.innerHTML = '已记录，共 ' + b.total + ' 条' +
          (s.ready ? '　→ 可以跑 <code class="mono">node calibrate.js</code> 了' : '　→ 每类攒到 8 条就能训练');
      }
    }).catch(function (e) {
      if (st) st.textContent = '提交失败：' + e.message;
    });
  }

  /* ---- 待检文本上直接按段染色（通过 / 存疑 / 不通过） ---- */

  var annotated = false;

  function setMode(m) {
    var ta = $('input'), av = $('annot-view');
    if (!ta || !av) return;
    if (m === 'mark' && annotated) {
      ta.classList.add('hidden');
      av.classList.remove('hidden');
    } else {
      ta.classList.remove('hidden');
      av.classList.add('hidden');
      m = 'edit';
    }
    qsa('#mode-switch button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === m);
    });
  }

  function resetAnnot() {
    annotated = false;
    var av = $('annot-view');
    if (av) { av.innerHTML = ''; av.classList.add('hidden'); }
    var sw = $('mode-switch');
    if (sw) sw.classList.add('hidden');
    hideTip();
    setMode('edit');
  }

  var TIP = {
    human: { label: '人工特征', short: '人写', color: '#16a34a',
      desc: '该片段在语言表达、思维逻辑和细节把握上，都更符合人类创作习惯。' },
    suspected: { label: '疑似 AI', short: '疑似', color: '#d97706',
      desc: '该片段命中了部分模型书写特征，也可能是人机混写或人工润色后的结果。' },
    high: { label: 'AI 特征', short: '高度怀疑', color: '#dc2626',
      desc: '该片段的句式、用词和标点高度同质，与模型的输出分布一致。' }
  };

  function pctText(v) {
    v = Number(v) || 0;
    return (v % 1 === 0 ? String(v) : v.toFixed(1)) + '%';
  }

  /** 一组句子的三档占比（按字数），结论取占比最大的那档 */
  function mixOf(list) {
    var c = { human: 0, suspected: 0, high: 0 }, tot = 0;
    list.forEach(function (s) {
      if (!s) return;
      var w = Math.max(1, s.len || 0);
      c[verdictOf(s.score).key] += w;
      tot += w;
    });
    var dom = 'human';
    if (c.suspected > c[dom]) dom = 'suspected';
    if (c.high > c[dom]) dom = 'high';
    return { tier: dom, pct: tot ? Math.round(c[dom] / tot * 1000) / 10 : 100 };
  }

  var tipEl = null;

  function ensureTip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'anno-tip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function hideTip() {
    if (tipEl) tipEl.classList.remove('show');
  }

  /** 把浮层放到元素上方（放不下翻到下方），并夹在视口内 */
  function showRaw(el, html) {
    var tip = ensureTip();
    if (tip.innerHTML !== html) tip.innerHTML = html;
    tip.classList.add('show');

    var r = el.getBoundingClientRect();
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var x = r.left + r.width / 2 - tw / 2;
    var y = r.top - th - 10;
    if (y < 8) y = r.bottom + 10;
    if (y + th > window.innerHeight - 8) y = Math.max(8, window.innerHeight - th - 8);
    x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
  }

  function showTip(el) {
    var tier = el.getAttribute('data-tier') || 'human';
    var pct = el.getAttribute('data-pct') || '0';
    var info = TIP[tier] || TIP.human;
    showRaw(el, '<div class="tip-t"><i style="background:' + info.color + '"></i>' +
      esc(info.label) + '占比：<b style="color:' + info.color + '">' + pctText(pct) + '</b></div>' +
      '<div class="tip-d">' + esc(info.desc) + '</div>');
  }

  function showInfoTip(el) {
    showRaw(el, '<div class="tip-d">' + esc(el.getAttribute('data-i') || '') + '</div>');
  }

  function renderAnnotated(r) {
    var av = $('annot-view');
    if (!av) return;
    var ps = r.paragraphs || [];
    var sents = r.sentences || [];

    // 用户常常整段粘进来不换行，这时按句子切成 ~220 字的视觉段，
    // 否则染色会退化成一整片同色，等于没标
    var rows = [];
    ps.forEach(function (p) {
      if (p.chars > 500 && (p.sents || []).length > 4) {
        var chunks = [], cur = { t: '', list: [] };
        (p.sents || []).forEach(function (idx) {
          var s = sents[idx];
          if (!s) return;
          cur.t += s.t;
          cur.list.push(s);
          if (cur.t.length >= 220) { chunks.push(cur); cur = { t: '', list: [] }; }
        });
        if (cur.list.length) chunks.push(cur);
        chunks.forEach(function (c, i) {
          var m = mixOf(c.list);
          var nm = 0;
          c.list.forEach(function (s) { nm += s.score; });
          rows.push({
            key: p.index + '-' + (i + 1),
            label: p.index + '·' + (i + 1),
            score: Math.round(nm / Math.max(c.list.length, 1)),
            text: c.t,
            tier: m.tier,
            pct: m.pct
          });
        });
      } else {
        rows.push({
          key: p.index,
          label: String(p.index),
          score: p.skip ? null : p.score,
          text: p.text,
          tier: p.skip ? 'skip' : (p.verdict || verdictOf(p.score).key),
          pct: p.skip ? null : ((typeof p.pct === 'number') ? p.pct : 100)
        });
      }
    });

    var h = [];
    var anyBad = rows.some(function (p) { return p.tier !== 'human' && p.tier !== 'skip'; });

    if (!anyBad) {
      // 全文都是人写：整块一个颜色，不再分段上色
      h.push('<div class="anno-all">' +
        '<div class="anno-all-tag">全部通过 · 人写</div>');
      rows.forEach(function (p) { h.push('<p>' + esc(p.text) + '</p>'); });
      h.push('</div>');
    } else {
      h.push('<div class="anno-legend">' +
        '<span class="lg"><i style="background:#16a34a"></i>人写</span>' +
        '<span class="lg"><i style="background:#d97706"></i>疑似 AI</span>' +
        '<span class="lg"><i style="background:#dc2626"></i>高度怀疑 AI</span>' +
        '<span class="muted">浅绿＝判定为人写　无底色＝标题或过短，未判定</span></div>');

      // 连续同类型的段落合并成一块：通过的保持素文，可疑的单独高亮
      var groups = [];
      rows.forEach(function (p) {
        // skip（标题/过短）用素文；判定人写的用浅绿；其余高亮
        var t = p.tier === 'skip' ? 'plain' : (p.tier === 'human' ? 'ok' : 'mark');
        var last = groups[groups.length - 1];
        if (last && last.type === t) last.items.push(p);
        else groups.push({ type: t, items: [p] });
      });

      groups.forEach(function (g) {
        if (g.type === 'plain') {
          h.push('<div class="anno-plain">');
          g.items.forEach(function (p) { h.push('<p>' + esc(p.text) + '</p>'); });
          h.push('</div>');
        } else if (g.type === 'ok') {
          h.push('<div class="anno-ok">');
          g.items.forEach(function (p) { h.push('<p>' + esc(p.text) + '</p>'); });
          h.push('</div>');
        } else {
          g.items.forEach(function (p) {
            var info = TIP[p.tier] || TIP.human;
            var cls = p.tier === 'high' ? 'bad' : 'warn';
            h.push('<p class="anno-para ' + cls + '" data-pi="' + esc(p.key) + '"' +
              ' data-tier="' + p.tier + '" data-pct="' + p.pct + '">' +
              '<span class="anno-tag">' + esc(info.short) + ' ' + p.score + '</span>' + esc(p.text) + '</p>');
          });
        }
      });
    }

    if (r.text && r.text.truncated) {
      h.push('<p class="anno-note">… 原文超出单次分析上限，后面的内容未参与检测（整本请用「整本拆章」）</p>');
    }
    av.innerHTML = h.join('');
    annotated = true;
  }

  $('annot-view').addEventListener('mouseover', function (e) {
    var p = e.target && e.target.closest ? e.target.closest('.anno-para') : null;
    if (p) showTip(p);
    else hideTip();
  });

  $('annot-view').addEventListener('mouseleave', hideTip);
  $('annot-view').addEventListener('scroll', hideTip);
  window.addEventListener('scroll', hideTip, true);

  $('mode-switch').addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-mode]') : null;
    if (!b) return;
    setMode(b.getAttribute('data-mode'));
  });

  $('annot-view').addEventListener('click', function (e) {
    var p = e.target && e.target.closest ? e.target.closest('[data-pi]') : null;
    if (!p) return;
    var card = document.querySelector('.para-card[data-pi="' + p.getAttribute('data-pi') + '"]');
    if (!card) {
      var box = $('result-body');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
    // 点击左边 → 右边高亮（2.6s 后自动摘掉，避免堆样式）
    setTimeout(function () { card.classList.remove('flash'); }, 2700);
  });

  /**
   * 双击左边某段 → 直接把这一段的改写要点摊开
   * 只处理双击到的那一段，其他段落的面板自动收起，不会越开越多。
   */
  $('annot-view').addEventListener('dblclick', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-pi]') : null;
    if (!el) return;
    // 句子级元素的 data-pi 是 "3-1" 这种，取前面的段落号
    var pi = String(el.getAttribute('data-pi')).split('-')[0];
    var card = document.querySelector('.para-card[data-pi="' + pi + '"]');
    if (!card) return;

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
    setTimeout(function () { card.classList.remove('flash'); }, 2700);

    // 先把其他面板收起来
    Array.prototype.slice.call(document.querySelectorAll('.rw-panel')).forEach(function (x) {
      var row = x.previousElementSibling;
      if (row && row.classList.contains('rw-row')) {
        var b = row.querySelector('.rw-btn');
        if (b) b.textContent = '怎么改';
      }
      x.remove();
    });

    var btn = card.querySelector('.rw-btn');
    if (!btn) {
      toastNear(el, '这一段没有抓到具体可改的点');
      return;
    }
    btn.click();
    // 面板插入后滚一次，保证整块都能看见
    setTimeout(function () {
      var panel = card.querySelector('.rw-panel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 260);
  });

  /** 在指定元素旁边闪一句话，1.8 秒后消失 */
  function toastNear(anchor, msg) {
    var old = document.querySelector('.tiny-toast');
    if (old) old.remove();
    var rect = anchor.getBoundingClientRect();
    var d = document.createElement('div');
    d.className = 'tiny-toast';
    d.textContent = msg;
    d.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 260)) + 'px';
    d.style.top = Math.max(8, rect.top - 34) + 'px';
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.remove(); }, 1800);
  }

  /* ---- 渲染 ---- */

  function renderError(msg, extra) {
    $('result-body').innerHTML = '<div class="notice">' + msg + (extra ? '<br><span class="small">' + extra + '</span>' : '') + '</div>';
  }

  function finishRender(r, text) {
    lastReport = r;
    lastText = text || '';
    $('result-body').innerHTML = renderReport(r);
    drawRadar($('radar'), r.dimensions);
    renderAnnotated(r);
    $('mode-switch').classList.remove('hidden');
    setMode('mark');
    appendFeedback(text);
    if (judgeReady && $('judge-toggle') && $('judge-toggle').checked) runJudge(text);
    // 手机上两栏是上下堆叠的，结果在输入框下面，不主动滚过去等于白算
    focusResultOnMobile();
  }

  /**
   * 窄屏时把结果滚进视野。
   * 桌面是左右两栏，结果一直在眼前，不需要滚。
   */
  function focusResultOnMobile() {
    if (window.innerWidth > 1080) return;
    var el = document.getElementById('result');
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      el.scrollIntoView();      // 老浏览器不支持 options
    }
    el.classList.add('flash-in');
    setTimeout(function () { el.classList.remove('flash-in'); }, 2000);
  }

  /** 👍/👎 一键反馈：同意则按判定打标，不同意就打相反标签 */
  function quickVote(agree, btn) {
    if (!apiOnline) { btn.textContent = '需服务端'; return; }
    if (!lastReport || !lastText) return;
    var v = lastReport.verdict || verdictOf(lastReport.score);
    var isAi = v.key !== 'human';
    var label = agree ? (isAi ? 'ai' : 'human') : (isAi ? 'human' : 'ai');
    var row = btn.parentNode;
    btn.disabled = true;
    fetch('api/v1/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lastText, label: label, source: 'web-vote' })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      var b = res.body || {};
      if (b.ok) {
        row.innerHTML = '<span class="small" style="color:#15803d">已记录（' +
          (label === 'ai' ? 'AI 写的' : '人写的') + '）' +
          (b.duplicate ? '，这条之前标过' : '，共 ' + b.total + ' 条样本') + '</span>';
      } else {
        row.innerHTML = '<span class="small" style="color:#b91c1c">提交失败：' +
          esc((b.error && b.error.message) || ('HTTP ' + res.status)) + '</span>';
      }
    }).catch(function (e) {
      row.innerHTML = '<span class="small" style="color:#b91c1c">提交失败：' + esc(e.message) + '</span>';
    });
  }

  function apiDetect(text, btn) {
    fetch('api/v1/detect', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text: text })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      var b = res.body || {};
      if (res.status === 429) {
        renderError('<b>今日免费检测次数已用完。</b>' + esc((b.error && b.error.message) || ''),
          '明天本地零点重置。需要更多次数：把环境变量 WEB_DAILY_LIMIT 调大后重启服务，或改用 API Key 调用。');
      } else if (!b.ok) {
        renderError('检测失败：' + esc((b.error && b.error.message) || ('HTTP ' + res.status)));
      } else {
        finishRender(b, text);
      }
      setBusy(btn, false, '立即检测');
      refreshQuota();
    }).catch(function (e) {
      localDetect(text, btn, '接口调用失败，已自动改用本地引擎：' + e.message);
    });
  }

  function localDetect(text, btn, note) {
    try {
      var r = AN.analyze(text);
      finishRender(r, text);
      if (note) {
        $('result-body').insertAdjacentHTML('afterbegin',
          '<div class="notice" style="border-color:#e4e7ec;background:#f8f9fc;color:#475467">' + esc(note) + '</div>');
      }
    } catch (e) {
      renderError('检测失败：' + esc(e.message || e));
    }
    setBusy(btn, false, '立即检测');
    applyDetectLabel();
  }

  function runDetect() {
    var ta = $('input');
    var text = ta.value.trim();
    if (!text) { ta.focus(); return; }

    var btn = $('btn-detect');
    setBusy(btn, true, '分析中');
    $('empty-state').classList.add('hidden');
    $('result-body').classList.remove('hidden');
    $('result-body').innerHTML = '<div class="spinner-row">正在计算特征并定位可疑段落…</div>';

    setTimeout(function () {
      // 走服务端才能记次数；离线（file://）直接用本地引擎
      if (apiOnline) apiDetect(text, btn);
      else localDetect(text, btn);
    }, 30);
  }

  $('btn-detect').addEventListener('click', runDetect);
  $('input').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runDetect();
  });

  $('btn-sample').addEventListener('click', function () {
    $('input').value = AN.FIXTURES[0].text;
    $('input').dispatchEvent(new Event('input'));
    runDetect();
  });

  $('btn-sample-human').addEventListener('click', function () {
    $('input').value = AN.FIXTURES[1].text;
    $('input').dispatchEvent(new Event('input'));
    runDetect();
  });

  $('btn-clear').addEventListener('click', function () {
    $('input').value = '';
    $('input').dispatchEvent(new Event('input'));
    resetAnnot();
    $('empty-state').classList.remove('hidden');
    $('result-body').classList.add('hidden');
    $('result-body').innerHTML = '';
  });

  $('btn-upload').addEventListener('click', function () { $('file-input').click(); });
  $('file-input').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    readTextFile(f, function (txt) {
      $('input').value = txt.slice(0, 200000);
      $('input').dispatchEvent(new Event('input'));
      runDetect();
    });
    e.target.value = '';
  });

  /* ---------------- 报告导出 ---------------- */

  function rTs() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' +
      String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  /* ============================================================
   * 可打印报告单（下载报告 → 浏览器另存为 PDF）
   * ============================================================ */

  /** 把连续同档的段落合并成"片段"，和朱雀的片段划分逻辑一致 */
  function buildSegments(paras) {
    var segs = [], cur = null;
    (paras || []).forEach(function (p) {
      if (p.skip) return;                       // 标题/极短行不参与分段统计
      var v = p.verdict || verdictOf(p.score).key;
      if (cur && cur.verdict === v) {
        cur.chars += p.chars;
        cur.paras.push(p);
        cur.texts.push(p.text);
        cur.sum += p.score;
      } else {
        if (cur) segs.push(cur);
        cur = { verdict: v, chars: p.chars, paras: [p], texts: [p.text], sum: p.score };
      }
    });
    if (cur) segs.push(cur);
    segs.forEach(function (s) {
      s.score = Math.round(s.sum / Math.max(s.paras.length, 1));
      s.chars = Math.max(1, s.chars);
    });
    return segs;
  }

  function fmtTime(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function buildReportHtml(r) {
    var now = new Date();
    var vd = r.verdict || verdictOf(r.score);
    var comp = r.composition || {};
    var paras = r.paragraphs || [];
    var totalChars = 0;
    paras.forEach(function (p) { totalChars += p.chars; });
    if (!totalChars) totalChars = 1;

    var segs = buildSegments(paras);
    var RING = { human: '#4caf50', suspected: '#ffb340', high: '#ff6b6b' };
    var hR = Number(comp.human && comp.human.ratio) || 0;
    var sR = Number(comp.suspected && comp.suspected.ratio) || 0;
    var aR = Math.max(0, Math.round((100 - hR - sR) * 10) / 10);

    // ---- 环形图（SVG，打印不会丢） ----
    var R = 62, CX = 110, CY = 110, STROKE = 26;
    var C = 2 * Math.PI * R;
    var parts = [
      { k: 'human', v: hR, c: RING.human },
      { k: 'suspected', v: sR, c: RING.suspected },
      { k: 'high', v: aR, c: RING.high }
    ];
    var circles = '', labels = '', acc = 0;
    parts.forEach(function (p) {
      if (p.v <= 0) return;
      var len = C * p.v / 100;
      circles += '<circle cx="' + CX + '" cy="' + CY + '" r="' + R + '" fill="none" stroke="' + p.c +
        '" stroke-width="' + STROKE + '" stroke-dasharray="' + len.toFixed(2) + ' ' + C.toFixed(2) +
        '" stroke-dashoffset="' + (-acc).toFixed(2) + '" transform="rotate(-90 ' + CX + ' ' + CY + ')"/>';
      var midPct = (acc + len / 2) / C;              // 0-1
      var ang = -Math.PI / 2 + midPct * Math.PI * 2;
      var lx = CX + Math.cos(ang) * (R + 34);
      var ly = CY + Math.sin(ang) * (R + 34);
      labels += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) +
        '" text-anchor="middle" dy=".32em" font-size="11" fill="#8a8f99">' +
        (Math.round(p.v * 100) / 100) + '%</text>';
      acc += len;
    });
    if (!circles) {
      circles = '<circle cx="' + CX + '" cy="' + CY + '" r="' + R + '" fill="none" stroke="#e9ecf3" stroke-width="' + STROKE + '"/>';
    }

    // ---- 分布条 ----
    var bar = '';
    parts.forEach(function (p) {
      if (p.v <= 0) return;
      bar += '<span style="display:block;height:100%;width:' + (p.v * 100 / 100) + '%;background:' + p.c + '"></span>';
    });

    // ---- 片段解析表 ----
    var rows = segs.map(function (s, i) {
      var sv = verdictByKey(s.verdict);
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>片段 ' + (i + 1) + '（第 ' + s.paras[0].index + '–' + s.paras[s.paras.length - 1].index + ' 段）</td>' +
        '<td style="color:' + sv.color + ';font-weight:600">' + esc(sv.label) + '</td>' +
        '<td>' + (Math.round(s.chars / totalChars * 1000) / 10) + '%</td>' +
        '<td>' + s.chars + '</td>' +
        '<td>' + s.score + '</td></tr>';
    }).join('');

    // ---- 可疑片段详情 ----
    var badSegs = segs.filter(function (s) { return s.verdict !== 'human'; });
    var detail = '';
    if (badSegs.length) {
      detail = badSegs.map(function (s) {
        var i = segs.indexOf(s) + 1;
        var sv = verdictByKey(s.verdict);
        return '<div class="seg">' +
          '<div class="seg-head"><span class="no" style="background:' + sv.color + '">NO.' + i + '</span>' +
          '<span class="nm">片段 ' + i + '</span>' +
          '<span class="val" style="color:' + sv.color + '">' + esc(sv.label) + ' · ' + s.score + ' 分 · ' +
          (Math.round(s.chars / totalChars * 1000) / 10) + '%</span></div>' +
          '<div class="seg-body">' + s.texts.map(esc).join('</p><p>').replace(/^/, '<p>') + '</p></div>' +
          '</div>';
      }).join('');
    } else {
      detail = '<p class="none">全文未发现可疑片段。</p>';
    }

    var legendRows = parts.map(function (p) {
      var sv = verdictByKey(p.k);
      return '<div class="lg"><i style="background:' + p.c + '"></i>' +
        '<span>' + esc(sv.key === 'human' ? '人工特征' : (sv.key === 'suspected' ? '疑似 AI' : 'AI 特征')) + '</span>' +
        '<b>' + (Math.round(p.v * 100) / 100) + '%</b></div>';
    }).join('');

    var stamp = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0');

    var css = [
      '*{box-sizing:border-box}',
      '@page{size:A4;margin:14mm 15mm}',
      'html,body{margin:0;padding:0}',
      'body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
      'color:#1f2329;font-size:12px;line-height:1.7;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
      '.wrap{max-width:760px;margin:0 auto;padding:16px 8px 40px}',
      '.rp-head{display:flex;justify-content:space-between;font-size:11px;color:#8a8f99;',
      'border-bottom:1px solid #e6e8ee;padding-bottom:7px;margin-bottom:34px}',
      'h1{font-size:26px;text-align:center;letter-spacing:.02em;margin:0 0 30px;font-weight:700}',
      '.meta{font-size:12.5px;color:#3b4048;margin-bottom:6px}',
      'h2{font-size:14px;margin:30px 0 14px;padding-left:9px;border-left:4px solid #3b6cf6;line-height:1.1}',
      '.result{display:flex;align-items:center;justify-content:center;gap:70px;padding:6px 0 2px}',
      '.lg{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:11px}',
      '.lg i{width:16px;height:16px;border-radius:3px;display:inline-block;flex:none}',
      '.lg b{margin-left:auto;font-variant-numeric:tabular-nums}',
      '.barbox{height:18px;border-radius:2px;overflow:hidden;display:flex;background:#eef0f5}',
      '.barleg{display:flex;gap:26px;margin-top:10px;font-size:11.5px;color:#5b616b;flex-wrap:wrap}',
      '.barleg i{width:12px;height:12px;border-radius:2px;display:inline-block;margin-right:6px;vertical-align:-1px}',
      'table{width:100%;border-collapse:collapse;font-size:11.5px}',
      'th,td{border:1px solid #e2e5eb;padding:7px 10px;text-align:left}',
      'th{background:#f7f8fa;color:#5b616b;font-weight:600}',
      'td:nth-child(1){width:44px;color:#8a8f99}',
      'td:nth-child(4),td:nth-child(5),td:nth-child(6),th:nth-child(4),th:nth-child(5),th:nth-child(6){text-align:right}',
      '.seg{margin-bottom:18px;page-break-inside:avoid;border:1px solid #e6e8ee;border-radius:4px;overflow:hidden}',
      '.seg-head{display:flex;align-items:center;gap:12px;background:#f5f7fb;padding:9px 14px;',
      'border-bottom:1px solid #e6e8ee;font-size:12px}',
      '.seg-head .no{color:#fff;font-weight:700;font-size:11px;padding:3px 10px;border-radius:3px}',
      '.seg-head .nm{color:#1f2329;font-weight:600}',
      '.seg-head .val{margin-left:auto;font-weight:600}',
      '.seg-body{padding:12px 16px;font-size:12.2px;line-height:2}',
      '.seg-body p{margin:0 0 9px;text-indent:2em}',
      '.seg-body p:last-child{margin-bottom:0}',
      '.none{color:#8a8f99;font-size:12px}',
      '.foot{margin-top:26px;padding-top:12px;border-top:1px solid #e6e8ee;font-size:10.5px;color:#8a8f99}',
      '.toolbar{position:fixed;top:0;left:0;right:0;background:#1f2329;color:#fff;padding:10px 16px;',
      'font-size:13px;display:flex;align-items:center;gap:12px;z-index:9}',
      '.toolbar button{background:#3b6cf6;color:#fff;border:0;padding:6px 16px;border-radius:6px;',
      'font-size:13px;cursor:pointer}',
      '.toolbar span{opacity:.75;font-size:12px}',
      '@media print{.toolbar{display:none}.wrap{padding-top:0}}'
    ].join('');

    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>AI 味体检 · 检测报告单</title><style>' + css + '</style></head><body>' +
      '<div class="toolbar">AI 味体检 · 检测报告单' +
      '<button onclick="window.print()">打印 / 另存为 PDF</button>' +
      '<span>在打印对话框里把「目标打印机」选成「另存为 PDF」</span></div>' +
      '<div class="wrap">' +
      '<div class="rp-head"><span>' + fmtTime(now) + '</span><span>AI味体检报告单_' + stamp + '</span></div>' +
      '<h1>AI 味体检 · 检测报告单</h1>' +
      '<div class="meta">检测时间：' + fmtTime(now) + '</div>' +
      '<div class="meta">全文 ' + r.text.cjk + ' 字　' + r.text.sentences + ' 句　' + r.text.paragraphs + ' 段　' +
      '平均句长 ' + r.text.meanSentLen + '</div>' +
      '<div class="meta">判定：<b style="color:' + vd.color + '">' + esc(vd.label) + '</b>　AI 味指数：' +
      r.score + '　置信度：' + esc(r.confidence.level) + '（±' + r.confidence.margin + '）</div>' +
      (r.fluency && r.fluency.score !== null && r.fluency.score !== undefined
        ? '<div class="meta">通顺度：' + r.fluency.score + '（' + esc(r.fluency.label) + '）' +
          (r.gate && r.gate.pass === false
            ? '　<b style="color:#b45309">综合结论：不通过（' + esc(r.gate.reason) + '）</b>' : '') + '</div>'
        : '') +

      '<h2>检测结果</h2>' +
      '<div class="result">' +
      '<div style="min-width:170px">' + legendRows + '</div>' +
      '<svg width="220" height="220" viewBox="0 0 220 220">' +
      '<circle cx="' + CX + '" cy="' + CY + '" r="' + R + '" fill="none" stroke="#eef0f5" stroke-width="' + STROKE + '"/>' +
      circles + labels + '</svg>' +
      '</div>' +

      '<h2>AI 分布图</h2>' +
      '<div class="barbox">' + bar + '</div>' +
      '<div class="barleg">' +
      '<span><i style="background:' + RING.human + '"></i>人工特征（AI 味 0–39）</span>' +
      '<span><i style="background:' + RING.suspected + '"></i>疑似 AI（40–69）</span>' +
      '<span><i style="background:' + RING.high + '"></i>AI 特征（70–100）</span>' +
      '</div>' +

      '<h2>片段解析</h2>' +
      '<table><thead><tr><th>序号</th><th>片段</th><th>结论</th><th>占全文比例</th><th>占字符数</th><th>AI 味</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +

      '<h2>检测片段详情</h2>' + detail +

      '<div class="foot">说明：本报告基于统计特征给出疑似度估计，仅为辅助判断，不应作为任何审核或处罚的决策性依据。<br>' +
      '每一条结论都能定位到原文对应段落，可供作者申诉与人工复核。　生成于 ' + fmtTime(now) + '</div>' +
      '</div>' +
      '<script>setTimeout(function(){try{window.focus();window.print();}catch(e){}},900);</script>' +
      '</body></html>';
  }

  function openReport(r) {
    if (!r) return;
    var w = window.open('', '_blank');
    if (!w) { alert('浏览器拦截了新窗口，请允许弹窗后重试'); return; }
    w.document.open();
    w.document.write(buildReportHtml(r));
    w.document.close();
  }

  function summaryText(r) {
    if (!r) return '';
    var vd = r.verdict || verdictOf(r.score);
    var lines = [];
    lines.push('【AI 味体检报告】');
    lines.push('检测时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('全文 ' + r.text.cjk + ' 字 / ' + r.text.sentences + ' 句 / ' + r.text.paragraphs + ' 段');
    lines.push('判定：' + vd.label + '　AI 味指数：' + r.score + '　置信度：' + r.confidence.level + '（±' + r.confidence.margin + '）');
    if (r.fluency && r.fluency.score !== null && r.fluency.score !== undefined) {
      lines.push('通顺度：' + r.fluency.score + '（' + r.fluency.label + '）');
    }
    if (r.gate && r.gate.pass === false) {
      lines.push('综合结论：不通过（' + r.gate.reason + '）');
    }
    lines.push('');

    var ps = r.suspiciousParagraphs || [];
    var highs = ps.filter(function (p) { return (p.verdict || verdictOf(p.score).key) === 'high'; });
    var sus = ps.filter(function (p) { return (p.verdict || verdictOf(p.score).key) === 'suspected'; });

    if (ps.length) {
      var chars = ps.reduce(function (a, b) { return a + b.chars; }, 0);
      var ratio = r.text.cjk ? Math.round(chars / r.text.cjk * 100) : 0;
      lines.push('结论：全文 ' + r.text.paragraphs + ' 段中有 ' + ps.length + ' 段越过「疑似」线' +
        (highs.length ? '，其中 ' + highs.length + ' 段达到「高度怀疑」' : '') +
        '，合计约 ' + chars + ' 字（占 ' + ratio + '%）。');
      lines.push('');

      [['高度怀疑 AI', highs], ['疑似 AI', sus]].forEach(function (grp) {
        if (!grp[1].length) return;
        lines.push('■ ' + grp[0] + '（' + grp[1].length + ' 段）');
        grp[1].forEach(function (p) {
          lines.push('  第 ' + p.index + ' 段｜' + p.score + ' 分' +
            (typeof p.pct === 'number' ? '｜该段占比 ' + pctText(p.pct) : ''));
          lines.push('　「' + (p.text.length > 100 ? p.text.slice(0, 100) + '…' : p.text) + '」');
          var ts = [];
          (p.flags || []).forEach(function (f) { ts.push(f.name + (f.count > 1 ? '×' + f.count : '')); });
          (p.hits || []).forEach(function (f) { ts.push(f.name + '×' + f.count); });
          if (ts.length) lines.push('　依据：' + ts.slice(0, 5).join('、'));
        });
        lines.push('');
      });
    } else {
      lines.push('结论：没有段落越过「疑似」线（40 分），未检出成规模的模型书写特征。');
      lines.push('');
    }

    var top = r.dimensions.filter(function (d) { return d.score !== null; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
    if (top.length && r.score >= 40) {
      lines.push('主要偏差维度：' + top.map(function (d) { return d.name + ' ' + d.score; }).join('　'));
      lines.push('');
    }
    lines.push('说明：本报告为基于统计特征的疑似度估计，不构成对文本来源的最终认定；');
    lines.push('每条结论都能定位到原文对应段落，可供作者申诉与人工复核。');
    return lines.join('\n');
  }

  function downloadFile(name, content, type) {
    var blob = new Blob([content], { type: type || 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
  }

  /* ---------------- 人工复核：推翻机器判断并记录原因 ---------------- */

  var corState = {};   // { paraIndex: {label, tags:Set} }

  function submitCorrection(pi) {
    var st = corState[pi];
    if (!st || !lastReport) return;
    var text = ($('input') && $('input').value) || '';
    if (!text.trim()) { showTip('原文为空，无法提交核对'); return; }
    var box = document.querySelector('.cor-panel[data-pi="' + pi + '"]');
    var note = box ? (box.querySelector('.cor-note').value || '') : '';

    var payload = {
      text: text,
      label: st.label,
      marked: [Number(pi)],
      reasonTags: Array.from(st.tags),
      reason: note,
      source: 'ui-correct'
    };

    fetch('/api/v1/correct', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (j) {
      var row = document.querySelector('.cor-row[data-pi="' + pi + '"]');
      if (row) {
        var done = row.querySelector('.cor-done');
        done.hidden = false;
        done.textContent = j.ok
          ? (st.label === 'human' ? '✓ 已记为人写' : '✓ 已记为 AI') + (j.added ? '·已入训练集' : '·已记录')
          : ('提交失败：' + (j.error && j.error.message ? j.error.message : '未知错误'));
        row.querySelectorAll('.cor-btn').forEach(function (b) { b.disabled = true; });
      }
      if (box) box.hidden = true;
      if (j.ok && j.stats) {
        var s = $('stats-box');
        if (s) s.textContent = '训练样本 ' + j.stats.samples.total + ' 条（AI ' + j.stats.samples.ai + ' / 人 ' + j.stats.samples.human + '）';
      }
    }).catch(function (err) {
      showTip('提交失败：' + err.message);
    });
  }

  $('result-body').addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    // 点右栏段落卡片 → 回跳左栏并高亮那段原文
    var pc = t.closest('.para-card');
    if (pc && !t.closest('button')) {
      var pi = pc.getAttribute('data-pi');
      var av = $('annot-view');
      var target = av ? av.querySelector('[data-pi="' + pi + '"]') : null;
      if (!target && av) {
        var cands = av.querySelectorAll('[data-pi^="' + pi + '-"]');
        if (cands.length) target = cands[0];
      }
      if (target) {
        setMode('mark');
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('flash-anno');
        void target.offsetWidth;
        target.classList.add('flash-anno');
        setTimeout(function () { target.classList.remove('flash-anno'); }, 2700);
        return;
      }
    }

    // 「这是人写的 / 确实是 AI」
    var cb = t.closest('.cor-btn');
    if (cb) {
      var pi = cb.getAttribute('data-pi');
      var label = cb.getAttribute('data-label');
      corState[pi] = corState[pi] || { label: label, tags: new Set() };
      corState[pi].label = label;
      var panel = document.querySelector('.cor-panel[data-pi="' + pi + '"]');
      if (panel) {
        panel.hidden = false;
        panel.querySelectorAll('.cor-tag').forEach(function (x) { x.classList.remove('on'); });
        panel.querySelector('.cor-note').value = '';
        corState[pi].tags = new Set();
        panel.querySelector('.cor-submit').textContent = label === 'human' ? '确认：这段是人写的' : '确认：这段是 AI';
      }
      return;
    }

    // 理由标签
    var tg = t.closest('.cor-tag');
    if (tg) {
      var box = tg.closest('.cor-panel');
      var pidx = box.getAttribute('data-pi');
      var tag = tg.getAttribute('data-tag');
      if (!corState[pidx]) corState[pidx] = { label: 'human', tags: new Set() };
      if (corState[pidx].tags.has(tag)) { corState[pidx].tags.delete(tag); tg.classList.remove('on'); }
      else { corState[pidx].tags.add(tag); tg.classList.add('on'); }
      return;
    }

    var sub = t.closest('.cor-submit');
    if (sub) { submitCorrection(sub.closest('.cor-panel').getAttribute('data-pi')); return; }

    var cnl = t.closest('.cor-cancel');
    if (cnl) { cnl.closest('.cor-panel').hidden = true; return; }
  });

  $('result-body').addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    // ---- 段落改写要点 ----
    var rwBtn = t.closest('.rw-btn');
    if (rwBtn) {
      var pi = Number(rwBtn.getAttribute('data-pi'));
      var row = rwBtn.closest('.rw-row');
      var next = row && row.nextElementSibling;
      if (next && next.classList.contains('rw-panel')) {
        next.remove();                       // 再点一次收起
        rwBtn.textContent = '怎么改';
        return;
      }
      var para = null;
      (lastReport && lastReport.paragraphs || []).forEach(function (x) {
        if (x.index === pi) para = x;
      });
      if (!para) return;
      row.insertAdjacentHTML('afterend', renderRewritePanel(para));
      rwBtn.textContent = '收起';
      return;
    }

    var rwCopy = t.closest('.rw-copy');
    if (rwCopy) {
      var cpi = Number(rwCopy.getAttribute('data-pi'));
      var cpara = null;
      (lastReport && lastReport.paragraphs || []).forEach(function (x) {
        if (x.index === cpi) cpara = x;
      });
      if (!cpara) return;
      var txt = rewritePlanText(cpara, buildRewritePlan(cpara));
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () {
          rwCopy.textContent = '已复制';
          setTimeout(function () { rwCopy.textContent = '复制要点'; }, 1600);
        });
      } else {
        window.prompt('复制这段：', txt);
      }
      return;
    }

    var b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b || !lastReport) return;
    var act = b.getAttribute('data-act');
    if (act === 'report') {
      openReport(lastReport);
    } else if (act === 'export') {
      downloadFile('xuanwu-report-' + rTs() + '.json', JSON.stringify(lastReport, null, 2));
    } else if (act === 'fb-up') {
      quickVote(true, b);
    } else if (act === 'fb-down') {
      quickVote(false, b);
    } else if (act === 'copy') {
      var txt = summaryText(lastReport);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () {
          var old = b.textContent;
          b.textContent = '已复制到剪贴板';
          setTimeout(function () { b.textContent = old; }, 1600);
        }).catch(function () { fallbackCopy(txt); });
      } else {
        fallbackCopy(txt);
        b.textContent = '已复制到剪贴板';
      }
    }
  });

  // 环上百分比后面的 ⓘ：悬停解释这一档是什么
  $('result-body').addEventListener('mouseover', function (e) {
    var i = e.target && e.target.closest ? e.target.closest('.ring-i') : null;
    if (i) showInfoTip(i);
    else hideTip();
  });
  $('result-body').addEventListener('mouseleave', hideTip);

  /* ============================================================
   * 整本拆章
   * ============================================================ */

  function renderChapterChart(canvas, chapters) {
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var W = rect.width || 600, H = rect.height || 220;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    var padL = 34, padR = 12, padT = 12, padB = 22;
    var cw = W - padL - padR, ch = H - padT - padB;
    var y = function (v) { return padT + ch * (1 - v / 100); };

    // 背景分区
    var zones = [[0, 39, '#f0fdf4'], [39, 59, '#fffbeb'], [59, 79, '#fff7ed'], [79, 100, '#fef2f2']];
    zones.forEach(function (z) {
      ctx.fillStyle = z[2];
      ctx.fillRect(padL, y(z[1]), cw, y(z[0]) - y(z[1]));
    });

    // 网格线
    ctx.strokeStyle = '#e7eaf3';
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#98a2b3';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 20, 40, 60, 80, 100].forEach(function (v) {
      ctx.beginPath();
      ctx.moveTo(padL, y(v));
      ctx.lineTo(W - padR, y(v));
      ctx.stroke();
      ctx.fillText(String(v), padL - 6, y(v));
    });

    var list = chapters.filter(function (c) { return c.score !== null; });
    if (!list.length) return;
    var step = list.length > 1 ? cw / (list.length - 1) : 0;
    var px = function (i) { return list.length > 1 ? padL + step * i : padL + cw / 2; };

    // 折线
    ctx.beginPath();
    list.forEach(function (c, i) {
      var X = px(i), Y = y(c.score);
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.strokeStyle = 'rgba(79,70,229,.55)';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // 点
    list.forEach(function (c, i) {
      var X = px(i), Y = y(c.score);
      ctx.beginPath();
      ctx.arc(X, Y, list.length > 60 ? 2 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = scoreColor(c.score, .95);
      ctx.fill();
    });

    // 60 分警戒线
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(padL, y(60));
    ctx.lineTo(W - padR, y(60));
    ctx.strokeStyle = '#f59e0b';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function runChapters() {
    var text = $('ch-input').value.trim();
    if (!text) { $('ch-input').focus(); return; }
    var btn = $('btn-ch-run');
    setBusy(btn, true, '拆章分析中');
    $('ch-result').innerHTML = '<div class="spinner-row">正在逐章分析，章节多时需要几秒…</div>';

    setTimeout(function () {
      try {
        var r = AN.analyzeChapters(text);
        var h = [];
        h.push('<div class="row" style="justify-content:space-between">');
        h.push('<div class="row">' +
          '<span class="chip">共 ' + r.chapterCount + ' 章</span>' +
          '<span class="chip" style="background:#fee2e2;border-color:#fecaca;color:#b91c1c">高度怀疑 ' + (r.highCount || 0) + ' 章</span>' +
          '<span class="chip" style="background:#fef3c7;border-color:#fde68a;color:#b45309">疑似 ' + (r.suspectedCount || 0) + ' 章</span>' +
          '<span class="chip" style="background:#dcfce7;border-color:#bbf7d0;color:#15803d">人写 ' + (r.humanCount || 0) + ' 章</span></div>');
        h.push('<div class="row"><span class="chip">全书 ' + scorePill(r.overall) + ' · ' + esc(verdictOf(r.overall).label) + '</span></div>');
        h.push('</div>');
        if (r.warning) h.push('<p class="small muted mt8">' + esc(r.warning) + '</p>');
        h.push('<div class="chart-wrap mt16"><canvas id="chapter-chart"></canvas></div>');
        h.push('<div class="tbl-scroll mt16"><table class="tbl"><thead><tr>' +
          '<th>#</th><th>标题</th><th>字数</th><th>AI 味</th><th>判定</th><th>主要偏差</th></tr></thead><tbody>');
        r.chapters.forEach(function (c) {
          var cv = c.score === null ? null : verdictOf(c.score);
          h.push('<tr><td class="num">' + c.index + '</td><td>' + esc(c.title) + '</td>' +
            '<td class="num">' + c.chars.toLocaleString() + '</td>' +
            '<td>' + scorePill(c.score) + '</td>' +
            '<td class="small" style="font-weight:600;color:' + (cv ? cv.color : '#98a2b3') + '">' +
            (cv ? esc(cv.label) : '—') + '</td>' +
            '<td class="small muted">' + esc(c.error || (c.findings || []).slice(0, 2).join('、') || '—') + '</td></tr>');
        });
        h.push('</tbody></table></div>');
        $('ch-result').innerHTML = h.join('');
        $('ch-summary').textContent = '全书 ' + r.overall + ' 分 · 高度怀疑 ' + (r.highCount || 0) +
          ' / 疑似 ' + (r.suspectedCount || 0) + ' / 人写 ' + (r.humanCount || 0);
        drawChapterChart($('chapter-chart'), r.chapters);
        window.__lastChapters = r;
      } catch (e) {
        $('ch-result').innerHTML = '<div class="notice">分析失败：' + esc(e.message || e) + '</div>';
      } finally {
        setBusy(btn, false, '开始拆章');
      }
    }, 30);
  }

  $('btn-ch-run').addEventListener('click', runChapters);
  $('btn-ch-upload').addEventListener('click', function () { $('ch-file').click(); });
  $('ch-file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    readTextFile(f, function (txt) {
      $('ch-input').value = txt.slice(0, 2000000);
      $('ch-input').dispatchEvent(new Event('input'));
      runChapters();
    });
    e.target.value = '';
  });
  $('btn-ch-sample').addEventListener('click', function () {
    var a = AN.FIXTURES[0].text, b = AN.FIXTURES[1].text;
    $('ch-input').value = '第一章 夜雨\n\n' + a + '\n\n第二章 楼道\n\n' + b + '\n\n第三章 回声\n\n' + a;
    $('ch-input').dispatchEvent(new Event('input'));
    runChapters();
  });

  /* ============================================================
   * 批量
   * ============================================================ */

  var batchData = [];

  function renderBatch(rows) {
    var h = ['<div class="tbl-scroll"><table class="tbl"><thead><tr>' +
      '<th>#</th><th>名称</th><th>字数</th><th>AI 味</th><th>判定</th><th>置信度</th><th>主要命中</th></tr></thead><tbody>'];
    rows.forEach(function (r, i) {
      h.push('<tr><td class="num">' + (i + 1) + '</td>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td class="num">' + (r.chars || 0).toLocaleString() + '</td>' +
        '<td>' + scorePill(r.score) + '</td>' +
        '<td class="small">' + esc(r.band || r.error || '—') + '</td>' +
        '<td class="small muted">' + esc(r.confidence || '—') + '</td>' +
        '<td class="small muted">' + esc((r.findings || []).slice(0, 2).join('、') || '—') + '</td></tr>');
    });
    h.push('</tbody></table></div>');
    return h.join('');
  }

  function runBatch() {
    var raw = $('batch-input').value;
    if (!raw.trim()) { $('batch-input').focus(); return; }
    var parts = raw.split(/\n\s*={3,}\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return;

    var btn = $('btn-batch-run');
    setBusy(btn, true, '批量分析中');
    $('batch-status').textContent = '共 ' + parts.length + ' 段';

    setTimeout(function () {
      var rows = [];
      parts.forEach(function (t, i) {
        var name = '段落 ' + (i + 1);
        var firstLine = t.split('\n')[0].trim();
        if (firstLine && firstLine.length <= 24) name = firstLine;
        try {
          var r = AN.analyze(t);
          rows.push({
            name: name, chars: r.text.cjk, score: r.score, band: r.verdict.label,
            confidence: r.confidence.level,
            findings: r.findings.map(function (f) { return f.title.split('：')[0]; })
          });
        } catch (e) {
          rows.push({ name: name, chars: t.length, score: null, error: e.message });
        }
      });
      batchData = rows;
      $('batch-result').innerHTML = renderBatch(rows);
      var avg = rows.filter(function (x) { return x.score !== null; });
      avg = avg.length ? Math.round(avg.reduce(function (a, b) { return a + b.score; }, 0) / avg.length) : 0;
      $('batch-status').textContent = rows.length + ' 段完成，平均 ' + avg + ' 分';
      setBusy(btn, false, '批量检测');
    }, 30);
  }

  $('btn-batch-run').addEventListener('click', runBatch);
  $('btn-batch-clear').addEventListener('click', function () {
    $('batch-input').value = '';
    $('batch-result').innerHTML = '';
    $('batch-status').textContent = '';
    batchData = [];
  });
  $('btn-batch-files').addEventListener('click', function () { $('batch-files').click(); });
  $('batch-files').addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    if (!files.length) return;
    var texts = [], done = 0;
    files.forEach(function (f, i) {
      readTextFile(f, function (txt) {
        texts[i] = '【' + f.name.replace(/\.(txt|md)$/i, '') + '】\n' + txt;
        if (++done === files.length) {
          $('batch-input').value = texts.join('\n=====\n').slice(0, 1000000);
          runBatch();
        }
      });
    });
    e.target.value = '';
  });
  $('btn-batch-csv').addEventListener('click', function () {
    if (!batchData.length) { $('batch-status').textContent = '还没有结果可导出'; return; }
    var lines = ['名称,字数,AI味指数,判定,置信度,主要命中'];
    batchData.forEach(function (r) {
      var cells = [r.name, r.chars || 0, r.score === null ? '' : r.score, r.band || r.error || '',
        r.confidence || '', (r.findings || []).join(' / ')];
      lines.push(cells.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','));
    });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'xuanwu-batch-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });

  /* ============================================================
   * 对照
   * ============================================================ */

  $('btn-cmp-run').addEventListener('click', function () {
    var ta = $('cmp-a').value.trim(), tb = $('cmp-b').value.trim();
    var st = $('cmp-status');
    if (!ta || !tb) { st.textContent = '两段都要填'; return; }
    var ra, rb;
    try { ra = AN.analyze(ta); rb = AN.analyze(tb); }
    catch (e) { st.textContent = '分析失败：' + e.message; return; }

    var diff = rb.score - ra.score;
    var h = [];
    h.push('<div class="row" style="justify-content:space-between">');
    h.push('<div class="row"><span class="chip">A 基线 ' + scorePill(ra.score) + '</span>' +
      '<span class="chip">B 待测 ' + scorePill(rb.score) + '</span>' +
      '<span class="chip ' + (diff >= 15 ? 'warn' : '') + '">差值 ' + (diff > 0 ? '+' : '') + diff + '</span></div>');
    h.push('<div class="small muted">' + (diff >= 15 ? 'B 明显比 A 更像模型输出' : (diff <= -15 ? 'B 比 A 更自然' : '两者差异不明显')) + '</div></div>');

    h.push('<div class="tbl-scroll mt16"><table class="tbl"><thead><tr>' +
      '<th>维度</th><th>A 基线</th><th>B 待测</th><th>差值</th><th>解读</th></tr></thead><tbody>');
    rb.dimensions.forEach(function (d, i) {
      var a = ra.dimensions[i];
      var dv = (d.score !== null && a.score !== null) ? d.score - a.score : null;
      var read = dv === null ? '数据不足' : (dv >= 15 ? 'B 显著更机械' : (dv <= -15 ? 'B 更自然' : '基本持平'));
      h.push('<tr><td>' + esc(d.name) + '</td><td>' + scorePill(a.score) + '</td><td>' + scorePill(d.score) + '</td>' +
        '<td class="num">' + (dv === null ? '—' : (dv > 0 ? '+' : '') + dv) + '</td>' +
        '<td class="small muted">' + read + '</td></tr>');
    });
    h.push('</tbody></table></div>');

    h.push('<div class="block-title">B 相对 A 多出来的套路</div><div class="findings">');
    var onlyB = rb.findings.filter(function (f) {
      return !ra.findings.some(function (x) { return x.id === f.id; }) && f.severity !== 'low';
    }).slice(0, 6);
    if (!onlyB.length) {
      h.push('<p class="small muted">没有 B 独有而 A 没有的强命中。</p>');
    } else {
      onlyB.forEach(function (f) {
        h.push('<div class="finding ' + f.severity + '"><div class="fh"><strong>' + esc(f.title) + '</strong>' +
          '<span class="metric">' + esc(f.metric) + '</span></div>' +
          '<div class="fdesc">' + esc(f.desc) + '</div>' +
          (f.evidence && f.evidence.length ? '<div class="evidences"><q>' + esc(f.evidence[0]) + '</q></div>' : '') +
          '</div>');
      });
    }
    h.push('</div>');

    $('cmp-result').innerHTML = h.join('');
    st.textContent = '';
  });

  /* ============================================================
   * API 页
   * ============================================================ */

  var apiOnline = false;
  var judgeReady = false;

  function checkApi() {
    var mode = $('api-mode'), note = $('api-note');
    if (location.protocol === 'file:') {
      mode.textContent = '本地文件模式';
      note.textContent = '当前是用 file:// 直接打开的页面，没有服务端。要在线试用接口，请在项目目录执行 node server.js，然后用 http://127.0.0.1:8787 打开本页。';
      return;
    }
    fetch('api/v1/health').then(function (r) { return r.json(); }).then(function (j) {
      apiOnline = !!(j && j.ok);
      mode.textContent = apiOnline ? '服务在线' : '服务未响应';
      note.textContent = apiOnline
        ? '已连上本地 API 服务（引擎 ' + (j.engine || '') + ' v' + (j.version || '') + '）。填入 Key 即可试调。'
        : '能打开页面但接口没响应，可能后端未启动。';

      judgeReady = !!(j && j.judge && j.judge.enabled);
      var wrap = $('judge-wrap'), tg = $('judge-toggle');
      if (judgeReady && wrap && tg) {
        tg.disabled = false;
        wrap.style.cursor = 'pointer';
        wrap.style.background = '#fff';
        wrap.style.color = '#344054';
        wrap.style.borderColor = '#c7d2fe';
        wrap.title = '已接入 ' + j.judge.model + '：勾选后会在本地结果之外，追加一份大模型给出的独立意见';
      }
      refreshQuota();
    }).catch(function () {
      mode.textContent = '服务未响应';
      note.textContent = '接口无响应，请确认 node server.js 正在运行。';
    });
  }

  /* ---------------- 大模型裁判 ---------------- */

  function renderJudge(body, status) {
    var j = body && body.judge;
    if (!j) {
      return '<div class="notice">裁判接口没有返回结果（' + status + '）</div>';
    }
    if (!j.ok) {
      return '<div class="notice"><b>大模型裁判不可用：</b>' + esc((j.error && j.error.message) || '未知错误') + '</div>';
    }
    var c = body.combined;
    var h = ['<div class="block-title">大模型裁判<span class="sub">' + esc(j.model) + ' · 独立打分，仅供参考</span></div>'];
    h.push('<div class="score-row" style="gap:16px">');
    h.push('<div class="gauge" style="--pct:' + j.score + ';--color:' + scoreColor(j.score, .95) + ';width:104px;height:104px">' +
      '<div class="gauge-inner"><b style="font-size:26px">' + j.score + '</b><span>模型判断</span></div></div>');
    h.push('<div class="verdict"><span class="band" style="background:' + scoreColor(j.score, .12) + ';color:' + scoreColor(j.score, .95) + '">' +
      esc(j.verdict || '—') + '</span>');
    if (c) {
      h.push('<div class="meta mt8"><span class="chip">规则引擎 ' + c.heuristic + '</span>' +
        '<span class="chip">模型 ' + c.judge + '</span>' +
        '<span class="chip ' + (c.gap >= 25 ? 'warn' : 'ok') + '">合成 ' + c.combined + '</span></div>');
      h.push('<p class="small" style="margin-top:7px;color:' + (c.gap >= 25 ? '#b54708' : '#475467') + '">' + esc(c.note) + '</p>');
    }
    h.push('</div></div>');

    if (j.reasons && j.reasons.length) {
      h.push('<div class="fix" style="background:#f8fafc;border-color:#e2e8f0;color:#334155"><b>它为什么这么判：</b><br>' +
        j.reasons.map(function (r) { return '· ' + esc(r); }).join('<br>') + '</div>');
    }
    if (j.spans && j.spans.length) {
      h.push('<div class="evidences mt8">');
      j.spans.forEach(function (s) {
        h.push('<q>' + esc(s.text) + '　<span class="muted">— ' + esc(s.why) + '</span></q>');
      });
      h.push('</div>');
    }
    if (j.humanSignals && j.humanSignals.length) {
      h.push('<div class="fix mt8" style="background:#f0fdf4;border-color:#bbf7d0;color:#14532d"><b>像人写的地方：</b>' +
        j.humanSignals.map(esc).join('；') + '</div>');
    }
    return h.join('');
  }

  function runJudge(text) {
    var host = $('result-body');
    var old = $('judge-box');
    if (old) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.id = 'judge-box';
    box.innerHTML = '<div class="spinner-row">大模型裁判正在读这段文字…</div>';
    host.appendChild(box);

    fetch('api/v1/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      box.innerHTML = renderJudge(res.body, res.status);
    }).catch(function (e) {
      box.innerHTML = '<div class="notice">大模型裁判调用失败：' + esc(e.message) + '</div>';
    });
  }

  $('btn-api-call').addEventListener('click', function () {
    var key = $('api-key').value.trim();
    var ep = $('api-ep').value;
    var text = $('api-text').value;
    var out = $('api-out'), st = $('api-status');
    if (!apiOnline) { out.textContent = '// 需要先启动 node server.js 并用 http://127.0.0.1:8787 打开本页'; return; }
    st.textContent = '请求中…';
    fetch('api/v1/' + ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ text: text })
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        var body = res.body;
        if (body && body.dimensions) {
          body = Object.assign({}, body);
          body.sentences = (body.sentences || []).length + ' 句（已省略明细）';
        }
        out.textContent = res.status + ' ' + JSON.stringify(body, null, 2);
        st.textContent = res.status === 200 ? '成功' : '失败';
      })
      .catch(function (e) { out.textContent = '// 请求失败：' + e.message; st.textContent = ''; });
  });

  /* ============================================================
   * 训练面板
   * ============================================================ */

  function loadStats() {
    var total = $('t-total'), split = $('t-split'), acc = $('t-acc'), aucEl = $('t-auc'), hint = $('train-hint');
    if (!apiOnline) {
      if (total) total.textContent = '—';
      if (hint) hint.innerHTML = '需要先启动 <code class="mono">node server.js</code> 并用 http 地址打开本页，才能统计样本。';
      return;
    }
    fetch('api/v1/stats').then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) return;
      var s = j.samples || {}, a = j.accuracy || {};
      if (total) total.textContent = (s.total || 0) + ' 条';
      if (split) split.textContent = 'AI ' + (s.ai || 0) + ' / 人 ' + (s.human || 0);
      if (acc) acc.textContent = (a.at50 === null || a.at50 === undefined) ? '样本不足' : a.at50 + '%';
      if (aucEl) aucEl.textContent = (a.auc === null || a.auc === undefined) ? '样本不足' : a.auc;

      var h = [];
      if (j.calibration && j.calibration.applied) {
        h.push('<b>校准已启用</b>：' + j.calibration.features + ' 项特征参与，训练于 ' +
          esc(String(j.calibration.createdAt || '').slice(0, 19)).replace('T', ' ') + '。');
      } else {
        h.push('当前用的是<b>默认锚点</b>，还没校准过。');
      }
      var needAi = Math.max(0, 8 - (s.ai || 0)), needHu = Math.max(0, 8 - (s.human || 0));
      if (needAi || needHu) {
        h.push('还不能训练：AI 类还差 ' + needAi + ' 条，人类类还差 ' + needHu + ' 条（每类至少 8 条，30 条以上才有明显效果）。');
      } else {
        h.push('样本够了，去命令行执行 <code class="mono">node calibrate.js</code>；跑完它会打印留出集的准确率变化。');
      }
      if (a.avgAi !== null && a.avgAi !== undefined) {
        h.push('平均分：AI 样本 ' + a.avgAi + ' 分，人类样本 ' + a.avgHuman + ' 分。两者差得越大，判定越稳。');
      }
      if (hint) hint.innerHTML = h.join('<br>');
    }).catch(function (e) {
      if (hint) hint.textContent = '读取失败：' + e.message;
    });
  }

  $('btn-stats-refresh').addEventListener('click', function () {
    fetch('api/v1/stats?refresh=1').then(function () { loadStats(); }).catch(function () { loadStats(); });
  });

  /* ============================================================
   * 自检
   * ============================================================ */

  $('btn-selftest').addEventListener('click', function () {
    var out = $('selftest-out');
    try {
      var r = AN.selfTest();
      out.innerHTML = r.results.map(function (x) {
        var ok = x.pass ? 'color:#15803d' : 'color:#b91c1c';
        return '<span style="' + ok + ';margin-right:16px">' + (x.pass ? '✓' : '✗') + ' ' +
          esc(x.label) + '：' + (x.score === null ? '出错 ' + esc(x.error)
            : x.score + ' 分 · ' + esc(x.verdict || '')) + '</span>';
      }).join('') + '<span class="muted">（' + (r.passed ? '方向正确' : '方向异常，请把结果反馈给我') + '）</span>';
    } catch (e) {
      out.textContent = '自检异常：' + e.message;
    }
  });

  /* ---------------- 初始化 ---------------- */

  if (window.AN) {
    $('ver').textContent = 'v' + AN.version;
  } else {
    document.body.insertAdjacentHTML('afterbegin',
      '<div class="notice" style="margin:16px">引擎加载失败：assets/engine.js 没有正确加载，请确认目录结构完整。</div>');
  }
  checkApi();

  window.addEventListener('resize', function () {
    if (lastReport) drawRadar($('radar'), lastReport.dimensions);
    if (window.__lastChapters) drawChapterChart($('chapter-chart'), window.__lastChapters.chapters);
  });
})();
