/*!
 * 玄武 · 小说 AI 味检测引擎  Xuanwu AITell Engine v1.0.0
 * 浏览器与 Node 共用（UMD）。零依赖。
 *
 * 设计原则：
 *   1. 可解释优先——每个特征都给"实测值 / 人类参考 / AI 参考"，不做黑箱打分。
 *   2. 防御式实现——每个特征独立 try/catch，单个特征出错不影响整体。
 *   3. 结论留余地——短文本强制降级置信度，绝不给"判定"。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.AN = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULT_MAX_CHARS = 60000;

  /* ============================================================
   * 一、维度与判定区间
   * ============================================================ */

  var DIMS = [
    { key: 'rhythm',  name: '句式节奏', weight: 1.15, desc: '句长分布、短句率、段落松紧度' },
    { key: 'lexicon', name: '用词习惯', weight: 1.10, desc: '叠词、成语、抽象词与具体物的配比' },
    { key: 'syntax',  name: '套路句式', weight: 1.30, desc: '固定搭配、三连排比、比喻与表情模板' },
    { key: 'grammar', name: '语病杂糅', weight: 1.30, desc: '语义重复、句式杂糅、主语残缺、关联词残缺、一逗到底' },
    { key: 'coherence', name: '逻辑松散', weight: 1.00, desc: '前言不搭后语、车轱辘话、前后矛盾' },
    { key: 'punct',   name: '标点口语', weight: 1.00, desc: '标点丰富度、语气词、网络用语' },
    { key: 'repeat',  name: '重复自噬', weight: 0.95, desc: '复读、句首雷同、相邻句自我模仿' },
    { key: 'imagery', name: '意象感官', weight: 0.90, desc: '视觉垄断、具体动作、对话占比' },
    { key: 'hedge',   name: '空转密度', weight: 1.15, desc: '模糊限定词、抽象空转、升华收尾' },
    { key: 'predict', name: '可预测性', weight: 0.55, desc: 'n-gram 条件熵（困惑度代理，实验性）' }
  ];

  var BANDS = [
    { min: 0,  max: 19,  key: 'human',   label: '人类特征明显',   color: '#16a34a', advice: '节奏、用词、标点都在人类写作区间内。' },
    { min: 20, max: 39,  key: 'likely-human', label: '偏人类书写', color: '#65a30d', advice: '整体像人写的，个别指标略规整，不必处理。' },
    { min: 40, max: 59,  key: 'mixed',   label: '特征混合·无法定论', color: '#d97706', advice: '既有人的痕迹也有模型的规整感，常见于「人机混写」或「AI 初稿人工润色」。' },
    { min: 60, max: 79,  key: 'ai-lean', label: 'AI 痕迹较明显',  color: '#ea580c', advice: '多处命中典型模型腔，建议按证据逐条改写。' },
    { min: 80, max: 100, key: 'ai',      label: '高度疑似 AI 生成', color: '#dc2626', advice: '套路词、句式、标点全面落在模型分布上。' }
  ];

  function bandOf(score) {
    for (var i = BANDS.length - 1; i >= 0; i--) { if (score >= BANDS[i].min) return BANDS[i]; }
    return BANDS[0];
  }

  /* 对外的三档结论（和朱雀一致）：人写 / 疑似 AI / 高度怀疑 AI */
  var VERDICTS = [
    { key: 'human', label: '人写', short: '人写', min: 0, max: 39, color: '#16a34a',
      desc: '未检出成规模的机器书写特征。',
      advice: '可以直接通过。' },
    { key: 'suspected', label: '疑似 AI', short: '疑似', min: 40, max: 69, color: '#d97706',
      desc: '命中了部分模型书写特征，也可能是人机混写或 AI 初稿人工润色。',
      advice: '建议人工复核，占全文比例超过 30% 时再走下一步。' },
    { key: 'high', label: '高度怀疑 AI', short: '高度怀疑', min: 70, max: 100, color: '#dc2626',
      desc: '多项模型书写特征同时命中，且分布集中在模型一侧。',
      advice: '建议要求作者说明创作过程，或提供修改记录。' }
  ];

  function verdictOf(score) {
    for (var i = VERDICTS.length - 1; i >= 0; i--) { if (score >= VERDICTS[i].min) return VERDICTS[i]; }
    return VERDICTS[0];
  }

  /* ============================================================
   * 二、词表（全部可审计，改这里就能改判定口味）
   * ============================================================ */

  var LEX = {};

  // 叠词副词——中文 AI 最致命的指纹之一
  LEX.redup = ('轻轻 缓缓 淡淡 微微 静静 慢慢 深深 默默 渐渐 悄悄 悠悠 柔柔 暖暖 冷冷 沉沉 ' +
    '暗暗 偷偷 连连 细细 紧紧 牢牢 浅浅 重重 缓缓 簌簌 隐隐 隐隐 幽幽 沉沉 凉凉 暖暖').split(' ');

  LEX.hedge = ('似乎 仿佛 好像 好似 某种 莫名 说不清 难以形容 无法言喻 不言而喻 下意识 不由得 ' +
    '不由自主 不知不觉 隐隐 隐约 或许 也许 大概 似乎 一丝 一抹 一缕 些许 略微 稍稍 ' +
    '仿佛置身 一种说不清 令人难以 无法用言语').split(' ');

  LEX.connector = ('然而 于是 紧接着 与此同时 旋即 随即 顿时 瞬间 终于 此刻 就在这时 而后 ' +
    '随后 继而 片刻后 沉默片刻 许久 半晌 良久').split(' ');

  LEX.psych = ('他知道 她知道 我知道 他明白 她明白 我明白 意识到 清楚地感觉到 感觉到 心中一紧 ' +
    '心中一沉 心中一暖 心头一暖 心头一紧 心口一窒 心里一紧 五味杂陈 思绪万千 心中一颤 ' +
    '心下了然 心中暗道 心里五味杂陈 心头一颤 心里一沉').split(' ');

  LEX.tag = ('说道 问道 答道 笑道 回答道 开口道 沉声道 低声道 轻声道 补充道 解释道 提醒道 ' +
    '淡淡道 冷冷道 缓缓道 叹道 嚷道 吼道 咕哝道 低声说 轻声说 冷冷地说 淡淡地说 笑着说 ' +
    '摇了摇头 点了点头').split(' ');

  LEX.abstract = ('命运 宿命 时间 岁月 世界 一切 人生 灵魂 心底 内心深处 气氛 情绪 力量 存在 ' +
    '意义 真相 记忆 温度 沉默 寂静 空气 念头 感觉 情感 欲望 孤独 恐惧 希望 绝望 执着 ' +
    '信仰 自由 生死 永恒 光影 时光 未来 过去 此刻 瞬间 感受 生命 万物 众生 天地 沧桑 ' +
    '尘埃 沉重 温柔 荒芜 虚无 救赎 归属 边界 尽头 边缘 深处 世界 秩序 因果').split(' ');

  LEX.concrete = ('桌子 椅子 窗户 门 灯 刀 剑 碗 筷子 鞋 车 树 石头 墙 地板 床 沙发 杯子 ' +
    '手机 书 纸 笔 衣服 头发 手指 血 雨 风 雪 水 火 烟 酒 饭 钱 钥匙 楼梯 玻璃 铁 ' +
    '木 布 绳 袋子 盒子 帽子 镜子 钟 表 被子 枕头 毛巾 抽屉 柜子 垃圾桶 电线 插座 ' +
    '台阶 门槛 栏杆 墙角 屋顶 地板 香烟 打火机 钱包 眼镜 口罩 外套 拖鞋 碗筷 灶台 ' +
    '外卖 耳机 电脑 屏幕 电梯 工位 邮件 豆浆 可乐 矿泉水 饭盒 烟头 被单 塑料袋 快递 ' +
    '键盘 鼠标 充电器 数据线 奶茶 烤串 火锅 泡面 啤酒 冰箱 空调 洗衣机 微波炉 报表 ' +
    '发票 会员卡 银行卡 病历 车票 伞 水杯 药片 门把手 沙发垫 遥控器 电视 台灯 窗帘').split(' ');

  LEX.idiom = ('五味杂陈 不寒而栗 恍如隔世 油然而生 如释重负 心照不宣 莫名其妙 若有所思 意味深长 ' +
    '波澜不惊 尘埃落定 岁月静好 惊心动魄 触目惊心 不假思索 不由自主 小心翼翼 情不自禁 ' +
    '无动于衷 前所未有 一如既往 不容置疑 不置可否 怅然若失 一往情深 心不在焉 无所适从 ' +
    '若隐若现 若即若离 如影随形 挥之不去 无法释怀 刻骨铭心 记忆犹新 历历在目 栩栩如生 ' +
    '呼之欲出 扑面而来 沁人心脾 心旷神怡 眼花缭乱 目瞪口呆 哑口无言 不露声色 不动声色 ' +
    '泰然自若 从容不迫 游刃有余 一针见血 一语中的 言简意赅 耐人寻味 发人深省 醍醐灌顶 ' +
    '豁然开朗 恍然大悟 如梦初醒 鬼使神差 鬼斧神工 深不见底 不言而喻 相视一笑 心领神会 ' +
    '如鲠在喉 五内俱焚 肝肠寸断 心如刀绞 万念俱灰 欣喜若狂 怒火中烧 泪如雨下').split(' ');

  LEX.modal = ('啊 呀 吧 嘛 呢 呗 哈 唉 嗯 哎 哦 噢 呃 嘿 哼 哟 咯 呐 喔 啦 嘞').split(' ');

  LEX.slang = ('卧槽 我靠 靠 他妈 特么 妈的 傻 呸 滚 老子 牛逼 屌 妈蛋 咋 啥 娘的 拉倒 ' +
    '得瑟 靠谱 你丫 孙子 装逼 扯淡 娘的 老天 我的天 我去 行吧 随便 反正').split(' ');

  LEX.degree = ('极其 无比 格外 愈发 越发 异常 十分 非常 尤为 格外 愈加 无比 极度 极为').split(' ');

  LEX.emotion = ('恐惧 愤怒 悲伤 喜悦 焦虑 绝望 温暖 心疼 苦涩 无奈 困惑 惊讶 忐忑 不安 ' +
    '兴奋 失落 难过 委屈 羞愧 愧疚 痛苦 幸福 怅惘 烦闷').split(' ');

  LEX.body = ('抬手 弯腰 转身 推开 攥紧 揉了揉 踢 抓 递 摔 拎 蹲下 撑着 扯 拽 拍 敲 ' +
    '掐 踹 迈步 低头 抬头 点头 摇头 伸手 缩回 咬 咽 吐 擦 抱 扛 扶 按 撕 剥 灌 塞').split(' ');

  LEX.sensory = {
    visual: '看 望 见 瞧 盯 瞟 光 亮 色 影 暗 明 眼 脸 面 容 颜 白 红 黑 青 蓝 灰 亮 闪'.split(' '),
    audio: '听 声 响 音 鸣 噪 喧 静 寂静 嘶 吼 喊 叫 喝'.split(' '),
    smell: '闻 香 臭 味 腥 甜腻 呛'.split(' '),
    taste: '尝 甜 苦 辣 酸 咸 涩 腻'.split(' '),
    touch: '触 摸 冷 热 暖 凉 湿 干 硬 软 痛 疼 麻 痒 烫 冰'.split(' ')
  };

  /* 句级套路正则（同时用于全局命中统计） */
  var SENT_PATTERNS = [
    { id: 'redup',    name: '叠词副词',      w: 1.0, re: /轻轻|缓缓|淡淡|微微|静静|慢慢|深深|默默|渐渐|悄悄|悠悠|柔柔|暖暖|冷冷|沉沉/g },
    { id: 'hedge',    name: '模糊限定',      w: 1.0, re: /似乎|仿佛|好像|某种|莫名|说不清|难以形容|无法言喻|下意识|不由得|不由自主|不知不觉|隐隐|隐约|或许|也许/g },
    { id: 'gaze',     name: '眼神表情套路',  w: 1.2, re: /眼底|眼中|眼里|眼神里|嘴角勾起|勾起一抹|一抹弧度|深吸一口气|瞳孔.{0,2}缩|睫毛.{0,2}颤|眉头.{0,2}皱/g },
    { id: 'metaphor', name: '比喻套式',      w: 1.0, re: /仿佛|宛如|犹如|好似|如同|宛若|恰似|像.{0,12}(一样|一般|似的)/g },
    { id: 'psych',    name: '心理直述',      w: 1.0, re: /他知道|她知道|我明白|意识到|清楚地感觉到|心中一紧|心中一沉|心中一暖|心头一暖|心头一紧|五味杂陈|思绪万千/g },
    { id: 'connector',name: '万能转折',      w: 0.8, re: /然而|于是|紧接着|与此同时|旋即|随即|顿时|就在这时|片刻后|沉默片刻|半晌|良久/g },
    { id: 'abstract', name: '抽象大词',      w: 0.9, re: /命运|宿命|时间|岁月|世界|一切|人生|灵魂|内心深处|意义|真相|永恒|尘埃|荒芜|救赎/g },
    { id: 'parallel', name: '排比堆叠',      w: 1.0, re: /不是.{1,20}而是|并非.{1,20}而是|不仅.{1,20}而且|既.{1,15}又.{1,15}/g }
  ];

  var ENDING_RE = /终究|终将|或许|也许|一切|命运|时间|世界|永远|注定|只是|罢了|而已|从来|不过/;

  /* 语病：语义重复 / 句式杂糅 / 前后矛盾。只收"确定有毛病"的搭配，宁缺毋滥。 */
  var GRAM_REDUNDANT = [
    /大约[^。，！？]{0,10}左右/g,
    /约[^。，！？]{0,8}左右/g,
    /将近[^。，！？]{0,8}多/g,
    /至少[^。，！？]{0,8}以上/g,
    /超过[^。，！？]{0,8}以上/g,
    /非常[^。，！？]{0,6}极了/g,
    /可能[^。，！？]{0,6}也许/g,
    /彼此[^。，！？]{0,4}互相/g,
    /再次[^。，！？]{0,4}重新/g,
    /目的[^。，！？]{0,6}为了/g,
    /原因[^。，！？]{0,6}因为/g,
    /悬殊[^。，！？]{0,4}很大/g
  ];

  var GRAM_SYNCRETIC = [
    /原因是[^。！？]{1,24}造成的/g,
    /是由于[^。！？]{1,24}的结果/g,
    /本着[^。！？]{1,16}为原则/g,
    /围绕[^。！？]{1,16}为中心/g,
    /之所以[^。！？]{1,20}的原因/g,
    /据[^。！？]{1,12}显示/g
  ];

  var CONTRADICTIONS = [
    /(从未|从不|第一次|头一次)[^。！？]{0,12}(又一次|再次|再一次)/g,
    /(唯一|仅有)[^。！？]{0,12}另一个/g,
    /(从来没)[^。！？]{0,10}一直/g,
    /(已经死|死了)[^。！？]{0,12}(还活着|活着)/g
  ];

  /* 关联词配对表：句首出现了前件，句内却找不到后件，就是"话没说完" */
  var CONJ_PAIRS = [
    { open: /^(虽然|尽管|虽)/, close: /但|可是|却|仍然|还是|依然/ },
    { open: /^(不但|不仅)/, close: /而且|并且|还|也/ },
    { open: /^(因为|由于)/, close: /所以|因此|因而|才|就/ },
    { open: /^(如果|要是|假如|倘若)/, close: /就|那么|便|则/ },
    { open: /^(即使|哪怕|就算)/, close: /也|都|仍然|还是/ },
    { open: /^(无论|不管)/, close: /都|也|始终|总/ },
    { open: /^(只有)/, close: /才/ },
    { open: /^(只要)/, close: /就|便/ }
  ];

  /* 虚词表：算"内容词重叠"时把这些字剔掉，避免所有句子都因为「他/的/了」而显得相关 */
  var FUNC_CHARS = '的了着过是在有和与就都也很不没我你他她它这那哪个些么呢吧啊呀吗嘛';

  function contentBigrams(s) {
    var set = new Set();
    if (!s || s.length < 2) return set;
    for (var i = 0; i < s.length - 1; i++) {
      if (!isCJKCode(s.charCodeAt(i)) || !isCJKCode(s.charCodeAt(i + 1))) continue;
      var a = s.charAt(i), b = s.charAt(i + 1);
      if (FUNC_CHARS.indexOf(a) >= 0 || FUNC_CHARS.indexOf(b) >= 0) continue;
      set.add(a + b);
    }
    return set;
  }

  function overlapCount(A, B) {
    var c = 0;
    A.forEach(function (k) { if (B.has(k)) c++; });
    return c;
  }

  /* 句首连接词 / 转场词：有它们就不算"前言不搭后语" */
  var OPENER_RE = /^(但|可|却|而|于是|所以|因此|然而|不过|只是|因为|接着|后来|然后|同时|另外|忽然|突然|这时|此时|随着|当|如果|虽然|即便|直到|等到|连|换|回到|说起|至于|最后|终于|果然|偏偏|偏偏)/;

  /* ============================================================
   * 三、基础工具
   * ============================================================ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function clamp01(v) { return clamp(v, 0, 1); }
  function round(v, d) { var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }
  function safeDiv(a, b, dflt) { return b ? a / b : (dflt === undefined ? 0 : dflt); }

  function isCJKCode(c) { return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf); }

  function cjkCount(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) { if (isCJKCode(s.charCodeAt(i))) n++; }
    return n;
  }

  function findAll(text, re) {
    var flags = re.flags || '';
    if (flags.indexOf('g') < 0) flags += 'g';
    var r = new RegExp(re.source, flags);
    var out = [], m, guard = 0;
    while ((m = r.exec(text)) !== null && guard++ < 300000) {
      out.push({ s: m[0], i: m.index });
      if (m.index === r.lastIndex) r.lastIndex++;
    }
    return out;
  }

  function dictScan(text, words, minLen) {
    var dict = Object.create(null), maxLen = 2, i, min = minLen || 2;
    for (i = 0; i < words.length; i++) {
      if (!words[i]) continue;
      dict[words[i]] = true;
      if (words[i].length > maxLen) maxLen = words[i].length;
    }
    var hits = [], n = text.length, p, L, w;
    for (p = 0; p < n; p++) {
      var code = text.charCodeAt(p);
      if (!isCJKCode(code)) continue;
      for (L = Math.min(maxLen, n - p); L >= min; L--) {
        w = text.substr(p, L);
        if (dict[w]) { hits.push({ s: w, i: p }); p += L - 1; break; }
      }
    }
    return hits;
  }

  function countIn(text, words, minLen) {
    var hits = dictScan(text, words, minLen);
    var map = Object.create(null), i;
    for (i = 0; i < hits.length; i++) { map[hits[i].s] = (map[hits[i].s] || 0) + 1; }
    return { total: hits.length, hits: hits, map: map };
  }

  function per1000(count, base) { return safeDiv(count * 1000, Math.max(base, 1)); }
  function pct(count, base) { return safeDiv(count, Math.max(base, 1)); }

  function entropyOf(counts) {
    var total = 0, i, p, h = 0;
    for (i = 0; i < counts.length; i++) total += counts[i];
    if (!total) return 0;
    for (i = 0; i < counts.length; i++) {
      if (!counts[i]) continue;
      p = counts[i] / total;
      h -= p * Math.log(p) / Math.LN2;
    }
    return h;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    var inter = 0;
    a.forEach(function (k) { if (b.has(k)) inter++; });
    return inter / (a.size + b.size - inter);
  }

  function bigramsOf(s) {
    var set = new Set();
    for (var i = 0; i < s.length - 1; i++) set.add(s.substr(i, 2));
    return set;
  }

  /* ============================================================
   * 四、文本预处理
   * ============================================================ */

  function splitParagraphs(text) {
    var out = [], re = /\n+/g, m, last = 0;
    while ((m = re.exec(text)) !== null) {
      var seg = text.slice(last, m.index);
      if (seg.replace(/\s/g, '')) out.push({ text: seg, start: last, end: m.index });
      last = m.index + m[0].length;
    }
    var tail = text.slice(last);
    if (tail.replace(/\s/g, '')) out.push({ text: tail, start: last, end: text.length });
    return out;
  }

  var SENT_ENDS = '。！？!?…';
  var CLOSERS = '”’」』）)】》"\'';

  function splitSentences(para) {
    var res = [], i = 0, start = 0, n = para.length, ch, j, seg;
    for (i = 0; i < n; i++) {
      ch = para.charAt(i);
      if (SENT_ENDS.indexOf(ch) >= 0) {
        j = i + 1;
        while (j < n && SENT_ENDS.indexOf(para.charAt(j)) >= 0) j++;
        while (j < n && CLOSERS.indexOf(para.charAt(j)) >= 0) j++;
        seg = para.slice(start, j);
        if (seg.replace(/\s/g, '')) res.push(seg);
        start = j;
        i = j - 1;
      }
    }
    if (start < n) {
      seg = para.slice(start);
      if (seg.replace(/\s/g, '')) res.push(seg);
    }
    return res;
  }

  function coreLen(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (isCJKCode(c)) n++;
      else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n += 0.5;
    }
    return n;
  }

  var PUNCT_ALL = '，。！？；：、“”‘’（）《》〈〉—…·「」『』【】〔〕～~,.!?;:\'"()[]{}';
  var PUNCT_CLASSES = [
    '。！？!?', '，、,', '；：;:', '“”‘’「」『』"\'', '（）【】〔〕()[]{}', '—', '…', '～~·', '《》〈〉'
  ];

  /* ============================================================
   * 五、统计包
   * ============================================================ */

  function buildStats(raw, opts) {
    var text = String(raw || '').replace(/\r\n?/g, '\n');

    if (text.length > opts.maxChars) text = text.slice(0, opts.maxChars);

    var S = { text: text, truncated: String(raw || '').length > text.length, warnings: [] };
    S.chars = text.replace(/\s/g, '').length;
    S.cjk = cjkCount(text);

    var paras = splitParagraphs(text);
    S.paragraphs = [];
    S.sentences = [];
    var pi, si, ptxt, segs, sentList, rawSent, t, len, dlg;
    for (pi = 0; pi < paras.length; pi++) {
      ptxt = paras[pi].text;
      segs = splitSentences(ptxt);
      sentList = [];
      for (si = 0; si < segs.length; si++) {
        rawSent = segs[si];
        t = rawSent.trim();
        if (!t) continue;
        len = coreLen(t);
        dlg = /[“「"]/.test(t);
        var obj = { t: t, raw: rawSent, len: len, dlg: dlg, pi: pi, idx: S.sentences.length };
        S.sentences.push(obj);
        sentList.push(obj);
      }
      if (sentList.length) {
        S.paragraphs.push({
          text: ptxt, sents: sentList, len: coreLen(ptxt),
          start: paras[pi].start, end: paras[pi].start + ptxt.length
        });
      }
    }

    var SENT = S.sentences;
    S.sentCount = SENT.length;
    S.paraCount = S.paragraphs.length;

    if (S.sentCount < 2) {
      S.warnings.push('有效句子太少，多项统计特征被跳过');
    }

    // 句长
    var lens = SENT.map(function (s) { return s.len; }).filter(function (v) { return v > 0; });
    S.lens = lens;
    S.mean = lens.reduce(function (a, b) { return a + b; }, 0) / Math.max(lens.length, 1);
    var varr = 0, i;
    for (i = 0; i < lens.length; i++) varr += (lens[i] - S.mean) * (lens[i] - S.mean);
    S.sd = Math.sqrt(varr / Math.max(lens.length, 1));
    S.cv = safeDiv(S.sd, S.mean, 0);

    var bins = [0, 0, 0, 0, 0, 0];
    for (i = 0; i < lens.length; i++) {
      var L = lens[i];
      if (L <= 8) bins[0]++;
      else if (L <= 14) bins[1]++;
      else if (L <= 22) bins[2]++;
      else if (L <= 32) bins[3]++;
      else if (L <= 50) bins[4]++;
      else bins[5]++;
    }
    S.binEntropy = safeDiv(entropyOf(bins), Math.log(6) / Math.LN2, 0);

    S.shortRatio = pct(lens.filter(function (v) { return v <= 8; }).length, lens.length);
    S.midRatio = pct(lens.filter(function (v) { return v >= 15 && v <= 35; }).length, lens.length);

    // 节拍器：连续等长句最长段
    var run = 0, best = 0, lo = S.mean * 0.85, hi = S.mean * 1.15;
    for (i = 0; i < lens.length; i++) {
      if (lens[i] >= 12 && lens[i] <= 46 && lens[i] >= lo && lens[i] <= hi) { run++; if (run > best) best = run; }
      else run = 0;
    }
    S.metronome = best;

    // 段落
    var oneSent = S.paragraphs.filter(function (p) { return p.sents.length === 1; }).length;
    S.oneSentParaRatio = pct(oneSent, S.paraCount);
    var plens = S.paragraphs.map(function (p) { return p.len; });
    var pmean = plens.reduce(function (a, b) { return a + b; }, 0) / Math.max(plens.length, 1);
    var pvar = 0;
    for (i = 0; i < plens.length; i++) pvar += (plens[i] - pmean) * (plens[i] - pmean);
    S.paraMean = pmean;
    S.paraCv = safeDiv(Math.sqrt(pvar / Math.max(plens.length, 1)), pmean, 0);
    // 硬换行的 txt 会让段落特征失真，此时跳过
    S.paraUsable = S.paraCount >= 6 && !(S.oneSentParaRatio > 0.85 && S.paraCount > 12);

    // 标点
    var pcounts = Object.create(null), ptotal = 0, k, ch2;
    for (i = 0; i < text.length; i++) {
      ch2 = text.charAt(i);
      if (PUNCT_ALL.indexOf(ch2) >= 0) { pcounts[ch2] = (pcounts[ch2] || 0) + 1; ptotal++; }
    }
    S.punctTotal = ptotal;
    var classCounts = [];
    for (k = 0; k < PUNCT_CLASSES.length; k++) {
      var cls = PUNCT_CLASSES[k], c = 0;
      for (i = 0; i < cls.length; i++) c += (pcounts[cls.charAt(i)] || 0);
      classCounts.push(c);
    }
    S.punctEntropy = safeDiv(entropyOf(classCounts), Math.log(PUNCT_CLASSES.length) / Math.LN2, 0);
    S.punctClasses = classCounts.filter(function (c2) { return c2 > 0; }).length;

    var endCounts = [0, 0, 0, 0];
    for (i = 0; i < SENT.length; i++) {
      var tailCh = SENT[i].raw.replace(/[”’」』）)】》"'\s]+$/, '').slice(-1);
      if (tailCh === '。') endCounts[0]++;
      else if (tailCh === '！' || tailCh === '!') endCounts[1]++;
      else if (tailCh === '？' || tailCh === '?') endCounts[2]++;
      else if (tailCh === '…') endCounts[3]++;
    }
    S.endEntropy = safeDiv(entropyOf(endCounts), Math.log(4) / Math.LN2, 0);

    S.excl = (pcounts['！'] || 0) + (pcounts['？'] || 0) + (pcounts['!'] || 0) + (pcounts['?'] || 0);
    S.dash = (pcounts['—'] || 0);
    S.ellipsis = (pcounts['…'] || 0);
    S.paren = (pcounts['（'] || 0) + (pcounts['('] || 0);
    // 分号：人类网文几乎不用，模型爱用它把长句焊起来。去AI味时最容易被漏掉
    S.semicolon = (pcounts['；'] || 0) + (pcounts[';'] || 0);

    // 不规范标点（人类手写痕迹）
    var irregular = findAll(text, /[,\.!\?;:]|([，。！？、])\1{2,}|[\u4e00-\u9fa5] {2,}[\u4e00-\u9fa5]/g).length;

    // 对话
    var quoteRe = /“[^”]{0,500}”|「[^」]{0,500}」|"[^"]{0,500}"/g;
    var qm, dlgChars = 0, dlgN = 0;
    while ((qm = quoteRe.exec(text)) !== null) { dlgChars += qm[0].length; dlgN++; }
    S.dialogueChars = dlgChars;
    S.dialogueRatio = pct(dlgChars, Math.max(text.length, 1));
    var dlgSents = SENT.filter(function (s) { return s.dlg; });
    S.dlgSentCount = dlgSents.length;
    S.dlgAvgLen = safeDiv(dlgSents.reduce(function (a, b) { return a + b.len; }, 0), dlgSents.length, 0);

    // 词汇
    S.redup = countIn(text, LEX.redup);
    S.hedge = countIn(text, LEX.hedge);
    S.idiom = countIn(text, LEX.idiom);
    S.abstractC = countIn(text, LEX.abstract);
    S.concreteC = countIn(text, LEX.concrete);
    S.degreeC = countIn(text, LEX.degree);
    S.emotionC = countIn(text, LEX.emotion);
    S.bodyC = countIn(text, LEX.body, 1);
    S.connectorC = countIn(text, LEX.connector);
    S.psychC = countIn(text, LEX.psych);
    S.tagC = countIn(text, LEX.tag);

    var modalN = 0, slangN = 0, m2, i2;
    for (i2 = 0; i2 < text.length; i2++) {
      var cc = text.charAt(i2);
      if (LEX.modal.indexOf(cc) >= 0) modalN++;
    }
    for (i2 = 0; i2 < LEX.slang.length; i2++) {
      var wd = LEX.slang[i2], from = 0, at;
      while ((at = text.indexOf(wd, from)) !== -1) { slangN++; from = at + wd.length; }
    }
    S.modalN = modalN;
    S.slangN = slangN;

    // 叠词 + 地（精确指纹）
    var redupDi = 0, rd = /([\u4e00-\u9fa5])\1地/g, rm2;
    while ((rm2 = rd.exec(text)) !== null) redupDi++;
    S.redupDi = redupDi;

    // 具体性感：数字 + 量词
    S.numberN = findAll(text, /[0-9０-９]+|[一二三四五六七八九十百千万半两]+(个|只|条|张|块|根|杯|瓶|斤|米|公里|分钟|小时|岁|天|次|遍|步|声|下|口|件|间|层|栋|辆|把|本|页|句|字|年|月|日)/g).length;

    // 感官分布
    var senses = {}, senseTotal = 0, sk;
    for (sk in LEX.sensory) {
      if (!Object.prototype.hasOwnProperty.call(LEX.sensory, sk)) continue;
      var arr = LEX.sensory[sk], c2 = 0;
      for (i2 = 0; i2 < arr.length; i2++) {
        var w2 = arr[i2], f2 = 0, a2;
        while ((a2 = text.indexOf(w2, f2)) !== -1) { c2++; f2 = a2 + w2.length; }
      }
      senses[sk] = c2; senseTotal += c2;
    }
    S.senseTotal = senseTotal;
    S.visualRatio = safeDiv(senses.visual || 0, senseTotal, 0);

    // 抽象空转句比例
    var empty = 0, counted = 0;
    for (i = 0; i < SENT.length; i++) {
      var st = SENT[i].t;
      if (st.length < 8) continue;
      counted++;
      var ab = 0, abKeys = [], key;
      for (key in S.abstractC.map) {
        if (st.indexOf(key) >= 0) ab++;
      }
      var hasConcrete = false, ck;
      for (ck in S.concreteC.map) { if (st.indexOf(ck) >= 0) { hasConcrete = true; break; } }
      var hasNumber = /[0-9０-９]/.test(st);
      if (ab >= 2 && !hasConcrete && !hasNumber) empty++;
    }
    S.emptyRatio = pct(empty, Math.max(counted, 1));

    /* ---- 叙事骨架统计（"笔力"向） ----
       靠句子里"有没有实的东西"来判断，不靠句首词表（词表试过，全是 0）。 */
    var noEnt = 0, nEnt = 0, dSent = 0, iSent = 0;
    for (i = 0; i < SENT.length; i++) {
      var sh = SENT[i].t;
      if (sh.length >= 8) {
        nEnt++;
        var hasC = false, ck3;
        for (ck3 in S.concreteC.map) { if (sh.indexOf(ck3) >= 0) { hasC = true; break; } }
        var hasN = /[0-9０-９一二三四五六七八九十百千万两]/.test(sh);
        var hasQ = /[“「『"]/.test(sh);
        // 纯气氛/心理句：没有具体物、没有数字、没有对白
        if (!hasC && !hasN && !hasQ) noEnt++;
      }
      var q = /[“「『"]/.test(sh);
      var v = /(说|道|问|答|喊|叫|嚷|骂)/.test(sh);
      if (q) dSent++;
      else if (v) iSent++;
    }
    S.setupRatio = pct(noEnt, Math.max(nEnt, 1));
    S.directRatio = safeDiv(dSent, dSent + iSent, 0);

    /* ---- 体裁闸门 ----
       本引擎只对「小说/叙事文本」负责。合同、协议、说明文天生重复、抽象、模板化，
       拿去打分一定被判成 AI——那不是检测错误，是用错了工具。
       这里先认体裁，认出来就直接说"不适用"，不给分数。 */
    var CONTRACT_HIT = /甲方|乙方|丙方|本合同|本协议|协议约定|违约责任|仲裁|签署|盖章|生效|履行|条款|鉴于|兹定|授权代表|附件[一二三四\d]|第[一二三四五六七八九十\d]{1,3}条/;
    var contractN = findAll(text, new RegExp(CONTRACT_HIT.source, 'g')).length;
    var dlgChars = 0;
    for (var di = 0; di < SENT.length; di++) if (SENT[di].dlg) dlgChars += SENT[di].len;
    var dlgShare = safeDiv(dlgChars, Math.max(S.cjk, 1), 0);
    var textType = { key: 'novel', label: '小说 / 叙事文本', applicable: true, note: '' };
    if (contractN >= 6 && dlgShare < 0.06) {
      textType = {
        key: 'contract', label: '合同 / 协议类文本', applicable: false,
        note: '命中 ' + contractN + ' 处合同用语，且几乎没有对白。这类文本天生重复、抽象、模板化，AI 味检测不适用。'
      };
    } else if (contractN >= 10 && dlgShare < 0.12) {
      textType = {
        key: 'doc', label: '说明 / 公文类文本', applicable: false,
        note: '命中 ' + contractN + ' 处公文用语。本引擎按小说语料训练，对说明性文本的判定不可靠。'
      };
    }
    S.textType = textType;

    // 升华收尾
    var ending = 0, pUsable = 0;
    for (i = 0; i < S.paragraphs.length; i++) {
      var ps = S.paragraphs[i].sents;
      if (!ps.length) continue;
      pUsable++;
      var lastS = ps[ps.length - 1];
      if (lastS.len > 0 && lastS.len <= 34 && !lastS.dlg && ENDING_RE.test(lastS.t)) ending++;
    }
    S.endingRatio = pct(ending, Math.max(pUsable, 1));

    // 相邻句相似
    var sims = [], prevSet = null;
    for (i = 0; i < SENT.length; i++) {
      if (SENT[i].len < 6) { prevSet = null; continue; }
      var curSet = bigramsOf(SENT[i].t);
      if (prevSet) sims.push(jaccard(prevSet, curSet));
      prevSet = curSet;
    }
    S.adjSim = sims.length ? sims.reduce(function (a, b) { return a + b; }, 0) / sims.length : null;

    // 句首重复
    var opens = Object.create(null), openTotal = 0;
    for (i = 0; i < SENT.length; i++) {
      var tt = SENT[i].t.replace(/^[“”「」\s]+/, '');
      if (tt.length < 4) continue;
      var op = tt.substr(0, 2);
      if (/^(他|她|我|你)/.test(op)) continue;
      opens[op] = (opens[op] || 0) + 1;
      openTotal++;
    }
    var maxOpen = 0;
    for (k in opens) { if (opens[k] > maxOpen) maxOpen = opens[k]; }
    S.openRepeat = openTotal >= 10 ? pct(maxOpen, openTotal) : null;

    // 段首重复
    var popens = Object.create(null), pTotal = 0;
    for (i = 0; i < S.paragraphs.length; i++) {
      var pt2 = S.paragraphs[i].text.replace(/^[“”「」\s]+/, '');
      if (!pt2) continue;
      var po = pt2.substr(0, 2);
      popens[po] = (popens[po] || 0) + 1;
      pTotal++;
    }
    var maxPo = 0;
    for (k in popens) { if (popens[k] > maxPo) maxPo = popens[k]; }
    S.paraOpenRepeat = pTotal >= 8 ? pct(maxPo, pTotal) : null;

    // 最长复用片段
    var ng = Object.create(null), maxNg = 0, scan = text.slice(0, 40000);
    for (i = 0; i + 6 <= scan.length; i++) {
      var g6 = scan.substr(i, 6);
      if (!/^[\u4e00-\u9fa5]{6}$/.test(g6)) continue;
      ng[g6] = (ng[g6] || 0) + 1;
      if (ng[g6] > maxNg) maxNg = ng[g6];
    }
    S.maxNgram = maxNg;

    // 可预测性：1 - H(X|prev)/H(X)
    S.predictability = predictability(text);

    S.irregularN = irregular;

    /* ---- 语病 / 杂糅 ---- */
    S.gramDe = findAll(text, /(跑|走|说|写|做|来|去|长|学|打|干|唱|画|睡|飞|游|变|活)的(?=(快|好|早|晚|多|少|高|远|慢|准|对|清楚|明白|漂亮))/g).length;

    S.gramRedundant = 0;
    S.gramRedundantHits = [];
    for (i = 0; i < GRAM_REDUNDANT.length; i++) {
      var rh = findAll(text, GRAM_REDUNDANT[i]);
      S.gramRedundant += rh.length;
      if (rh.length) S.gramRedundantHits = S.gramRedundantHits.concat(rh.slice(0, 2));
    }

    S.gramSyncretic = 0;
    S.gramSyncreticHits = [];
    for (i = 0; i < GRAM_SYNCRETIC.length; i++) {
      var sh = findAll(text, GRAM_SYNCRETIC[i]);
      S.gramSyncretic += sh.length;
      if (sh.length) S.gramSyncreticHits = S.gramSyncreticHits.concat(sh.slice(0, 2));
    }

    S.gramSubject = findAll(text, /(通过|经过|关于|对于)[^。！？]{2,24}，(让|使|令)/g).length;
    S.gramDup = findAll(text, /([\u4e00-\u9fa5])\1{2,}|的的|了了|是是/g).length;

    // 叠用句式「一盒一盒」「一遍一遍」「一层一层」——长在句法上，改词改不掉
    S.redupPattern = findAll(text, /一([\u4e00-\u9fa5])一\1/g).length;

    // 一逗到底：一口气七八个逗号还不收句
    var commaRun = 0;
    for (i = 0; i < SENT.length; i++) {
      var cms = SENT[i].t.match(/，/g);
      if (cms && cms.length >= 7) commaRun++;
    }
    S.commaRunRatio = pct(commaRun, Math.max(SENT.length, 1));

    // 关联词残缺：句首有前件、句内（含下一句）找不到后件
    var conjBroken = 0, cpi, openM;
    for (i = 0; i < SENT.length; i++) {
      var stc = SENT[i].t.replace(/^[“「"'\s]+/, '');
      // 有些作者会把「因为…所以…」拆成两句，看下一句能少判一半误报
      var span = stc + '，' + (SENT[i + 1] ? SENT[i + 1].t : '');
      for (cpi = 0; cpi < CONJ_PAIRS.length; cpi++) {
        openM = stc.match(CONJ_PAIRS[cpi].open);
        if (!openM) continue;
        if (!CONJ_PAIRS[cpi].close.test(span.slice(openM[0].length))) conjBroken++;
        break;
      }
    }
    S.conjBroken = conjBroken;

    // 长句无停顿：45 字以上却一个逗号都没有
    var runOn = 0;
    for (i = 0; i < SENT.length; i++) {
      if (SENT[i].len >= 45 && SENT[i].t.indexOf('，') < 0) runOn++;
    }
    S.runOnRatio = pct(runOn, Math.max(SENT.length, 1));

    /* ---- 逻辑连贯 ---- */
    var pairs = 0, jump = 0, repeatInfo = 0;
    for (i = 1; i < SENT.length; i++) {
      var cur = SENT[i], prev = SENT[i - 1];
      if (cur.len < 8 || prev.len < 8) continue;
      var A = contentBigrams(prev.t), B = contentBigrams(cur.t);
      if (A.size < 3 || B.size < 3) continue;
      pairs++;
      var inter = overlapCount(A, B);
      var uni = A.size + B.size - inter;
      var jac = uni > 0 ? inter / uni : 0;
      if (jac === 0 && !OPENER_RE.test(cur.t)) jump++;
      if (jac > 0.5) repeatInfo++;
    }
    S.topicJump = pct(jump, Math.max(pairs, 1));
    S.repeatInfo = pct(repeatInfo, Math.max(pairs, 1));

    S.contradiction = 0;
    for (i = 0; i < CONTRADICTIONS.length; i++) S.contradiction += findAll(text, CONTRADICTIONS[i]).length;

    return S;
  }

  function predictability(text) {
    try {
      var clean = text.replace(/[^\u4e00-\u9fa5]/g, '');
      if (clean.length < 400) return null;
      clean = clean.slice(0, 20000);
      var uni = Object.create(null), bi = Object.create(null), i, total = 0;
      for (i = 0; i < clean.length - 1; i++) {
        var a = clean.charAt(i), b = clean.charAt(i + 1);
        uni[a] = (uni[a] || 0) + 1;
        var key = a + b;
        bi[key] = (bi[key] || 0) + 1;
        total++;
      }
      var h1 = 0, k;
      for (k in uni) { var p = uni[k] / total; h1 -= p * Math.log(p) / Math.LN2; }
      var h2 = 0;
      for (k in bi) {
        var pb = bi[k] / total;
        var pa = (uni[k.charAt(0)] || 1) / total;
        h2 -= pb * Math.log(pb / pa) / Math.LN2;
      }
      if (!h1) return null;
      return clamp01(1 - h2 / h1);
    } catch (e) { return null; }
  }

  /* ============================================================
   * 六、特征定义（55 项）
   *   dir: 'up' = 数值越大越像 AI；'down' = 越小越像 AI
   *   h: 人类参考值   a: AI 参考值
   * ============================================================ */

  function F(o) { return o; }

  var FEATURES = [
    /* ---- 句式节奏 ---- */
    F({ id: 'rhythm_cv', dim: 'rhythm', name: '句长变异系数', unit: 'num', dir: 'down', h: 0.66, a: 0.42, w: 3,
      desc: '句长标准差除以平均值。人类笔下的句子忽长忽短，模型倾向于句句等长。',
      calc: function (S) { return S.lens.length >= 8 ? S.cv : null; } }),

    F({ id: 'rhythm_short', dim: 'rhythm', name: '短句占比', unit: 'pct', dir: 'down', h: 0.18, a: 0.06, w: 2,
      desc: '8 字以内短句的比例。人类常用短句断节奏，模型很少写这么短。',
      calc: function (S) { return S.lens.length >= 8 ? S.shortRatio : null; } }),

    F({ id: 'rhythm_mid', dim: 'rhythm', name: '中等句占比', unit: 'pct', dir: 'up', h: 0.38, a: 0.60, w: 1.5,
      desc: '15–35 字句子的占比。模型最爱这个长度区间，容易形成“复制粘贴感”。',
      calc: function (S) { return S.lens.length >= 8 ? S.midRatio : null; } }),

    F({ id: 'rhythm_metronome', dim: 'rhythm', name: '节拍器连击', unit: 'count', dir: 'up', h: 3, a: 6.5, w: 2.5,
      desc: '连续等长（±15%）句子的最长串。越长越像机器在按同一节拍输出。',
      calc: function (S) { return S.lens.length >= 8 ? S.metronome : null; } }),

    F({ id: 'rhythm_entropy', dim: 'rhythm', name: '句长分布熵', unit: 'num', dir: 'down', h: 0.82, a: 0.60, w: 2,
      desc: '句子按长度分 6 档后的归一化熵。分布越集中，越像模型。',
      calc: function (S) { return S.lens.length >= 10 ? S.binEntropy : null; } }),

    F({ id: 'rhythm_para1', dim: 'rhythm', name: '单句成段率', unit: 'pct', dir: 'down', h: 0.24, a: 0.06, w: 2,
      desc: '一句话单独成段的比例。网文作者靠它控制阅读节奏，模型几乎不这么写。',
      calc: function (S) { return S.paraUsable ? S.oneSentParaRatio : null; } }),

    F({ id: 'rhythm_paraCv', dim: 'rhythm', name: '段长变异系数', unit: 'num', dir: 'down', h: 0.90, a: 0.52, w: 1.5,
      desc: '段落长度的离散程度。人类段落长短悬殊，模型段落整齐得可疑。',
      calc: function (S) { return S.paraUsable ? S.paraCv : null; } }),

    /* ---- 用词习惯 ---- */
    F({ id: 'lex_redup', dim: 'lexicon', name: '叠词副词密度', unit: 'per1000', dir: 'up', h: 1.8, a: 6.0, w: 3,
      desc: '轻轻/缓缓/淡淡/静静……每千字出现次数。这是中文模型腔最典型的指纹。',
      calc: function (S) { return S.cjk >= 200 ? per1000(S.redup.total, S.cjk) : null; },
      hits: function (S) { return S.redup.hits; } }),

    F({ id: 'lex_redupDi', dim: 'lexicon', name: '叠词+地结构', unit: 'per1000', dir: 'up', h: 0.7, a: 3.5, w: 1.5,
      desc: '“轻轻地/缓缓地”这类结构每千字次数。模型特别爱用它做动作描写。',
      calc: function (S) { return S.cjk >= 200 ? per1000(S.redupDi, S.cjk) : null; } }),

    F({ id: 'lex_idiom', dim: 'lexicon', name: '四字成语密度', unit: 'per1000', dir: 'up', h: 4, a: 12, w: 2,
      desc: '常见四字成语每千字次数。模型喜欢用成语撑“文采”。',
      calc: function (S) { return S.cjk >= 300 ? per1000(S.idiom.total, S.cjk) : null; },
      hits: function (S) { return S.idiom.hits; } }),

    F({ id: 'lex_abstract', dim: 'lexicon', name: '抽象大词密度', unit: 'per1000', dir: 'up', h: 13, a: 26, w: 2.5,
      desc: '命运/时间/世界/一切/灵魂/沉默……每千字次数。人类写具体，模型写概念。',
      calc: function (S) { return S.cjk >= 300 ? per1000(S.abstractC.total, S.cjk) : null; },
      hits: function (S) { return S.abstractC.hits; } }),

    F({ id: 'lex_concrete', dim: 'lexicon', name: '具体物密度', unit: 'per1000', dir: 'down', h: 11, a: 3, w: 1.5,
      desc: '桌子/杯子/钥匙/烟头……看得见摸得着的东西。人类写得多，模型写得少。',
      calc: function (S) { return S.cjk >= 300 ? per1000(S.concreteC.total, S.cjk) : null; },
      hits: function (S) { return S.concreteC.hits; } }),

    F({ id: 'lex_number', dim: 'lexicon', name: '数字量词密度', unit: 'per1000', dir: 'down', h: 9, a: 3, w: 1.2,
      desc: '数目与量词每千字次数。有具体尺寸、时间、次数，往往是人写的。',
      calc: function (S) { return S.cjk >= 300 ? per1000(S.numberN, S.cjk) : null; } }),

    F({ id: 'lex_degree', dim: 'lexicon', name: '程度副词堆砌', unit: 'per1000', dir: 'up', h: 4, a: 11, w: 1.5,
      desc: '极其/无比/格外/愈发……模型爱用程度副词代替具体描写。',
      calc: function (S) { return S.cjk >= 300 ? per1000(S.degreeC.total, S.cjk) : null; } }),

    F({ id: 'lex_emotion', dim: 'lexicon', name: '情绪词直标', unit: 'per1000', dir: 'up', h: 3, a: 9, w: 2,
      desc: '直接写“恐惧/愤怒/苦涩/无奈”。老练的作者写动作，模型写情绪名字。',
      calc: function (S) { return S.cjk >= 300 ? per1000(S.emotionC.total, S.cjk) : null; },
      hits: function (S) { return S.emotionC.hits; } }),

    /* ---- 套路句式 ---- */
    F({ id: 'syn_notbut', dim: 'syntax', name: '“不是…而是”句式', unit: 'per1000', dir: 'up', h: 0.2, a: 1.6, w: 2,
      desc: '对偶式转折句式每千字次数，模型极爱用。',
      calc: function (S) { return per1000(findAll(S.text, /不是[\u4e00-\u9fa5，、]{1,16}而是/g).length, S.cjk); } }),

    F({ id: 'syn_parallel', dim: 'syntax', name: '排比堆叠', unit: 'per1000', dir: 'up', h: 0.3, a: 1.8, w: 2,
      desc: '“不仅…而且”“既…又”等排比结构密度，模型靠它凑气势。',
      calc: function (S) { return per1000(findAll(S.text, /不仅.{1,18}而且|既.{1,14}又.{1,14}|一边.{1,12}一边/g).length, S.cjk); } }),

    F({ id: 'syn_redup', dim: 'syntax', name: '叠用句式', unit: 'per1000', dir: 'up', h: 0.3, a: 3.0, w: 2.5,
      desc: '「一盒一盒」「一遍一遍」「一层一层」这类句法级重复。改词改不掉——它长在句式里，去AI味时最常被漏。',
      calc: function (S) { return S.cjk >= 200 ? per1000(S.redupPattern, S.cjk) : null; } }),

    F({ id: 'syn_metaphor', dim: 'syntax', name: '比喻套式', unit: 'per1000', dir: 'up', h: 1.8, a: 6.5, w: 3,
      desc: '仿佛/宛如/犹如/好似/像…一样。模型写比喻高频且同质。',
      calc: function (S) { return per1000(findAll(S.text, /仿佛|宛如|犹如|好似|如同|宛若|恰似|像[\u4e00-\u9fa5，]{0,12}(一样|一般|似的)/g).length, S.cjk); },
      hits: function (S) { return findAll(S.text, /仿佛|宛如|犹如|好似|如同|宛若|恰似/g); } }),

    F({ id: 'syn_essay', dim: 'syntax', name: '说理金句', unit: 'per1000', dir: 'up', h: 0.4, a: 3.0, w: 2.5,
      desc: '「所谓…不过是…」「不只是…更是…」「意味着」这类议论句。人类网文靠情节演给你看，模型爱跳出来讲道理。',
      calc: function (S) { return S.cjk >= 200 ? per1000(findAll(S.text, /所谓|不过是|并不只是|不只是|不仅仅是|意味着|说到底|换言之/g).length, S.cjk) : null; } }),

    F({ id: 'syn_gaze', dim: 'syntax', name: '眼神表情模板', unit: 'per1000', dir: 'up', h: 1.0, a: 5.0, w: 3,
      desc: '眼底闪过/嘴角勾起一抹/深吸一口气/瞳孔微缩——AI 表情包三件套。',
      calc: function (S) { return per1000(findAll(S.text, /眼底.{0,3}(闪过|掠过|划过|流露|涌|深邃)|眼中.{0,3}(闪过|掠过|泛起|带着)|眼里.{0,3}(闪过|藏着|带着)|嘴角.{0,3}(勾起|扬起|扯出|勾勒|露出一)|勾起一抹|一抹(弧度|苦涩|笑意|温柔|嘲讽|无奈|了然)|深吸一口气|深吸了口气|瞳孔.{0,2}缩|睫毛.{0,2}颤|(眉心|眉头).{0,2}(微皱|一皱|紧锁|紧皱)/g).length, S.cjk); },
      hits: function (S) { return findAll(S.text, /眼底.{0,3}(闪过|掠过|划过|流露)|嘴角.{0,3}(勾起|扬起|勾勒)|勾起一抹|深吸一口气|瞳孔.{0,2}缩/g); } }),

    F({ id: 'syn_tag', dim: 'syntax', name: '对话标签密度', unit: 'per1000', dir: 'up', h: 5, a: 12, w: 1.5,
      desc: '“低声说道/淡淡道/摇了摇头”的密度。模型对话必带标签且种类少。',
      calc: function (S) { return S.dlgSentCount >= 3 ? per1000(S.tagC.total, S.cjk) : null; },
      hits: function (S) { return S.tagC.hits; } }),

    F({ id: 'syn_connector', dim: 'syntax', name: '万能连接词', unit: 'per1000', dir: 'up', h: 3, a: 8, w: 2,
      desc: '然而/于是/紧接着/就在这时/片刻后。模型靠它们缝合段落。',
      calc: function (S) { return per1000(S.connectorC.total, S.cjk); },
      hits: function (S) { return S.connectorC.hits; } }),

    F({ id: 'syn_psych', dim: 'syntax', name: '心理直述句式', unit: 'per1000', dir: 'up', h: 1.2, a: 4.5, w: 2.5,
      desc: '“他知道”“心中一紧”“五味杂陈”。模型用旁白替读者下结论。',
      calc: function (S) { return per1000(S.psychC.total, S.cjk); },
      hits: function (S) { return S.psychC.hits; } }),

    F({ id: 'syn_ending', dim: 'syntax', name: '升华式收尾', unit: 'pct', dir: 'up', h: 0.08, a: 0.32, w: 2,
      desc: '段末总爱来一句“终究/或许/一切”的总结。人类敢让段落停在半空。',
      calc: function (S) { return S.paraUsable ? S.endingRatio : null; } }),

    F({ id: 'syn_nounify', dim: 'syntax', name: '名词化短语', unit: 'per1000', dir: 'up', h: 3, a: 8, w: 1.5,
      desc: '“…的沉默”“…的尽头”这类把形容词名词化的写法，模型的文青腔标志。',
      calc: function (S) { return per1000(findAll(S.text, /的(命运|宿命|沉默|寂静|温度|尽头|边缘|深处|孤独|自由|真相|记忆|意义|力量|孤独|世界|时间)/g).length, S.cjk); } }),

    /* ---- 语病杂糅 ---- */
    F({ id: 'gram_redundant', dim: 'grammar', name: '语义重复搭配', unit: 'per1000', dir: 'up', h: 0.3, a: 2.0, w: 2,
      desc: '「大约…左右」「目的是为了」「再次重新」这类自己和自己重复的搭配。',
      calc: function (S) { return per1000(S.gramRedundant, S.cjk); },
      hits: function (S) { return S.gramRedundantHits; } }),

    F({ id: 'gram_syncretic', dim: 'grammar', name: '句式杂糅', unit: 'per1000', dir: 'up', h: 0.2, a: 1.5, w: 2,
      desc: '「原因是…造成的」「本着…为原则」，两个句式焊在一起，谁都不完整。',
      calc: function (S) { return per1000(S.gramSyncretic, S.cjk); },
      hits: function (S) { return S.gramSyncreticHits; } }),

    F({ id: 'gram_de', dim: 'grammar', name: '的／得误用', unit: 'per1000', dir: 'up', h: 0.2, a: 1.2, w: 1.5,
      desc: '「说的好」「跑的很快」，补语位置该用「得」却写成「的」。',
      calc: function (S) { return per1000(S.gramDe, S.cjk); } }),

    F({ id: 'gram_subject', dim: 'grammar', name: '主语残缺', unit: 'per1000', dir: 'up', h: 0.2, a: 1.5, w: 1.5,
      desc: '「通过…，让…」这类把主语吞掉的句式，读到最后不知道谁在做。',
      calc: function (S) { return per1000(S.gramSubject, S.cjk); } }),

    F({ id: 'gram_dup', dim: 'grammar', name: '重复冗字', unit: 'per1000', dir: 'up', h: 0.2, a: 1.5, w: 1,
      desc: '「的的」「了了」以及连续三个相同字。',
      calc: function (S) { return per1000(S.gramDup, S.cjk); } }),

    F({ id: 'gram_commaRun', dim: 'grammar', name: '一逗到底', unit: 'pct', dir: 'up', h: 0.06, a: 0.25, w: 1.5,
      desc: '一句话里塞七个以上逗号还不收尾，读起来没有换气的地方。',
      calc: function (S) { return S.sentCount >= 8 ? S.commaRunRatio : null; } }),

    F({ id: 'gram_conj', dim: 'grammar', name: '关联词残缺', unit: 'per1000', dir: 'up', h: 0.1, a: 1.0, w: 2,
      desc: '句首写了「虽然」「因为」「如果」，句中却没有「但是」「所以」「就」——话没说完就断了。',
      calc: function (S) { return S.cjk >= 200 ? per1000(S.conjBroken, S.cjk) : null; } }),

    F({ id: 'gram_runon', dim: 'grammar', name: '长句无停顿', unit: 'pct', dir: 'up', h: 0.02, a: 0.10, w: 2,
      desc: '45 字以上却连一个逗号都没有，读起来喘不上气。',
      calc: function (S) { return S.sentCount >= 6 ? S.runOnRatio : null; } }),

    /* ---- 逻辑连贯 ---- */
    F({ id: 'coh_jump', dim: 'coherence', name: '话题断裂', unit: 'pct', dir: 'up', h: 0.18, a: 0.45, w: 2.5,
      desc: '相邻两句内容词完全不重叠、又没有任何转场词——就是「前言不搭后语」。',
      calc: function (S) { return S.sentCount >= 8 ? S.topicJump : null; } }),

    F({ id: 'coh_repeat', dim: 'coherence', name: '车轱辘话', unit: 'pct', dir: 'up', h: 0.06, a: 0.28, w: 2,
      desc: '相邻两句内容词重叠超过一半，等于把上一句换个说法又说了一遍。',
      calc: function (S) { return S.sentCount >= 8 ? S.repeatInfo : null; } }),

    F({ id: 'coh_contra', dim: 'coherence', name: '前后矛盾', unit: 'per1000', dir: 'up', h: 0, a: 2, w: 1.5,
      desc: '「从未…又一次」「唯一…另一个」，自己打自己脸。',
      calc: function (S) { return S.cjk >= 300 ? per1000(S.contradiction, S.cjk) : null; } }),

    /* ---- 标点口语 ---- */
    F({ id: 'p_punctDiv', dim: 'punct', name: '标点种类数', unit: 'count', dir: 'down', h: 4.5, a: 2.5, w: 2,
      desc: '全文用了多少种标点（。！？／，、／；：／引号／括号／破折号／省略号／书名号）。人类写作标点很花，模型几乎只用逗号句号。',
      calc: function (S) { return S.punctTotal >= 40 ? S.punctClasses : null; } }),

    F({ id: 'p_excl', dim: 'punct', name: '感叹/问号密度', unit: 'per1000', dir: 'down', h: 2.5, a: 0.7, w: 2,
      desc: '！？每千字次数。网文的情绪起伏靠它，模型很克制。',
      calc: function (S) { return per1000(S.excl, S.cjk); } }),

    F({ id: 'p_dash', dim: 'punct', name: '破折号密度', unit: 'per1000', dir: 'down', h: 1.6, a: 0.25, w: 2,
      desc: '——每千字次数。人类用它打断、转折、补一句，模型基本不用。',
      calc: function (S) { return per1000(S.dash, S.cjk); } }),

    F({ id: 'p_ellipsis', dim: 'punct', name: '省略号密度', unit: 'per1000', dir: 'up', h: 3.0, a: 6.5, w: 1,
      desc: '……每千字次数。适度是风格，过量且均匀就是模型。',
      calc: function (S) { return per1000(S.ellipsis, S.cjk); } }),

    F({ id: 'p_modal', dim: 'punct', name: '语气词密度', unit: 'per1000', dir: 'down', h: 6, a: 2, w: 1.5,
      desc: '啊/吧/嘛/呢/呗/哈……每千字次数。活人说话有语气，模型说话很标准。',
      calc: function (S) { return S.cjk >= 200 ? per1000(S.modalN, S.cjk) : null; } }),

    F({ id: 'p_slang', dim: 'punct', name: '口语/网络语密度', unit: 'per1000', dir: 'down', h: 3.5, a: 0.4, w: 2.5,
      desc: '卧槽/咋/啥/他妈……每千字次数。这是最难装的人味。',
      calc: function (S) { return S.cjk >= 200 ? per1000(S.slangN, S.cjk) : null; } }),

    F({ id: 'p_paren', dim: 'punct', name: '括号插话密度', unit: 'per1000', dir: 'down', h: 0.7, a: 0.12, w: 1,
      desc: '（）每千字次数。作者忍不住插一句话，模型不会。',
      calc: function (S) { return per1000(S.paren, S.cjk); } }),

    F({ id: 'p_semicolon', dim: 'punct', name: '分号密度', unit: 'per1000', dir: 'up', h: 0.4, a: 3.5, w: 3,
      desc: '「；」每千字次数。人类网文几乎不用分号，模型爱用它把长句焊起来——这一项去掉AI味时最常被漏掉。',
      calc: function (S) { return S.cjk >= 200 ? per1000(S.semicolon, S.cjk) : null; } }),

    F({ id: 'p_endEntropy', dim: 'punct', name: '句末标点单调', unit: 'num', dir: 'down', h: 0.60, a: 0.28, w: 1.5,
      desc: '句末标点（。！？…）的分布熵。全是句号收尾是典型模型习惯。',
      calc: function (S) { return S.sentCount >= 15 ? S.endEntropy : null; } }),

    F({ id: 'p_irregular', dim: 'punct', name: '手写不规范痕迹', unit: 'per1000', dir: 'down', h: 1.5, a: 0.2, w: 1.2,
      desc: '半角标点、连续重复标点、汉字间多余空格。人类打字的“毛边”。',
      calc: function (S) { return per1000(S.irregularN, S.cjk); } }),

    /* ---- 重复自噬 ---- */
    F({ id: 'r_maxngram', dim: 'repeat', name: '最长复用片段', unit: 'count', dir: 'up', h: 2, a: 4, w: 1.5,
      desc: '同一个 6 字串最多重复几次。模型会把自己写过的句子再写一遍。',
      calc: function (S) { return S.cjk >= 500 ? S.maxNgram : null; } }),

    F({ id: 'r_openRepeat', dim: 'repeat', name: '句首雷同度', unit: 'pct', dir: 'up', h: 0.14, a: 0.30, w: 1.5,
      desc: '最高频句首两字的占比（不含人称代词）。模型句句从同一个词起手。',
      calc: function (S) { return S.openRepeat; } }),

    F({ id: 'r_adjSim', dim: 'repeat', name: '相邻句相似度', unit: 'num', dir: 'up', h: 0.09, a: 0.20, w: 2,
      desc: '相邻两句的字符二元组重合度均值。模型在自我复读。',
      calc: function (S) { return S.adjSim; } }),

    F({ id: 'r_paraOpen', dim: 'repeat', name: '段首雷同度', unit: 'pct', dir: 'up', h: 0.10, a: 0.24, w: 1,
      desc: '最高频段首两字的占比。模型段落起手式雷同。',
      calc: function (S) { return S.paraOpenRepeat; } }),

    /* ---- 意象感官 ---- */
    F({ id: 'i_visualDom', dim: 'imagery', name: '视觉垄断度', unit: 'num', dir: 'up', h: 0.60, a: 0.84, w: 2,
      desc: '视觉词在全部感官词中的占比。模型只会写“看”，不会写“闻”和“疼”。',
      calc: function (S) { return S.senseTotal >= 10 ? S.visualRatio : null; } }),

    F({ id: 'i_dialogueRatio', dim: 'imagery', name: '对话篇幅占比', unit: 'pct', dir: 'down', h: 0.30, a: 0.10, w: 2,
      desc: '引号内文字占全文比例。小说靠对话推进，模型靠旁白推进。',
      calc: function (S) { return S.chars >= 400 ? S.dialogueRatio : null; } }),

    F({ id: 'i_dialogueLen', dim: 'imagery', name: '对话句平均长', unit: 'count', dir: 'up', h: 10, a: 24, w: 1.5,
      desc: '含对话的句子平均字数。真人说话短促，模型说话像念台词。',
      calc: function (S) { return S.dlgSentCount >= 5 ? S.dlgAvgLen : null; } }),

    F({ id: 'i_bodyAction', dim: 'imagery', name: '具体动作密度', unit: 'per1000', dir: 'down', h: 14, a: 5, w: 1.5,
      desc: '抬手/弯腰/攥紧/推开……每千字次数。人类写身体，模型写心情。',
      calc: function (S) { return S.cjk >= 300 ? per1000(S.bodyC.total, S.cjk) : null; } }),

    /* ---- 叙事骨架（"笔力"向：直接给事件，还是先铺气氛） ---- */
    F({ id: 'n_setupRatio', dim: 'imagery', name: '无实体句占比', unit: 'pct', dir: 'up', h: 0.12, a: 0.34, w: 2.5,
      desc: '既没有具体物、也没有数字和对白的句子比例（纯气氛/心理）。有笔力的句子一定带实的东西。',
      calc: function (S) { return S.setupRatio; } }),

    F({ id: 'n_abstractRatio', dim: 'imagery', name: '抽象词占比', unit: 'num', dir: 'up', h: 0.35, a: 0.85, w: 2.5,
      desc: '抽象词 ÷ (抽象词+具体词)。骨架叙事用具体名词，模型用大道/命运/气息这类空壳词。',
      calc: function (S) {
        var t = S.abstractC.total + S.concreteC.total;
        return t >= 6 ? S.abstractC.total / t : null;
      } }),

    F({ id: 'n_directRatio', dim: 'imagery', name: '直接引语占比', unit: 'pct', dir: 'down', h: 0.62, a: 0.28, w: 2,
      desc: '带引号的句子 ÷（带引号 + 只有说话动词）。前者是演，后者是讲；转述越多越像概述式生成。',
      calc: function (S) { return S.directRatio; } }),

    /* ---- 空转密度 ---- */
    F({ id: 'h_hedge', dim: 'hedge', name: '模糊限定词密度', unit: 'per1000', dir: 'up', h: 6, a: 18, w: 3,
      desc: '似乎/仿佛/某种/说不清/下意识/不由得——模型最爱的不确定语气。',
      calc: function (S) { return per1000(S.hedge.total, S.cjk); },
      hits: function (S) { return S.hedge.hits; } }),

    F({ id: 'h_empty', dim: 'hedge', name: '空转句比例', unit: 'pct', dir: 'up', h: 0.08, a: 0.28, w: 2,
      desc: '通篇抽象词、没有具体物也没有数字的句子占比。说了很多，什么也没说。',
      calc: function (S) { return S.sentCount >= 8 ? S.emptyRatio : null; } }),

    F({ id: 'h_absolute', dim: 'hedge', name: '绝对化表述', unit: 'per1000', dir: 'up', h: 1.5, a: 4.5, w: 1,
      desc: '皆是/无不/无一例外/终究……模型爱下全称判断。',
      calc: function (S) { return per1000(findAll(S.text, /皆是|无不|无一例外|尽数|统统|处处|终究|注定/g).length, S.cjk); } }),

    F({ id: 'h_psychChain', dim: 'hedge', name: '心理词连用', unit: 'pct', dir: 'up', h: 0.12, a: 0.38, w: 1.5,
      desc: '同一段里出现两个以上心理动词的段落占比。模型会在一句话里把情绪解释三遍。',
      calc: function (S) {
        if (S.paraCount < 5) return null;
        var words = ['感到', '觉得', '意识到', '明白', '知道', '心中', '心里', '内心', '情绪', '感受', '心口'];
        var hit = 0;
        for (var i = 0; i < S.paragraphs.length; i++) {
          var p = S.paragraphs[i].text, c = 0;
          for (var j = 0; j < words.length; j++) { if (p.indexOf(words[j]) >= 0) c++; }
          if (c >= 2) hit++;
        }
        return pct(hit, S.paragraphs.length);
      } }),

    /* ---- 可预测性（实验） ---- */
    F({ id: 'q_pred', dim: 'predict', name: '字符可预测性', unit: 'num', dir: 'up', h: 0.18, a: 0.30, w: 0.8,
      desc: '1 − H(下一字|上一字)/H(单字)，困惑度的廉价代理。越可预测越像模型输出。',
      calc: function (S) { return S.predictability; } })
  ];

  var FIXES = {
    rhythm_cv: '打断几句。挑 3 处把长句拆成 5–8 字的短句，或者把两句并成一句 60 字的长句，让长短彻底错开。',
    rhythm_short: '给几处动作或反应单独起一段，只写四五个字：「他没动。」「冷。」',
    rhythm_mid: '把连续的中等长句打断，换成一句极短和一句极长，别让读者感觉在匀速行驶。',
    rhythm_metronome: '连续等长句是替换重灾区——挑中间两句改字数和语序，让节奏踩空一次。',
    rhythm_entropy: '让句长分布拉开：短到 3 字，长到 80 字，别都挤在 20 字附近。',
    rhythm_para1: '把情绪最重的地方单独抽成一行。网文的呼吸感就靠这个。',
    rhythm_paraCv: '让段落故意不齐：一处 400 字狂写，一处只有 6 个字。',
    lex_redup: '叠词副词删掉七成。「缓缓地走过去」直接写「走过去」，动作本身就够了。',
    lex_redupDi: '「轻轻地」「缓缓地」这类结构留一两个当点缀就够，其余换成具体动作。',
    lex_idiom: '四字成语砍掉大半，尤其是拿它代替描写的地方。',
    lex_abstract: '把「命运」「时间」「世界」换成眼前看得见的东西：墙角的水渍、没关严的窗。',
    lex_concrete: '补具体物。不要写「房间很冷」，写「暖气片是凉的」。',
    lex_number: '补数字：几点、几步、几下、多少钱。具体数字是人的痕迹。',
    lex_degree: '「极其」「无比」这类副词删掉，用一个动作或一个细节顶上去。',
    lex_emotion: '别写「他很恐惧」，写他做了什么。情绪词是结论，动作是过程。',
    syn_notbut: '「不是…而是…」拆开，只留一半，让读者自己补。',
    syn_parallel: '排比留一处，其余打散，别让三句都一个结构。',
    syn_metaphor: '比喻减量，而且别用「仿佛/宛如」：直接陈述喻体，会更狠。',
    syn_gaze: '「眼底闪过」「嘴角勾起一抹」这类表情包全部重写，换成具体的小动作，比如「他把烟按熄在碗里」。',
    syn_tag: '对话标签减半，多用动作替标签：「『走。』他先出门了。」',
    syn_connector: '「然而」「于是」「就在这时」删掉，靠场景切换，读者跟得上。',
    syn_psych: '「他知道」「心中一紧」砍掉，让事件自己说话。',
    syn_ending: '删掉段末那句总结。让段落停在动作或对话上。',
    syn_nounify: '「…的沉默」改回动词句：「他沉默了」。',
    gram_redundant: '「大约…左右」删掉一个；「目的是为了」改成「是为了」。',
    gram_syncretic: '「原因是…造成的」二选一，只能留一个句式：「原因是X」或「是X造成的」。',
    gram_de: '「说的好」改成「说得好」。定语用「的」，状语用「地」，补语用「得」。',
    gram_subject: '「通过…，让…」把主语补回来：「通过这次经历，他明白了」。',
    gram_dup: '删掉重复的字。',
    gram_commaRun: '在视觉上找一处落句号，长句切成两句。',
    gram_conj: '把后半句补上：「虽然…，但是…」「因为…，所以…」。缺了后件，整句就是半截话。',
    gram_runon: '四十多个字连一个逗号都没有，找两个地方断开。',
    coh_jump: '这两句之间缺一句过渡，或者干脆分段。读者不会替你脑补。',
    coh_repeat: '把重复的那句删掉，直接往下走。',
    coh_contra: '前后说法打架，只能留一个。',
    p_punctDiv: '标点花一点：破折号、省略号、括号、感叹号都该用起来。',
    p_excl: '该喊就喊。情绪爆发处用！，别全用句号压平。',
    p_dash: '插入、打断、补一句，用——。这是人写东西时改来改去的痕迹。',
    p_ellipsis: '省略号别句句都有，用得越平均越假。',
    p_modal: '对话里加点语气词：「行吧」「你说呢」「啊？」。',
    p_slang: '人物该说人话。「我不去。」比「我不想去。」狠；「滚」比「请你离开」真实。',
    p_paren: '偶尔用括号插一句吐槽，那是作者露出来的手。',
    p_semicolon: '把分号全改成句号或逗号。人类网文几乎不用分号，这是残留的AI痕迹。',
    syn_redup: '「一盒一盒」「一遍一遍」这类叠用只留一处，其余改成具体数量或直接写结果。',
    syn_essay: '删掉「所谓…不过是…」「不只是…更是…」这类议论句。让情节自己说话，别替读者总结人生。',
    p_endEntropy: '别句句句号收尾，该问就问，该叹就叹，该拖就拖。',
    p_irregular: '这段太干净了。人打字会有毛边：半角标点、重复标点、打错的字。',
    r_maxngram: '有句子被写了两遍，删掉重复的那处。',
    r_openRepeat: '换句首。别每段都从「他」或者同一个词开头。',
    r_adjSim: '相邻两句用词重复，把第二句换个说法或者删掉。',
    r_paraOpen: '段首别都用同一个起手式，试试从对话、声音、动作切进去。',
    i_visualDom: '追加其他感官：气味、触感、温度、声音。别让读者只用眼睛。',
    i_dialogueRatio: '把一段旁白改写成对话，让人物自己说出来。',
    i_dialogueLen: '对话切短。一个人不会一口气说 40 个字。',
    i_bodyAction: '补身体动作：手在做什么，脚在做什么。',
    n_setupRatio: '把开头铺景的句子砍掉一半，直接从事件的第一句切入。',
    n_abstractRatio: '把「命运/气息/大道/力量」换成能摸到的东西：一只鞋、三道白痕、七万六。',
    n_directRatio: '把「他说事情很严重」改成他自己开口说一句原话。转述省事，但没有现场感。',
    n_concretePerSent: '让每句话都带上一个实物或一个动作，别让人物停在「沉默」「顿了顿」里。',
    h_hedge: '「似乎」「仿佛」「某种」「下意识」每个全文留一两次就够，其余删。',
    h_empty: '这些句子说了很多但什么也没说，整段换成一个具体场景。',
    h_absolute: '「终究」「注定」「无一例外」太满了，留余地。',
    h_psychChain: '一段里别解释三遍情绪，砍到一遍。',
    q_pred: '文字整体过于可预测，可能是按模板生成的。加些意外的词和断裂的句子。'
  };

  /* ============================================================
   * 七、聚合打分
   * ============================================================ */

  function resolveParams(def, cal) {
    var cf = cal && cal.features && cal.features[def.id];
    return {
      h: (cf && typeof cf.h === 'number') ? cf.h : def.h,
      a: (cf && typeof cf.a === 'number') ? cf.a : def.a,
      dir: (cf && (cf.dir === 'up' || cf.dir === 'down')) ? cf.dir : def.dir,
      w: def.w * ((cf && typeof cf.w === 'number') ? cf.w : 1)
    };
  }

  function normRaw(p, v) {
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return null;
    var n = p.dir === 'up' ? safeDiv(v - p.h, p.a - p.h, 0) : safeDiv(p.h - v, p.h - p.a, 0);
    return clamp01(n);
  }

  function fmtValue(def, v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    if (def.unit === 'pct') return round(v * 100, 1) + '%';
    if (def.unit === 'per1000') return round(v, 2) + ' /千字';
    if (def.unit === 'count') return round(v, 1) + ' 次';
    return round(v, 2);
  }

  function fmtRef(def, v) {
    if (v === null || v === undefined) return '—';
    return fmtValue(def, v);
  }

  /* ============================================================
   * 八、句级定位
   * ============================================================ */

  function scoreSentences(S, overall) {
    var sents = S.sentences, i, j;
    var raws = new Array(sents.length);

    for (i = 0; i < sents.length; i++) {
      var s = sents[i], pts = 0, flags = [];

      // 长度落在均值附近
      if (s.len >= 12 && s.len <= 42 && Math.abs(s.len - S.mean) < 0.18 * Math.max(S.mean, 1)) {
        pts += 0.9; flags.push({ id: 'len', name: '长度居中' });
      }
      // 套路命中（String.match 配 /g 不会污染 lastIndex，可以复用同一个正则）
      for (j = 0; j < SENT_PATTERNS.length; j++) {
        var p = SENT_PATTERNS[j];
        var hit = s.t.match(p.re);
        if (hit) {
          pts += Math.min(hit.length, 3) * p.w * 0.75;
          flags.push({ id: p.id, name: p.name + (hit.length > 1 ? '×' + hit.length : '') });
        }
      }
      // 抽象空转
      var ab = 0, key;
      for (key in S.abstractC.map) { if (s.t.indexOf(key) >= 0) ab++; }
      if (ab >= 2) {
        var conc = false, ck;
        for (ck in S.concreteC.map) { if (s.t.indexOf(ck) >= 0) { conc = true; break; } }
        if (!conc) { pts += 0.8; flags.push({ id: 'empty', name: '空转' }); }
      }
      // 与前句相似
      if (i > 0 && s.len >= 6 && sents[i - 1].len >= 6) {
        var jam = jaccard(bigramsOf(s.t), bigramsOf(sents[i - 1].t));
        if (jam > 0.16) { pts += 0.7; flags.push({ id: 'sim', name: '与上句雷同' }); }
      }

      raws[i] = { pts: Math.min(pts, 6), flags: flags };
    }

    var meanPts = 0;
    for (i = 0; i < raws.length; i++) meanPts += raws[i].pts;
    meanPts = meanPts / Math.max(raws.length, 1);

    var scores = new Array(sents.length);
    for (i = 0; i < sents.length; i++) {
      var delta = (raws[i].pts - meanPts) * 16;
      scores[i] = clamp(Math.round(overall + delta), 0, 100);
    }

    // 平滑
    var smooth = scores.slice();
    for (i = 0; i < scores.length; i++) {
      var a2 = scores[i - 1] === undefined ? scores[i] : scores[i - 1];
      var b2 = scores[i + 1] === undefined ? scores[i] : scores[i + 1];
      smooth[i] = Math.round(0.22 * a2 + 0.56 * scores[i] + 0.22 * b2);
    }

    var out = [];
    for (i = 0; i < sents.length; i++) {
      out.push({
        i: i,
        t: sents[i].t,
        len: Math.round(sents[i].len),
        dlg: sents[i].dlg,
        score: smooth[i],
        flags: raws[i].flags.slice(0, 4)
      });
    }
    return out;
  }

  /* ============================================================
   * 八点五、段落级判定（对外的"一段一判"，比句级粗、比全文细）
   * ============================================================ */

  function paraIndexAt(paras, pos) {
    var lo = 0, hi = paras.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var p = paras[mid];
      if (pos < p.start) hi = mid - 1;
      else if (pos >= p.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function scoreParagraphs(S, sentences, features, hitMap) {
    var out = [], i, j, k;
    var names = {};
    for (i = 0; i < FEATURES.length; i++) names[FEATURES[i].id] = FEATURES[i].name;

    var rows = [];
    for (i = 0; i < S.paragraphs.length; i++) {
      var p = S.paragraphs[i];
      var sum = 0, n = 0, flags = Object.create(null);
      for (j = 0; j < p.sents.length; j++) {
        var s = sentences[p.sents[j].idx];
        if (!s) continue;
        sum += s.score; n++;
        for (k = 0; k < s.flags.length; k++) {
          var f = s.flags[k];
          if (!flags[f.id]) flags[f.id] = { id: f.id, name: f.name.replace(/×\d+$/, ''), count: 0 };
          flags[f.id].count++;
        }
      }

      // 段落自身的套路强度（每百字计点数），让段落之间真正拉开差距，
      // 而不是全都贴着全文均分
      var localPts = 0;
      for (var sp = 0; sp < SENT_PATTERNS.length; sp++) {
        var mm = p.text.match(SENT_PATTERNS[sp].re);
        if (mm) localPts += Math.min(mm.length, 4) * SENT_PATTERNS[sp].w;
      }
      // 段内句长过于整齐，再加一点
      var lens = p.sents.map(function (x) { return x.len; }).filter(function (v) { return v > 0; });
      if (lens.length >= 3) {
        var mu = lens.reduce(function (a, b) { return a + b; }, 0) / lens.length;
        var vv = 0;
        for (j = 0; j < lens.length; j++) vv += (lens[j] - mu) * (lens[j] - mu);
        var sdv = Math.sqrt(vv / lens.length);
        if (mu > 6 && sdv / mu < 0.28) localPts += 0.9;
      }
      localPts = localPts / Math.max(p.len, 12) * 100;

      rows.push({
        avg: n ? sum / n : 0,
        local: localPts,
        p: p,
        flags: flags
      });
    }

    // 把段落套路强度转成相对的 z 分，加到句级均分上
    var mLocal = 0, vLocal = 0;
    for (i = 0; i < rows.length; i++) mLocal += rows[i].local;
    mLocal = mLocal / Math.max(rows.length, 1);
    for (i = 0; i < rows.length; i++) vLocal += (rows[i].local - mLocal) * (rows[i].local - mLocal);
    var sLocal = Math.sqrt(vLocal / Math.max(rows.length, 1));

    for (i = 0; i < rows.length; i++) {
      var r = rows[i], p2 = r.p;
      var z = sLocal > 0.001 ? (r.local - mLocal) / sLocal : 0;
      var ps = clamp(Math.round(r.avg + z * 12), 0, 100);

      // 太短的段落不给判定：标题、单句对白这类，统计特征没有意义，
      // 硬给分会出「第一章 解剖台 = 94 分」这种笑话。
      var isHeading = /^\s*第[\s　]*[0-9零一二三四五六七八九十百千两]{1,9}[\s　]*[章回节卷篇]/.test(p2.text) ||
                      /^\s*(序章|楔子|尾声|后记|番外)/.test(p2.text);
      var tooShort = p2.len < 15;

      // 段内三档占比（按字数算），结论取占比最大的那一档
      var trio = { human: 0, suspected: 0, high: 0 }, tot = 0;
      for (j = 0; j < p2.sents.length; j++) {
        var ss = sentences[p2.sents[j].idx];
        if (!ss) continue;
        var w = Math.max(1, ss.len || 0);
        var vk = verdictOf(ss.score).key;
        trio[vk] = (trio[vk] || 0) + w;
        tot += w;
      }
      var dom = 'human';
      if (trio.suspected > trio[dom]) dom = 'suspected';
      if (trio.high > trio[dom]) dom = 'high';
      var pctDom = tot > 0 ? Math.round(trio[dom] / tot * 1000) / 10 : 100;

      var skip = isHeading || tooShort;
      out.push({
        index: i + 1,
        start: p2.start,
        end: p2.end,
        text: p2.text.trim(),
        chars: Math.round(p2.len),
        sentences: p2.sents.length,
        sents: p2.sents.map(function (x) { return x.idx; }),
        score: skip ? null : ps,
        band: skip ? null : bandOf(ps).key,
        // 判定必须由分数推出，不能用句级投票另算一套——
        // 两套算法打架时会出「人写 · 90 分」这种自相矛盾的卡片
        verdict: skip ? 'skip' : verdictOf(ps).key,
        skip: skip,
        skipReason: isHeading ? '标题行' : (tooShort ? '段落过短' : ''),
        pct: skip ? null : pctDom,
        mix: {
          human: tot ? Math.round(trio.human / tot * 1000) / 10 : 0,
          suspected: tot ? Math.round(trio.suspected / tot * 1000) / 10 : 0,
          high: tot ? Math.round(trio.high / tot * 1000) / 10 : 0
        },
        flags: Object.keys(r.flags).map(function (key) { return r.flags[key]; })
          .sort(function (a, b) { return b.count - a.count; }).slice(0, 4),
        hits: []
      });
    }

    // 把词级命中的真实位置分派给段落，作为该段的"硬证据"
    if (hitMap) {
      for (var id in hitMap) {
        if (!Object.prototype.hasOwnProperty.call(hitMap, id)) continue;
        var hits = hitMap[id];
        var counts = Object.create(null);
        for (i = 0; i < hits.length; i++) {
          var pi = paraIndexAt(S.paragraphs, hits[i].i);
          if (pi < 0) continue;
          if (!counts[pi]) counts[pi] = { id: id, name: names[id] || id, count: 0, samples: [] };
          counts[pi].count++;
          if (counts[pi].samples.length < 3) counts[pi].samples.push(hits[i].s);
        }
        for (var pk in counts) {
          if (!Object.prototype.hasOwnProperty.call(counts, pk)) continue;
          var target = out[Number(pk)];
          if (target) target.hits.push(counts[pk]);
        }
      }
      for (i = 0; i < out.length; i++) {
        out[i].hits.sort(function (a, b) { return b.count - a.count; });
        out[i].hits = out[i].hits.slice(0, 4);
      }
    }
    return out;
  }

  /* ============================================================
   * 九、主分析函数
   * ============================================================ */

  /**
   * 特征 → 10 维 → 指数。analyze 和 scoreFromFeatures 共用同一条路径。
   * onlyIds 有值时，只统计这些特征（模型启用时用它对齐维度拆解，
   * 免得拆解里出现模型根本没用的项——比如覆盖率不足被丢掉的「可预测性」）。
   */
  function aggregate(features, dimMul, scoreMap, onlyIds) {
    var dims = [], totalW = 0, totalScore = 0, i, j;
    for (i = 0; i < DIMS.length; i++) {
      var d = DIMS[i], sum = 0, wsum = 0, list = [];
      for (j = 0; j < features.length; j++) {
        if (features[j].dim !== d.key || features[j].skipped) continue;
        if (onlyIds && !onlyIds[features[j].id]) continue;
        sum += features[j].norm * features[j].w;
        wsum += features[j].w;
        list.push(features[j]);
      }
      var ds = wsum > 0 ? sum / wsum : null;
      var dmul = (dimMul && typeof dimMul[d.key] === 'number') ? dimMul[d.key] : 1;
      var dw = d.weight * dmul;
      dims.push({
        key: d.key, name: d.name, desc: d.desc, weight: round(dw, 2),
        score: ds === null ? null : Math.round(ds * 100),
        features: list.map(function (f) { return f.id; })
      });
      if (ds !== null && dw > 0) { totalW += dw; totalScore += ds * dw; }
    }
    var rawScore = totalW > 0 ? totalScore / totalW : 0;
    var score;
    // 校准过的引擎用数据定出来的两个锚点：人类均值 → 20 分，AI 均值 → 78 分
    if (scoreMap && typeof scoreMap.h === 'number' && typeof scoreMap.a === 'number' &&
        (scoreMap.a - scoreMap.h) > 0.02) {
      var t = (rawScore - scoreMap.h) / (scoreMap.a - scoreMap.h);
      score = Math.round(clamp(20 + 58 * t, 0, 100));
    } else {
      // 默认锚点：0.02 ～ 0.80 映射到 0 ～ 100
      score = Math.round(clamp01((rawScore - 0.02) / 0.78) * 100);
    }
    return { dims: dims, rawScore: rawScore, score: score };
  }

  /**
   * 只凭"特征实测值"重新算分，不重新分析文本。校准脚本用它快速评估。
   * @param {Object} values      { featureId: 数值 }
   * @param {Object} calibration 校准配置
   */
  function scoreFromFeatures(values, calibration) {
    var feats = [], i, def, p, n, v;
    for (i = 0; i < FEATURES.length; i++) {
      def = FEATURES[i];
      p = resolveParams(def, calibration);
      v = values ? values[def.id] : undefined;
      n = (typeof v === 'number' && !isNaN(v)) ? normRaw(p, v) : null;
      if (n === null) {
        feats.push({ id: def.id, dim: def.dim, name: def.name, skipped: true, w: p.w });
        continue;
      }
      feats.push({ id: def.id, dim: def.dim, name: def.name, norm: n, w: p.w });
    }
    var agg = aggregate(feats, calibration && calibration.dimWeights, calibration && calibration.scoreMap);
    return { score: agg.score, rawScore: agg.rawScore, dims: agg.dims };
  }

  /**
   * 逻辑回归模型打分（model.json 由 train.py 产出）。
   * z = b + Σ w_i · (v_i − mean_i) / std_i，p = sigmoid(z)，分数 = p × 100
   * 有模型时优先于人工权重。
   */
  function modelScore(features, model) {
    // demo:true 的模型是合成数据训出来的，绝不能用来打分
    if (!model || model.demo === true || !model.features || !model.features.length) return null;
    var byId = {}, i;
    for (i = 0; i < features.length; i++) byId[features[i].id] = features[i];
    var z = Number(model.intercept) || 0;
    var clip = Number(model.zClip) > 0 ? Number(model.zClip) : 3;
    for (i = 0; i < model.features.length; i++) {
      var mf = model.features[i];
      var f = byId[mf.id];
      var v = (f && typeof f.value === 'number') ? f.value : (Number(mf.mean) || 0);
      var sd = Number(mf.std) || 1;
      // 单项标准化后必须截断：否则一个近似常量特征就能用 z=-6 把结论掀翻
      var zi = (v - (Number(mf.mean) || 0)) / sd;
      if (zi > clip) zi = clip; else if (zi < -clip) zi = -clip;
      z += (Number(mf.w) || 0) * zi;
    }
    z = Math.max(-35, Math.min(35, z));
    var p = 1 / (1 + Math.exp(-z));
    return Math.round(clamp01(p) * 100);
  }

  /**
   * 用**默认锚点**算某个维度的绝对分数（0-100，越高越"偏离人写的常态"）。
   *
   * 和 aggregate() 的区别：这里完全不看 calibration。
   * 通顺度是绝对判断（"这句话读得顺不顺"），不能跟着"哪一类更常见"翻方向，
   * 否则零语病的文章会被判成"语病严重"。
   */
  function absoluteDimScore(valById, dimKey) {
    var totalW = 0, sum = 0;
    for (var i = 0; i < FEATURES.length; i++) {
      var d = FEATURES[i];
      if (d.dim !== dimKey) continue;
      if (typeof d.h !== 'number' || typeof d.a !== 'number') continue;
      var v = valById[d.id];
      if (typeof v !== 'number') continue;
      var span = d.dir === 'down' ? (d.h - d.a) : (d.a - d.h);
      if (!(Math.abs(span) > 1e-9)) continue;
      var n = d.dir === 'down' ? (d.h - v) / span : (v - d.h) / span;
      var w = (typeof d.w === 'number' && d.w > 0) ? d.w : 1;
      sum += clamp01(n) * w;
      totalW += w;
    }
    return totalW > 0 ? Math.round(sum / totalW * 100) : null;
  }

  function anError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function analyze(raw, options) {
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var opts = options || {};
    if (typeof raw !== 'string') throw anError('BAD_INPUT', 'text 必须是字符串');
    var text = raw.replace(/\r\n?/g, '\n');
    if (!text.trim()) throw anError('EMPTY_TEXT', '文本为空');

    var cjkAll = cjkCount(text);
    if (cjkAll < 20) throw anError('TEXT_TOO_SHORT', '中文内容不足 20 字，无法分析');
    var ratio = safeDiv(cjkAll, text.replace(/\s/g, '').length, 0);
    if (ratio < 0.3) throw anError('NOT_CHINESE', '中文占比过低（' + Math.round(ratio * 100) + '%），本引擎仅支持中文文本');

    var maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
    var S = buildStats(text, { maxChars: maxChars });
    var weights = opts.featureWeights || {};
    var dimMul = opts.dimWeights || {};

    var features = [], i, def, v, n, skipped = 0;
    var cal = opts.calibration || null;
    for (i = 0; i < FEATURES.length; i++) {
      def = FEATURES[i];
      var pp = resolveParams(def, cal);
      var out = { id: def.id, dim: def.dim, name: def.name, unit: def.unit, dir: pp.dir, desc: def.desc, w: pp.w };
      try {
        v = def.calc(S);
        n = normRaw(pp, v);
        if (n === null) {
          out.skipped = true;
          out.display = '样本不足';
          skipped++;
          features.push(out);
          continue;
        }
        out.value = round(v, 4);
        out.norm = n;
        out.display = fmtValue(def, v);
        out.humanRef = fmtValue(def, pp.h);
        out.aiRef = fmtValue(def, pp.a);
        out.humanRange = fmtValue(def, pp.h);
        out.aiRange = fmtValue(def, pp.a);
        if (cal && cal.features && cal.features[def.id]) out.calibrated = true;
        if (typeof weights[def.id] === 'number') out.w = pp.w * weights[def.id];
        features.push(out);
      } catch (e) {
        out.skipped = true;
        out.display = '计算异常';
        out.error = String(e && e.message || e);
        skipped++;
        features.push(out);
      }
    }

    // 维度聚合。启用模型时，维度拆解只统计模型真正用到的特征，
    // 否则会出现"可预测性 100 分"这种模型根本没参与打分的项。
    var modelIds = null;
    if (opts.model && opts.model.features && opts.model.features.length) {
      modelIds = {};
      for (i = 0; i < opts.model.features.length; i++) modelIds[opts.model.features[i].id] = 1;
    }
    var agg = aggregate(features, dimMul, cal && cal.scoreMap, modelIds);
    var dims = agg.dims;
    var rawScore = agg.rawScore;
    var score = agg.score;
    var scoreMode = 'rules';
    // 有训练好的模型就优先用模型（model.json），否则用人工权重
    var mScore = opts.model ? modelScore(features, opts.model) : null;
    if (mScore !== null) { score = mScore; scoreMode = 'model'; }
    var band = bandOf(score);
    var verdict = verdictOf(score);

    // 通顺度：单独一条线，回答"这句话读得顺不顺"，和"像不像 AI"分开。
    //
    // 关键：这里必须用**默认锚点**算，不能用校准后的。
    // 校准是按"哪一类更常见"翻方向的，语病少的一类会被判成"更像 AI"——
    // 于是零语病的文章在通顺度上拿满分（曾经出现"语病杂糅 74 分、明显不通顺"的误报）。
    // 通顺度是绝对判断，不是相对判断。
    var valById = {};
    for (i = 0; i < features.length; i++) {
      if (!features[i].skipped && typeof features[i].value === 'number') valById[features[i].id] = features[i].value;
    }
    var gScore = absoluteDimScore(valById, 'grammar');
    var cScore = absoluteDimScore(valById, 'coherence');
    var fluency = { score: null, label: '样本不足', pass: true, grammar: gScore, coherence: cScore };
    if (gScore !== null || cScore !== null) {
      var badness = (gScore || 0) * 0.6 + (cScore || 0) * 0.4;
      var fs = Math.round(clamp(100 - badness, 0, 100));
      fluency = {
        score: fs,
        label: fs >= 85 ? '通顺' : (fs >= 65 ? '略有瑕疵' : '明显不通顺'),
        pass: fs >= 65,
        grammar: gScore,
        coherence: cScore
      };
    }

    // 综合放行结论：像人才过，像人但读不通也不过
    var gate = { pass: verdict.key === 'human' && fluency.pass, reason: '' };
    if (!gate.pass) {
      gate.reason = verdict.key !== 'human' ? '疑似机器书写' : '文字质量不达标';
    }

    // 置信度
    var conf;
    if (cjkAll < 200) conf = { level: '极低', margin: 35, note: '样本不足 200 字，统计特征不可靠，请勿据此判定' };
    else if (cjkAll < 500) conf = { level: '低', margin: 18, note: '样本偏短，建议 1000 字以上再判断' };
    else if (cjkAll < 1500) conf = { level: '中', margin: 10, note: '样本够做初步判断' };
    else if (cjkAll < 5000) conf = { level: '较高', margin: 6, note: '样本充足，结论相对稳定' };
    else conf = { level: '高', margin: 4, note: '样本充足，结论稳定' };

    if (S.truncated) S.warnings.push('文本超过 ' + maxChars + ' 字，仅分析前 ' + maxChars + ' 字（整本请用章节模式）');

    // 句级
    var sentences = [];
    try { sentences = scoreSentences(S, score); } catch (e) { S.warnings.push('句级定位失败：' + e.message); }

    // 词级命中位置（用于段落归属）
    var hitMap = {};
    for (i = 0; i < FEATURES.length; i++) {
      var dfe = FEATURES[i];
      if (!dfe.hits) continue;
      var fr = null;
      for (var q2 = 0; q2 < features.length; q2++) { if (features[q2].id === dfe.id) { fr = features[q2]; break; } }
      if (!fr || fr.skipped) continue;
      try { hitMap[dfe.id] = dfe.hits(S) || []; } catch (e2) { hitMap[dfe.id] = []; }
    }

    // 段落级（对外的主要呈现形式）
    var paraList = [];
    try { paraList = scoreParagraphs(S, sentences, features, hitMap); }
    catch (e) { S.warnings.push('段落定位失败：' + e.message); }

    // 三档文本占比（朱雀那种环形图用的就是它）
    var comp = {
      human: { key: 'human', label: '人工特征', chars: 0, paragraphs: 0, ratio: 0 },
      suspected: { key: 'suspected', label: '疑似 AI', chars: 0, paragraphs: 0, ratio: 0 },
      high: { key: 'high', label: 'AI 特征', chars: 0, paragraphs: 0, ratio: 0 }
    };
    for (i = 0; i < paraList.length; i++) {
      if (paraList[i].skip) continue;
      var pk = paraList[i].verdict || verdictOf(paraList[i].score).key;
      if (!comp[pk]) continue;
      comp[pk].chars += paraList[i].chars;
      comp[pk].paragraphs++;
    }
    var compTotal = comp.human.chars + comp.suspected.chars + comp.high.chars;
    if (compTotal > 0) {
      comp.human.ratio = Math.round(comp.human.chars / compTotal * 1000) / 10;
      comp.suspected.ratio = Math.round(comp.suspected.chars / compTotal * 1000) / 10;
      comp.high.ratio = Math.round((100 - comp.human.ratio - comp.suspected.ratio) * 10) / 10;
      if (comp.high.ratio < 0) comp.high.ratio = 0;
    }

    // 段落里分数越线的（含"疑似"档），按分数排
    var suspiciousParagraphs = paraList
      .filter(function (p) { return !p.skip && p.verdict !== 'human' && p.chars >= 20; })
      .sort(function (a, b) { return b.score - a.score || b.chars - a.chars; })
      .slice(0, 10);

    // 疑似段落块
    var blocks = [], cur = null;
    for (i = 0; i < sentences.length; i++) {
      if (sentences[i].score >= 65) {
        if (!cur) cur = { start: i, end: i, sum: 0 };
        cur.end = i; cur.sum += sentences[i].score;
      } else if (cur) {
        cur.avg = Math.round(cur.sum / (cur.end - cur.start + 1));
        blocks.push(cur); cur = null;
      }
    }
    if (cur) { cur.avg = Math.round(cur.sum / (cur.end - cur.start + 1)); blocks.push(cur); }
    blocks = blocks.filter(function (b) { return b.end - b.start >= 1; })
      .sort(function (a, b) { return b.avg - a.avg; }).slice(0, 5);

    var blockOut = blocks.map(function (b) {
      var txt = '';
      for (var k = b.start; k <= Math.min(b.end, b.start + 5); k++) txt += sentences[k].t;
      return { start: b.start, end: b.end, avg: b.avg, preview: txt.slice(0, 90) + (txt.length > 90 ? '…' : '') };
    });

    // 证据 / 发现
    var findings = [];
    var cands = features.filter(function (f) { return !f.skipped && f.norm >= 0.55; })
      .sort(function (a, b) { return (b.norm * b.w) - (a.norm * a.w); })
      .slice(0, 9);

    for (i = 0; i < cands.length; i++) {
      var f = cands[i], def2 = null, k2;
      for (k2 = 0; k2 < FEATURES.length; k2++) { if (FEATURES[k2].id === f.id) { def2 = FEATURES[k2]; break; } }
      var evidence = [];
      if (def2 && def2.hits) {
        try {
          var hs = (def2.hits(S) || []).slice(0, 3);
          for (var q = 0; q < hs.length; q++) {
            var from = Math.max(0, hs[q].i - 10), to = Math.min(S.text.length, hs[q].i + hs[q].s.length + 10);
            evidence.push((from > 0 ? '…' : '') + S.text.slice(from, to).replace(/\n/g, ' ') + (to < S.text.length ? '…' : ''));
          }
        } catch (e) { /* 忽略证据异常 */ }
      }
      findings.push({
        id: f.id,
        dim: f.dim,
        dimName: (DIMS.filter(function (x) { return x.key === f.dim; })[0] || {}).name || f.dim,
        severity: f.norm >= 0.82 ? 'high' : (f.norm >= 0.68 ? 'mid' : 'low'),
        title: f.name + (f.norm >= 0.82 ? '：明显偏离人类区间' : '：轻度偏离'),
        metric: f.display,
        humanRef: f.humanRange,
        aiRef: f.aiRange,
        deviation: Math.round(f.norm * 100),
        desc: f.desc,
        evidence: evidence,
        fix: FIXES[f.id] || ''
      });
    }

    // 总结
    var topDims = dims.filter(function (x) { return x.score !== null; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 2);
    var summary = buildSummary(score, verdict, topDims, findings, conf, cjkAll);

    // 改写建议
    var fixes = findings.filter(function (f2) { return f2.fix; }).slice(0, 6)
      .map(function (f2) { return { id: f2.id, title: f2.title.split('：')[0], fix: f2.fix }; });

    var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    return {
      ok: true,
      version: VERSION,
      engine: 'xuanwu-heuristic',
      text: {
        chars: S.chars,
        cjk: cjkAll,
        analyzedCjk: S.cjk,
        truncated: S.truncated,
        sentences: S.sentCount,
        paragraphs: S.paraCount,
        dialogueRatio: round(S.dialogueRatio * 100, 1) + '%',
        meanSentLen: round(S.mean, 1),
        sentCv: round(S.cv, 2)
      },
      score: score,
      scoreMode: scoreMode,
      verdict: {
        key: verdict.key,
        label: verdict.label,
        color: verdict.color,
        desc: verdict.desc,
        advice: verdict.advice
      },
      band: { key: band.key, label: band.label, color: band.color, advice: band.advice },
      textType: S.textType,
      confidence: conf,
      fluency: fluency,
      gate: gate,
      dimensions: dims,
      features: features,
      sentences: sentences.slice(0, 4000),
      sentencesTruncated: sentences.length > 4000,
      paragraphs: paraList.slice(0, 2000),
      suspiciousParagraphs: suspiciousParagraphs,
      composition: comp,
      blocks: blockOut,
      findings: findings,
      fixes: fixes,
      summary: summary,
      warnings: S.warnings,
      elapsedMs: Math.round((t1 - t0) * 10) / 10
    };
  }

  function buildSummary(score, verdict, topDims, findings, conf, cjk) {
    var parts = [];
    parts.push('全文 ' + cjk + ' 字，判定「' + verdict.label + '」，AI 味指数 ' + score +
      '，置信度' + conf.level + '（±' + conf.margin + '）。');
    if (topDims.length && topDims[0].score >= 45) {
      parts.push('最突出的偏差在「' + topDims[0].name + '」（' + topDims[0].score + ' 分）' +
        (topDims[1] && topDims[1].score >= 45 ? '，其次是「' + topDims[1].name + '」（' + topDims[1].score + ' 分）' : '') + '。');
    }
    var hi = findings.filter(function (f) { return f.severity === 'high'; });
    if (hi.length) {
      parts.push('命中 ' + hi.length + ' 处典型模型腔，例如「' + hi[0].title.split('：')[0] + '」' +
        (hi[1] ? '、「' + hi[1].title.split('：')[0] + '」' : '') + '。');
    } else if (score >= 40) {
      parts.push('没有单项极端命中，但多项指标同时偏向模型分布。');
    } else {
      parts.push('未发现成规模的模型腔特征。');
    }
    return parts.join('');
  }

  /* ============================================================
   * 十、章节模式
   * ============================================================ */

  function splitChapters(raw) {
    var text = String(raw || '').replace(/\r\n?/g, '\n');
    var re = /(^|\n)[ \t]*(第[零〇一二三四五六七八九十百千万0-9]{1,9}[章节回卷][^\n]{0,40})/g;
    var marks = [], m;
    while ((m = re.exec(text)) !== null) {
      marks.push({ index: m.index === 0 ? 0 : m.index + 1, title: m[2].trim() });
    }
    if (marks.length < 2) {
      // 没有章节标记，按 3000 字切
      var chunks = [], size = 3000;
      for (var i = 0; i < text.length; i += size) {
        var seg = text.slice(i, i + size);
        if (seg.trim()) chunks.push({ title: '片段 ' + (chunks.length + 1), text: seg, offset: i });
      }
      return { chapters: chunks, auto: true };
    }
    var out = [];
    for (var k = 0; k < marks.length; k++) {
      var start = marks[k].index;
      var end = k + 1 < marks.length ? marks[k + 1].index : text.length;
      var body = text.slice(start, end);
      if (body.trim()) out.push({ title: marks[k].title, text: body, offset: start });
    }
    return { chapters: out, auto: false };
  }

  function analyzeChapters(raw, options) {
    var opts = options || {};
    var sp = splitChapters(raw);
    var limit = opts.maxChapters || 200;
    var list = sp.chapters.slice(0, limit);
    var results = [], totalW = 0, totalS = 0;

    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      var item = { index: i + 1, title: ch.title, chars: ch.text.replace(/\s/g, '').length };
      try {
        if (item.chars < 100) {
          item.error = '字数过少，已跳过';
          item.score = null;
        } else {
          var r = analyze(ch.text, opts);
          item.score = r.score;
          item.band = r.band.key;
          item.verdict = r.verdict.key;
          item.verdictLabel = r.verdict.label;
          item.confidence = r.confidence.level;
          item.top = (r.dimensions.filter(function (d) { return d.score !== null; })
            .sort(function (a, b) { return b.score - a.score; })[0] || {}).name;
          item.findings = r.findings.slice(0, 3).map(function (f) { return f.title.split('：')[0]; });
          totalW += item.chars;
          totalS += r.score * item.chars;
        }
      } catch (e) {
        item.score = null;
        item.error = e.message;
      }
      results.push(item);
    }

    var overall = totalW > 0 ? Math.round(totalS / totalW) : 0;
    // 三档统计
    var usable = results.filter(function (x) { return x.score !== null; });
    var highList = usable.filter(function (x) { return verdictOf(x.score).key === 'high'; });
    var susList = usable.filter(function (x) { return verdictOf(x.score).key === 'suspected'; });
    var humanList = usable.filter(function (x) { return verdictOf(x.score).key === 'human'; });

    return {
      ok: true,
      version: VERSION,
      autoSplit: sp.auto,
      chapterCount: results.length,
      analyzedCount: usable.length,
      overall: overall,
      band: bandOf(overall),
      verdict: verdictOf(overall),
      highCount: highList.length,
      suspectedCount: susList.length,
      humanCount: humanList.length,
      suspectCount: highList.length + susList.length,
      suspectRatio: round(pct(highList.length + susList.length, Math.max(usable.length, 1)) * 100, 1),
      chapters: results,
      warning: sp.auto ? '未识别到「第X章」标记，已按 3000 字切分' : null
    };
  }

  /* ============================================================
   * 十一、自检样例
   * ============================================================ */

  var FIXTURES = [
    {
      id: 'ai-sample',
      label: '典型模型腔',
      expect: 'high',
      text: '夜色如水，月光透过窗棂洒落在她的脸上，为她精致的侧脸镀上了一层柔和的光晕。她静静地坐在窗前，眼神里带着一丝说不清道不明的复杂情绪。仿佛整个世界都在这一刻安静了下来，只剩下她一个人，独自面对着心底那些无法言说的秘密。\n' +
        '她轻轻叹了口气，手指无意识地抚过桌上那本泛黄的笔记本。就在这时，门外传来一阵细微的声响。她的心猛地一紧，下意识地抬起头，望向门口的方向。那声音渐渐消失了，四周又恢复了死一般的寂静。她知道，有些事情终究是无法逃避的。\n' +
        '夜色渐深，空气中弥漫着一种莫名的压抑感。她缓缓站起身，嘴角勾起一抹苦涩的弧度。或许明天，一切都会好起来吧。可她心里清楚，这并不是结束，而是另一个开始。\n' +
        '她走到窗边，深深地吸了一口气。远处的灯火明明灭灭，仿佛在诉说着什么。她的眼底闪过一丝不易察觉的动摇，随即又恢复了平静。这一刻，时间仿佛静止了，所有的喧嚣都退到了很远的地方，只剩下她自己的心跳声，一下，又一下。\n' +
        '她想起了那个夏天，想起了那些再也回不去的日子。记忆像潮水一样涌来，将她缓缓淹没。她闭上眼睛，任由那些画面在脑海里一一闪过。曾经的欢笑，曾经的泪水，曾经的一切，都随着时间慢慢沉淀，变成了心底最柔软的角落。\n' +
        '不知过了多久，她终于转过身，回到了桌前。笔尖落在纸上，留下一行字迹。她看着那行字，久久没有言语。窗外的风轻轻吹过，带走了最后一丝温度。她知道，有些路，终究要一个人走完。'
    },
    {
      id: 'human-sample',
      label: '真人网文腔',
      expect: 'low',
      text: '楼道里的声控灯又坏了。我摸黑上了四楼，钥匙在锁孔里捅了三下才进去。\n' +
        '"操。"我把外卖扔桌上，"又他妈凉了。"\n' +
        '客厅没开灯，只有电脑屏幕亮着，幽幽一片蓝。老张还在打游戏，耳机挂在脖子上，头也不回。\n' +
        '"几点了？"\n' +
        '"十一点……你自己不会看？"\n' +
        '他没吭声，又开了局。\n' +
        '我把饭盒撕开，油味儿一下子冲上来。有点腻。可乐灌了半瓶，打了个嗝，才觉得活过来一点。\n' +
        '窗外有人在吵架，声音忽高忽低。我懒得管。这种破事一天能有三回。\n' +
        '吃到一半手机响了，屏幕上是她。\n' +
        '我盯着那名字看了很久，直到屏幕自己暗下去。\n' +
        '没接。\n' +
        '第二天早上我在公司楼下碰到老张，他手里拎着两杯豆浆，看见我就笑："昨儿那事儿，你真不打算回啦？"\n' +
        '我说："回什么啊。"\n' +
        '"人家都哭了——"他把豆浆往我手里一塞，"你他妈心是真硬。"\n' +
        '我没接话。豆浆烫手，我换了个手拿，纸杯边上一圈水汽，把手指弄湿了。\n' +
        '电梯来了，里头站着四五个人，都低头看手机。我挤在角落里，闻见一股隔夜酒味，不知道是谁的，反正不是我的。\n' +
        '到了12楼，我出来，走廊尽头的窗子开着，风把百叶帘吹得啪啪响。行政那个姑娘在跟人吵架，声音尖得刺耳："我说了多少遍了！流程走完再报销！"\n' +
        '我绕过她们，回到工位，把豆浆放下。屏幕上躺着27封未读邮件。'
    }
  ];

  function selfTest() {
    var out = [];
    for (var i = 0; i < FIXTURES.length; i++) {
      var fx = FIXTURES[i], r, err = null;
      try { r = analyze(fx.text); } catch (e) { err = e.message; }
      var pass = false;
      if (r) {
        if (fx.expect === 'high') pass = r.score >= 55;   // 至少要稳定落在「疑似」以上
        else pass = r.score < 40;                         // 必须判成「人写」
      }
      out.push({
        id: fx.id, label: fx.label, expect: fx.expect,
        score: r ? r.score : null,
        verdict: r ? r.verdict.label : null,
        band: r ? r.band.label : null,
        pass: pass, error: err
      });
    }
    return { version: VERSION, passed: out.every(function (x) { return x.pass; }), results: out };
  }

  /* ============================================================
   * 十二、导出
   * ============================================================ */

  return {
    version: VERSION,
    DIMS: DIMS,
    BANDS: BANDS,
    VERDICTS: VERDICTS,
    verdictOf: verdictOf,
    FIXTURES: FIXTURES,
    featureDefs: FEATURES.map(function (f) {
      return { id: f.id, dim: f.dim, name: f.name, unit: f.unit, dir: f.dir, w: f.w, h: f.h, a: f.a, desc: f.desc };
    }),
    FIXES: FIXES,
    analyze: analyze,
    analyzeChapters: analyzeChapters,
    splitChapters: splitChapters,
    scoreFromFeatures: scoreFromFeatures,
    selfTest: selfTest,
    bandOf: bandOf
  };
});
