// playwright-cli -s=ai-models run-code --filename scripts/verify-ai-models-ui.js
async (page) => {
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  await page.evaluate(async () => {
    window.aiModelTest?.cleanup();
    // Vite 热更新可能给依赖加 ?t=，必须替换设置模块实际引用的同一个 api 实例。
    const source = await (await fetch('/src/views/settings/ai.js')).text();
    const apiPath = source.match(/import\s+\{\s*api\s*\}\s+from\s+["']([^"']+)["']/)[1];
    const { api } = await import(new URL(apiPath, new URL('/src/views/settings/ai.js', location.href)).href);
    const { createAiSettingsCard } = await import('/src/views/settings/ai.js');
    const requests = [];
    const original = { status: api.aiVaultStatus, list: api.aiListModels, save: api.aiVaultSave, clear: api.aiVaultClear };
    api.aiVaultStatus = async () => ({ configured: true, baseUrl: 'https://api.openai.com/v1', model: 'chosen-model', keyMasked: 'masked' });
    api.aiListModels = (baseUrl, key, force) => new Promise((resolve, reject) => requests.push({ baseUrl, key, force, resolve, reject }));
    api.aiVaultSave = async (baseUrl, key, model) => ({ configured: true, baseUrl, model, keyMasked: 'masked' });
    api.aiVaultClear = async () => {};
    document.documentElement.dataset.uiMotion = 'full';
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:10000;overflow:auto;padding:24px;background:var(--bg)';
    host.id = 'ai-model-test-host';
    const card = await createAiSettingsCard();
    card.style.cssText = 'max-width:900px;margin:auto';
    host.append(card);
    document.body.append(host);
    window.aiModelTest = { requests, card, cleanup() {
      card._dispose(); host.remove();
      api.aiVaultStatus = original.status; api.aiListModels = original.list;
      api.aiVaultSave = original.save; api.aiVaultClear = original.clear;
    } };
  });
  await page.waitForFunction(() => window.aiModelTest.requests.length === 1);
  await page.evaluate(() => window.aiModelTest.requests[0].resolve({
    models: [{ id: 'new-model', name: '新模型' }, { id: 'chosen-model', name: '原有模型' }, { id: 'vision-model', name: '视觉模型' }],
    fetchedAt: Date.now(), cached: false,
  }));
  const card = page.locator('#ai-model-test-host .ai-settings-card');
  const model = card.getByRole('combobox', { name: '模型 ID' });
  const toggle = card.locator('.ai-model-toggle');
  const panel = card.locator('.ai-model-disclosure');
  await card.getByText('3 个可用模型', { exact: false }).waitFor();
  check(await model.inputValue() === 'chosen-model', 'refresh replaced selected model');
  check(await card.getByLabel('选择 AI 供应商').inputValue() === 'openai', 'custom model changed provider');
  await toggle.click();
  await page.waitForTimeout(100);
  const opening = await panel.evaluate(node => ({ height: node.getBoundingClientRect().height, final: node.scrollHeight, opacity: Number(getComputedStyle(node).opacity), inert: node.inert }));
  check(opening.height > 0 && opening.opacity > 0 && opening.opacity < 1 && !opening.inert, 'missing opening intermediate frame');
  await page.waitForTimeout(300);
  const fullHeight = await panel.evaluate(node => node.getBoundingClientRect().height);
  check(opening.height < fullHeight, 'opening height does not interpolate');
  await toggle.click();
  await page.waitForTimeout(100);
  const closing = await panel.evaluate(node => ({ height: node.getBoundingClientRect().height, opacity: Number(getComputedStyle(node).opacity), inert: node.inert }));
  check(closing.height > 0 && closing.height < fullHeight && closing.opacity > 0 && closing.inert, 'missing closing intermediate frame or inactive focus boundary');
  await page.waitForTimeout(300);
  check(await panel.evaluate(node => node.getBoundingClientRect().height) === 0, 'panel failed to collapse');
  // Rapid reversals continue from the current interpolated frame.
  await toggle.click();
  await page.waitForTimeout(80);
  const reversal = await panel.evaluate(node => {
    const before = node.getBoundingClientRect().height;
    node.parentElement.querySelector('.ai-model-toggle').click();
    return { before, after: node.getBoundingClientRect().height };
  });
  check(Math.abs(reversal.before - reversal.after) < 2, `rapid closing jumps: ${JSON.stringify(reversal)}`);
  await toggle.click();
  await page.waitForTimeout(370);
  await card.getByRole('searchbox').fill('视觉');
  check(await card.locator('.ai-model-options [role=option]').count() === 1, 'model search does not filter names');
  await card.getByRole('searchbox').press('ArrowDown');
  await page.keyboard.press('Enter');
  check(await model.inputValue() === 'vision-model', 'keyboard selection did not set exact ID');
  check(await model.getAttribute('aria-expanded') === 'false', 'selection does not close panel');
  await model.fill('manual-id');
  await model.press('ArrowDown');
  await page.keyboard.press('Escape');
  check(await model.inputValue() === 'manual-id' && await model.getAttribute('aria-expanded') === 'false', 'manual ID or Escape broken');
  // A reply started with old credentials must not repaint the new configuration.
  await card.getByRole('button', { name: '刷新模型', exact: true }).click();
  await page.waitForFunction(() => window.aiModelTest.requests.length === 2);
  check(await page.evaluate(() => window.aiModelTest.requests[1].force), 'manual refresh does not bypass cache');
  await card.locator('input[type=password]').fill('fixture-new-key');
  await page.waitForFunction(() => window.aiModelTest.requests.length === 3);
  await page.evaluate(() => window.aiModelTest.requests[1].resolve({ models: [{ id: 'wrong-old-reply' }], fetchedAt: Date.now() }));
  await page.waitForTimeout(50);
  check(await card.locator('[data-model-id="wrong-old-reply"]').count() === 0, 'old response leaked into new configuration');
  await page.evaluate(() => window.aiModelTest.requests[2].resolve({ models: [{ id: 'valid-new-reply', name: '新配置模型' }], fetchedAt: Date.now(), cached: false }));
  await card.getByText('1 个可用模型', { exact: false }).waitFor();
  check(await model.inputValue() === 'manual-id', 'new credentials replaced manual ID');
  await card.getByRole('button', { name: '刷新模型', exact: true }).click();
  await page.waitForFunction(() => window.aiModelTest.requests.length === 4);
  await page.evaluate(() => window.aiModelTest.requests[3].resolve({ models: [{ id: 'valid-new-reply' }], fetchedAt: Date.now() - 3600000, cached: true, warning: '接口暂时不可用' }));
  await card.getByText('保留 1 个缓存模型', { exact: false }).waitFor();
  // Provider change clears typed credentials and waits for that provider's own Key.
  await card.getByLabel('选择 AI 供应商').selectOption('deepseek');
  await page.waitForTimeout(750);
  check(await card.locator('input[type=password]').inputValue() === '', 'provider reused typed credentials');
  check(await page.evaluate(() => window.aiModelTest.requests.length) === 4, 'provider change sent old stored credentials');
  await card.getByText('请填写此供应商的 API Key', { exact: false }).waitFor();
  await card.locator('input[type=password]').fill('fixture-deepseek-key');
  await page.waitForFunction(() => window.aiModelTest.requests.length === 5);
  check(await page.evaluate(() => window.aiModelTest.requests[4].baseUrl) === 'https://api.deepseek.com', 'request used wrong provider endpoint');
  await page.evaluate(() => window.aiModelTest.requests[4].resolve({ models: [{ id: 'deepseek-new', name: '新模型' }, { id: 'deepseek-flash' }], fetchedAt: Date.now(), cached: false }));
  await card.getByText('2 个可用模型', { exact: false }).waitFor();
  // Reduced motion, dark theme and narrow viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.uiMotion = 'reduced'; document.documentElement.dataset.themeMode = 'dark'; });
  await toggle.click();
  check(await panel.evaluate(node => getComputedStyle(node).transitionDuration.split(',').every(value => parseFloat(value) <= 0.0001)), 'reduced motion still animates');
  check(await page.evaluate(() => document.querySelector('#ai-model-test-host').scrollWidth <= 390), 'narrow screen overflows');
  await card.screenshot({ path: '../output/playwright/ai-models-dark-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.uiMotion = 'full'; document.documentElement.dataset.themeMode = 'light'; });
  await card.screenshot({ path: '../output/playwright/ai-models-desktop.png' });
  await page.evaluate(() => window.aiModelTest.cleanup());
  console.log('PASS: model UI selection/search/manual IDs, keyboard/Escape, opening/closing intermediate frames, rapid reversals, reduced motion, stale-request suppression, cache warning, provider key isolation, mobile/dark layout');
}
