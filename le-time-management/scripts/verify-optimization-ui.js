async (page) => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:1422/');
  await page.getByRole('button', { name: '设置', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('#settings-tasks > .card'));
  assert(await page.locator('.settings-section > .card').count() === 1, 'settings must initially create only selected section');
  await page.evaluate(() => { window.qaSidebar = document.querySelector('.settings-sidebar'); });
  for (const id of ['ui','theme','highlights','reminders','data','sync','ai','shortcuts','lan','plugins','cppu-login','testing','about']) {
    await page.locator('.settings-catalog button').filter({ hasText: ({ui:'界面与交互',theme:'主题',highlights:'关键词标注',reminders:'任务提醒',data:'数据中心',sync:'可选同步',ai:'AI 与自动任务',shortcuts:'全局快捷键',lan:'局域网联动',plugins:'插件管理','cppu-login':'警大登录设置',testing:'测试',about:'关于'})[id] }).click();
    await page.waitForFunction(id => document.querySelector('#settings-' + id)?.children.length > 0, id);
    assert(!await page.locator('#settings-'+id).innerText().then(t => t.includes('加载失败：')), 'section failed: ' + id);
  }
  assert(await page.evaluate(() => window.qaSidebar === document.querySelector('.settings-sidebar')), 'sidebar rebuilt on category selection');
  await page.getByRole('searchbox', { name: '搜索设置', exact: true }).fill('最长响铃');
  await page.waitForFunction(() => [...document.querySelectorAll('.settings-catalog button')].filter(x=>!x.hidden).some(x=>x.textContent.includes('任务提醒')));
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.settings-modal'));
  const identity = await page.evaluate(async () => {
    const S = await import('/src/store.js');
    const a=S.addTask({id:'qa-a',title:'unchanged',quad:1,due:'2026-10-04'});
    S.addTask({id:'qa-b',title:'changed',quad:1,due:'2026-10-05'});
    const card=document.querySelector('[data-id="qa-a"]');
    S.updateTask('qa-b',{note:'changed note'});
    const same = card === document.querySelector('[data-id="qa-a"]');
    const {renderTimeline}=await import('/src/views/timeline.js');
    const host=document.createElement('div');document.body.append(host);renderTimeline(host);
    const row=host.querySelector('[data-event="task:qa-a"]');
    S.updateTask('qa-b',{note:'another change'});
    const timelineSame=row===host.querySelector('[data-event="task:qa-a"]');
    host._unsub();host.remove();
    await S.saveNow();
    return {same,timelineSame};
  });
  assert(identity.same && identity.timelineSame, 'unchanged task/timeline nodes must be retained');
  await page.evaluate(async () => {
    const {api}=await import('/src/api.js'); const S=await import('/src/store.js');
    window.qaSave=api.saveData;api.saveData=async()=>{throw new Error('simulated disk full');};
    S.addTask({title:'save failure fixture'});await S.saveNow().catch(()=>{});
  });
  await page.getByRole('button', { name: '重试保存', exact: true }).waitFor({state:'visible'});
  assert(await page.locator('.storage-status').innerText().then(t=>t.includes('simulated disk full')), 'save error absent');
  await page.evaluate(async()=>{const {api}=await import('/src/api.js');api.saveData=window.qaSave;});
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await page.waitForFunction(()=>document.querySelector('.storage-status').dataset.phase==='saved');
  assert(!await page.getByRole('button',{name:'重试保存',exact:true}).isVisible(), 'saved state must hide retry');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button', {name:'显示或隐藏底栏',exact:true}).click();
  await page.getByRole('button', { name: '设置', exact: true }).first().click();
  await page.getByRole('searchbox', {name:'搜索设置',exact:true}).fill('');
  await page.locator('.settings-acc-head').filter({hasText:'任务提醒'}).click();
  await page.locator('#settings-reminders .card').waitFor();
  await page.screenshot({path:'output/optimization-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(()=>{localStorage.setItem('letime-data','broken original');});
  await page.reload();
  await page.getByRole('heading',{name:'数据暂时无法读取'}).waitFor();
  assert(await page.evaluate(()=>localStorage.getItem('letime-data'))==='broken original','recovery overwrote corrupt fixture');
  assert(await page.locator('.app').count()===0,'failed startup must not mount business shell');
  await page.screenshot({path:'output/optimization-recovery.png',fullPage:true});
  console.log('PASS: lazy settings/all categories/search/retained nodes/save failure-retry/mobile/recovery protection');
}
