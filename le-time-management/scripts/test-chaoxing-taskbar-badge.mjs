import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/plugins/chaoxing-notify/main.js', import.meta.url), 'utf8');
const fixture = (id, workId, body = '结束时间：2099-01-01 09:00') => ({
  id, title: '作业：测试', body, insertTime: Date.now(),
  raw: { rtf_content: `<iframe name="${Buffer.from(encodeURIComponent(JSON.stringify({att_web:{examOrWorkId:workId,url:`https://mooc1.chaoxing.com/work?id=${workId}`}}))).toString('base64')}">` },
});
const rows = [fixture('a',1), fixture('a-dup',1), fixture('late',2,'结束时间：2001-01-01 09:00'), fixture('submitted',3), fixture('nodue',4,''), fixture('ignored',5), {...fixture('exam',6),title:'考试：测试'}, {...fixture('old',7,''),insertTime:Date.now()-90*86400000}];
async function harness(supported=true) {
  const storage={inboxCache:rows, workStatus:{3:'grading'}, ignoredIds:['ignored']};
  const badges=[], timers=[], removed=[];
  let dispose;
  const tide={
    ui:{registerView(){},taskbarBadgeSupported:async()=>supported,setTaskbarBadge:async n=>{badges.push(n);return supported;},onDispose:fn=>dispose=fn},
    storage:{get:async(k,f)=>storage[k]??f,set:async(k,v)=>storage[k]=v},
  };
  const ctx=vm.createContext({tide,console,URL,atob,setInterval:(fn,ms)=>{timers.push({fn,ms});return 42;},clearInterval:id=>removed.push(id)});
  vm.runInContext(source.replace('  tide.ui.registerView({','  globalThis.test = {state,unfinishedHomework,syncTaskbarBadge,setTaskbarBadgeEnabled,probeWorkStatus};\n  tide.ui.registerView({'),ctx);
  await new Promise(resolve => setImmediate(resolve));
  return {storage,badges,timers,removed,dispose,tide, ...ctx.test};
}
const h=await harness();
assert.equal(h.unfinishedHomework().length,3,'未提交含逾期与近期无截止作业；排除已提交、考试、已移除、历史无截止作业并去重');
assert.equal(h.badges.at(-1),3,'无需打开插件即恢复缓存角标');
assert.equal(h.timers[0].ms,300000);
await h.setTaskbarBadgeEnabled(false);
assert.equal(h.storage.taskbarBadge,false);
assert.equal(h.badges.at(-1),0);
await h.setTaskbarBadgeEnabled(true);
assert.equal(h.badges.at(-1),3);
h.state.workStatus[1]='unsent';
h.tide.http={session:async()=> 'session',fetch:async()=>({body:'<title>查看详情</title>',cookies:[]})};
await h.probeWorkStatus(rows[0]);
await h.syncTaskbarBadge();
assert.equal(h.badges.at(-1),2,'已提交后数量减少，重复通知一起排除');
h.state.ignoredIds.add('nodue');await h.syncTaskbarBadge();assert.equal(h.badges.at(-1),1);
h.state.inbox=[];await h.syncTaskbarBadge();assert.equal(h.badges.at(-1),0);
h.dispose();assert.deepEqual(h.removed,[42]);
const n=h.badges.length;await h.syncTaskbarBadge();assert.equal(h.badges.length,n,'停用后异步更新不恢复旧角标');
const android=await harness(false);assert.equal(android.timers.length,0,'非 Windows 不启动后台同步');
console.log('PASS: 学习通角标计数、缓存启动、开关持久化、提交复查、移除、零值、停用清理及非 Windows 降级');
