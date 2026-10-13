/**
 * cppu-notify（警大门户通知）演示图样例数据 —— 只用于出界面演示图，不进产品运行时。
 *
 * 数据全是**编的**：人名、成绩、单位、时间都是假的，不来自任何真实门户。
 * 真名单只在登录后的通知正文里，这里给的是「像真通知那样写」的样例：
 * 级别行、名单行、级别与名单同行、团体带成员、指导教师行、以及两种不该被收的干扰通知。
 *
 * 用法（技能 harness 与本项目 tools/shot-views.mjs 吃同一份）：
 *   node <harness>/plugin-preview.mjs --plugin cppu-notify --view cppu-award \
 *     --fixture tools/shots/fixtures/cppu-notify.mjs \
 *     --modules "/plugins/cppu-notify/award-list.js=<绝对路径>/award-list.js"
 */

// 北京时间 → 毫秒时间戳（门户给的是 UTC 毫秒）
const CN = (y, m, d, hh = 9, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm, 0);

const BODIES = {
  N2025112001: `
<p>各学院、各有关单位：</p>
<p>2025年全国大学生数学建模竞赛已于近日结束。我校共组织12支代表队参赛，现将获奖名单公布如下：</p>
<p>一、国家级一等奖</p>
<p>张明、李思远、王浩然</p>
<p>二、国家级二等奖</p>
<p>赵一凡、陈子航、周雨欣</p>
<p>三、省级一等奖</p>
<p>孙博文、吴嘉怡、郑昊然</p>
<p>指导教师：刘建国、马晓东</p>
<p>特此通知。</p>`,
  N2025101801: `
<p>各学院：</p>
<p>学校2025年田径运动会已圆满结束。经组委会评定，现将获奖集体和个人名单公布如下：</p>
<p>一、团体总分一等奖</p>
<p>刑事侦查学院代表队、治安学院代表队</p>
<p>二、团体总分二等奖</p>
<p>消防指挥学院代表队</p>
<p>男子100米第一名：李鹏飞</p>
<p>女子800米第一名：张雨桐</p>
<p>男子跳远第一名：王振宇</p>
<p>优秀组织奖：侦查学院、警务指挥学院</p>
<p>特此决定。</p>`,
  N2025092801: `
<p>各学院：</p>
<p>2025年中国国际大学生创新大赛全国总决赛于9月落下帷幕，我校代表队表现优异，共获金奖1项、银奖2项。</p>
<p>金奖：智侦先锋团队（成员：陈浩、林晓雨、赵鹏）</p>
<p>银奖：火眼金睛团队（成员：孙一鸣、周思远）</p>
<p>银奖：慧眼识踪团队（成员：吴天成、郑晓、黄琪）</p>
<p>最佳创意奖：张明</p>
<p>指导教师：李国强、王敏</p>
<p>特此通报。</p>`,
  N2025063001: `
<p>各学院：</p>
<p>经学院推荐、学校评审，现将2024—2025学年优秀学生和先进集体名单公布如下：</p>
<p>一、优秀学生（三好学生）</p>
<p>王欣然、刘子豪、陈思远、杨雨萱、黄志远</p>
<p>二、先进班集体</p>
<p>星火团支部、治安学专业代表队</p>
<p>特此决定。</p>`,
  // 下面两条是**不该被收**的干扰项：一条标题像通知但正文没有名单，
  // 一条正文提到成绩但标题不含获奖词。演示图里它们不会出现在名单上。
  N2025091401: `
<p>各教学单位：</p>
<p>为规范教学秩序，定于第4—6周开展期中教学检查，请各学院按附件要求报送材料。</p>
<p>特此通知。</p>`,
  N2025082001: `
<p>8月20日，河北省大学生演讲比赛决赛结束，我校选手发挥稳定，取得较好成绩。</p>`,
};

const NOTICES = [
  { id: "N2025112001", title: "关于公布2025年全国大学生数学建模竞赛我校获奖名单的通知", at: CN(2025, 11, 20), by: "教务处" },
  { id: "N2025101801", title: "关于表彰2025年学校田径运动会获奖集体和个人的决定", at: CN(2025, 10, 18), by: "体育工作部" },
  { id: "N2025092801", title: "关于我校学生在2025年中国国际大学生创新大赛中荣获佳绩的通报", at: CN(2025, 9, 28), by: "创新创业学院" },
  { id: "N2025091401", title: "关于开展2025年秋季学期期中教学检查的通知", at: CN(2025, 9, 14), by: "教务处" },
  { id: "N2025082001", title: "我校学子在河北省大学生演讲比赛中取得佳绩", at: CN(2025, 8, 20), by: "团委" },
  { id: "N2025063001", title: "关于表彰2024—2025学年优秀学生和先进集体的决定", at: CN(2025, 6, 30), by: "学生工作处" },
];

const row = (o) => ({
  RESOURCE_ID: o.id,
  PIM_TITLE: o.title,
  CREATE_TIME: o.at,
  IS_TOP: "0",
  IS_READ: "1",
  CREATE_USER_NAME: o.by,
  BELONG_UNIT_NAME: o.by,
  TYPE_NAME: "通知",
});

const reply = (data) => ({ status: 200, body: JSON.stringify(data), finalUrl: "", cookies: [] });

export default function fixture(state, tide) {
  // 已登录：直接给 token，跳过登录链路（演示图看的是名单，不是登录页）
  state.token = "DEMO-TOKEN";
  state.username = "2025DEMO001";
  state.sid = "demo";
  state.hasMore = false;
  // 演示图要看到「校园服务」侧栏：默认收起态（.pp-shell.side-collapsed）侧栏宽 0，
  // 截出来会以为界面缺了一块
  state.sideOpen = true;
  state.notices = NOTICES.map(row);

  // 门户接口：列表 / 详情 / 附件三支，按真实调用的 url 后缀分派
  const debug = !!process.env.SHOT_DEBUG;
  tide.http.fetch = async (_sid, _method, url, opts = {}) => {
    let body = {};
    try { body = opts?.body ? JSON.parse(opts.body) : {}; } catch { body = {}; }
    if (String(url).endsWith("getAllPimList")) {
      if (debug) console.log(`[fixture] list page=${body.pageNum} → ${Number(body.pageNum) === 1 ? state.notices.length : 0} 条`);
      return reply({ list: Number(body.pageNum) === 1 ? state.notices : [] });
    }
    if (String(url).endsWith("getPimDetailInfoById")) {
      const hit = state.notices.find((x) => x.RESOURCE_ID === body.RESOURCE_ID);
      const html = (hit && BODIES[hit.RESOURCE_ID]) || "";
      if (debug) console.log(`[fixture] detail ${body.RESOURCE_ID} hit=${!!hit} html=${html.length}`);
      return reply(hit ? [{ RESOURCE_ID: hit.RESOURCE_ID, PIM_TITLE: hit.PIM_TITLE, PIM_CONTENT: html }] : []);
    }
    if (String(url).endsWith("getPimAffixList")) return reply([]);
    return reply({});
  };

  // 视图偏好：默认让演示图落在「奖项项目 · 最新在前」这一屏；出排名图时用环境变量切换
  // （SHOT_AWARD_MODE=rank SHOT_AWARD_KIND=person|team SHOT_AWARD_ORDER=desc|asc）
  const pref = {
    mode: process.env.SHOT_AWARD_MODE || "items",
    order: process.env.SHOT_AWARD_ORDER || "desc",
    kind: process.env.SHOT_AWARD_KIND || "person",
  };
  tide.storage.get = async (key, dflt = null) =>
    (key === "awardViewPreferences" ? pref : dflt);

  return [];   // 不要 tab 视图：交给 --view 走逐视图渲染
}

export { NOTICES, BODIES, row, reply };
