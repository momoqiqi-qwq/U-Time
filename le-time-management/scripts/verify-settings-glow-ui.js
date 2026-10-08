async (page) => {
  const result = await page.evaluate(async () => {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const frame = () => new Promise(requestAnimationFrame);
    const until = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await wait(10);
      }
      throw new Error("settings content did not update");
    };
    const slide = glow => glow.getAnimations().find(animation => animation.effect.getTiming().duration === 500);
    const tab = label => [...document.querySelectorAll('.settings-catalog .settings-nav-item')]
      .find(button => button.textContent.includes(label));
    const catalog = document.querySelector('.settings-catalog');
    check(catalog, 'settings catalog missing');
    const navGlow = catalog.querySelector('.selection-glow');
    check(navGlow?.classList.contains('on'), 'settings catalog glow missing');
    document.documentElement.dataset.uiMotion = 'full';

    tab('任务提醒').click();
    await frame();
    check(slide(navGlow)?.playState === 'running', 'settings category does not slide');
    const moving = navGlow.getBoundingClientRect().left;
    tab('任务与排程').click();
    check(Math.abs(navGlow.getBoundingClientRect().left - moving) < 2, 'rapid category switch jumps');
    await wait(550);
    check(Math.abs(navGlow.getBoundingClientRect().left - tab('任务与排程').getBoundingClientRect().left) < 2,
      'settings category stops at the wrong tab');

    tab('界面与交互').click();
    await until(() => document.querySelector('.pref-choice[aria-label="界面密度"]'));
    const oldGroup = document.querySelector('.pref-choice[aria-label="界面密度"]');
    const next = [...oldGroup.querySelectorAll('.pref-choice-btn')].find(button => !button.classList.contains('on'));
    next.click();
    await until(() => {
      const group = document.querySelector('.pref-choice[aria-label="界面密度"]');
      return group && group !== oldGroup && group.querySelector('.pref-choice-btn.on')?.textContent === next.textContent;
    });
    await frame();
    const densityGlow = document.querySelector('.pref-choice[aria-label="界面密度"] .selection-glow');
    check(slide(densityGlow)?.playState === 'running', 'rebuilt interface choice does not slide');

    tab('主题').click();
    await until(() => document.querySelector('.theme-mode .selection-glow.on'));
    const mode = document.querySelector('.theme-mode');
    [...mode.querySelectorAll('.theme-mode-btn')].find(button => !button.classList.contains('on')).click();
    await frame();
    check(slide(mode.querySelector('.selection-glow'))?.playState === 'running', 'display mode does not slide');

    const grid = document.querySelector('.theme-grid');
    [...grid.querySelectorAll('.theme-card')].find(button => !button.classList.contains('on')).click();
    await frame();
    check(slide(grid.querySelector('.selection-glow'))?.playState === 'running', 'theme card focus does not slide');

    document.documentElement.dataset.uiMotion = 'reduced';
    tab('任务与排程').click();
    await frame();
    check(!slide(navGlow), 'reduced motion still slides');
    document.documentElement.dataset.uiMotion = 'full';
    return { catalog: 'sliding', rebuiltChoice: 'sliding', mode: 'sliding', theme: 'sliding', reduced: 'immediate' };
  });
  await page.evaluate(value => { window.settingsGlowVerification = value; }, result);
}
