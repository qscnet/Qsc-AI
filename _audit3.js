// 逐个点页签和按钮，看哪些功能实际没反应
const shot = require('/opt/bs/server/shot.js');

const TABS = ['chapters', 'batch', 'compare', 'api', 'about'];

;(async () => {
  const cfg = { width: 1280, height: 900, timeoutMs: 60000 };

  await shot.withPage(cfg, async (page) => {
    const errors = [];
    page.on('pageerror', e => errors.push('JS 异常: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 100)); });

    await page.goto('https://qsclh.cn/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1000));

    console.log('=== 逐个页签 ===');
    for (const t of TABS) {
      errors.length = 0;
      await page.click('button[data-tab="' + t + '"]').catch(e => console.log('  点不到 ' + t));
      await new Promise(r => setTimeout(r, 600));
      const st = await page.evaluate((tab) => {
        const v = document.getElementById('view-' + tab);
        if (!v) return { active: false, missing: true };
        const r = v.getBoundingClientRect();
        const btn = v.querySelector('button:not([disabled])');
        return {
          active: v.classList.contains('active'),
          textLen: v.innerText.replace(/\s+/g, ' ').trim().length,
          visible: r.height > 0,
          firstBtn: btn ? btn.innerText.trim().slice(0, 14) : '(无可用按钮)',
          firstBtnId: btn ? (btn.id || '') : ''
        };
      }, t);
      console.log('  ' + t.padEnd(10) +
        ' 激活=' + (st.active ? '是' : '否') +
        ' 可见=' + (st.visible ? '是' : '否') +
        ' 文字=' + st.textLen +
        ' 首个按钮=' + st.firstBtn);
      if (errors.length) console.log('      ⚠ ' + errors.slice(0, 2).join(' | '));
    }

    // 回到检测页，测「下载报告」
    console.log('\n=== 检测页：下载报告 ===');
    await page.click('button[data-tab="detect"]');
    await new Promise(r => setTimeout(r, 500));

    // 先把报告渲染出来
    await page.type('#input', '杨蕴瑶走进教室的时候，天还没亮。她把包往讲台上一放，粉笔灰腾起来，在晨光里飘成一条线。窗外有鸟叫，很短，一声就没了。');
    await page.click('#btn-detect');
    await page.waitForFunction(() => {
      const el = document.getElementById('result-body');
      return el && el.innerHTML.length > 500;
    }, { timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    const acts = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#result-body [data-act]').forEach(b => {
        const r = b.getBoundingClientRect();
        out.push({
          act: b.dataset.act,
          text: (b.innerText || b.title || '').trim().slice(0, 16),
          visible: r.width > 0 && r.height > 0,
          disabled: b.disabled
        });
      });
      return out;
    });
    console.log('  结果区的按钮:');
    acts.forEach(a => console.log('    ' + a.act.padEnd(10) + ' 文字="' + a.text + '" 可见=' + (a.visible ? '是' : '否') + ' 禁用=' + (a.disabled ? '是' : '否')));

    // 点下载报告看有没有反应
    errors.length = 0;
    const before = await page.evaluate(() => window.__popupTried || 0);
    await page.evaluate(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
    const clicked = await page.evaluate(() => {
      const b = document.querySelector('#result-body [data-act="report"]');
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    });
    await new Promise(r => setTimeout(r, 1200));
    const printed = await page.evaluate(() => window.__printed || 0);
    console.log('  点下载报告:', clicked, '| print() 调用次数:', printed, '| 新窗口数:', (await page.browser().pages()).length);
    if (errors.length) console.log('  ⚠ ' + errors.slice(0, 3).join(' | '));
  });

  await shot.shutdown();
})();
