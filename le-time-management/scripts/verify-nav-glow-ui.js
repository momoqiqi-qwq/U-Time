async (page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const result = await page.evaluate(async () => {
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const frames = async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); };
    const root = document.documentElement;
    const glow = document.querySelector('.nav-glow');
    const click = id => document.querySelector(`.nav button[data-view="${id}"]`).click();
    const { applyUiScale } = await import('/src/uiScale.js');
    const { setThemeMode } = await import('/src/theme.js');
    const modes = [];
    root.dataset.uiMotion = 'full';
    for (const [nephele, theme, scale] of [['off', 'light', 100], ['on', 'dark', 100], ['on', 'light', 125]]) {
      root.dataset.nepheleSettings = nephele;
      setThemeMode(theme);
      applyUiScale(scale);
      await frames();
      click('plug:chaoxing-notify'); await delay(620);
      const before = glow.getBoundingClientRect().top;
      click('plug:pomodoro');
      await frames();
      const slide = glow.getAnimations().find(a => a.effect.getTiming().duration === 500);
      check(slide && slide.playState === 'running', `animation cancelled: ${nephele}/${theme}/${scale}`);
      const target = document.querySelector('.nav button[data-view="plug:pomodoro"]');
      check(Math.abs(glow.getBoundingClientRect().top - target.getBoundingClientRect().top) > 1, 'glow jumped to target');
      const moving = glow.getBoundingClientRect().top;
      click('plug:chaoxing-notify');
      check(Math.abs(glow.getBoundingClientRect().top - moving) < 2, 'rapid switch jumped');
      await frames();
      check(glow.getAnimations().some(a => a.effect.getTiming().duration === 500), 'rapid switch lost animation');
      await delay(620);
      const selected = document.querySelector('.nav button[data-view="plug:chaoxing-notify"]');
      check(Math.abs(glow.getBoundingClientRect().top - selected.getBoundingClientRect().top) < 2, 'wrong final position');
      modes.push({ nephele, theme, scale, before, moving });
    }
    root.dataset.uiMotion = 'reduced';
    click('plug:pomodoro'); await frames();
    check(!glow.getAnimations().some(a => a.effect.getTiming().duration === 500), 'reduced motion still slides');
    const selected = document.querySelector('.nav button[data-view="plug:pomodoro"]');
    check(Math.abs(glow.getBoundingClientRect().top - selected.getBoundingClientRect().top) < 2, 'reduced motion misaligned');
    applyUiScale(100); root.dataset.uiMotion = 'full';
    return modes;
  });
  await page.evaluate(result => { window.navGlowVerification = result; }, result);
}
