// 验证公测身份下哪些页签被置灰
const shot = require('/opt/bs/server/shot.js');
const fs = require('fs');

;(async () => {
  const cfg = { width: 1280, height: 860, timeoutMs: 60000 };

  await shot.withPage(cfg, async (page) => {
    await page.goto('https://qsclh.cn/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1500));   // 等 /api/v1/me 回来并应用身份

    const tabs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('nav button[data-tab]')).map(b => ({
        tab: b.dataset.tab,
        text: b.innerText.trim(),
        hidden: b.hidden || b.style.display === 'none',
        locked: b.classList.contains('tab-locked'),
        disabled: b.disabled,
        opacity: getComputedStyle(b).opacity,
        title: b.title || ''
      }));
    });

    console.log('=== 公测身份下的导航栏 ===');
    tabs.forEach(t => {
      console.log('  ' + t.text.padEnd(6) +
        ' 隐藏=' + (t.hidden ? '是' : '否') +
        ' 置灰=' + (t.locked ? '是' : '否') +
        ' disabled=' + (t.disabled ? '是' : '否') +
        ' 透明度=' + t.opacity +
        (t.title ? '  提示="' + t.title.slice(0, 30) + '"' : ''));
    });

    // 点一个被锁的页签，看是否真的不切换
    console.log('\n=== 试点被锁的「批量」 ===');
    const before = await page.evaluate(() => document.querySelector('section.view.active').id);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('nav button[data-tab]')).find(x => x.dataset.tab === 'batch');
      if (b) b.click();
    });
    await new Promise(r => setTimeout(r, 600));
    const after = await page.evaluate(() => document.querySelector('section.view.active').id);
    console.log('  点击前:', before, '→ 点击后:', after, before === after ? '✓ 没切走' : '✗ 切走了');

    // 点「检测」「API」「说明」应该正常
    for (const t of ['api', 'about', 'detect']) {
      await page.click('nav button[data-tab="' + t + '"]');
      await new Promise(r => setTimeout(r, 400));
      const cur = await page.evaluate(() => document.querySelector('section.view.active').id);
      console.log('  点「' + t + '」→', cur, cur === 'view-' + t ? '✓' : '✗');
    }

    const png = await page.screenshot({ type: 'png' });
    fs.writeFileSync('/tmp/tabs_gray.png', png);
    console.log('\n  截图 /tmp/tabs_gray.png');
  });

  await shot.shutdown();
})();
