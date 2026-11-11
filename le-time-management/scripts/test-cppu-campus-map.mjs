import assert from 'node:assert/strict';
import fs from 'node:fs';
import { amapMarkerUrl, campusMapNodes, campusMapSvg } from '../public/plugins/cppu-notify/campus-map.js';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const moduleText = read('public/plugins/cppu-notify/campus-map.js');
const portal = read('public/plugins/cppu-notify/main.js');
const sprite = read('public/icons/fontawesome/solid.svg');

/* 点位数据来自 cppu-helper 的 Rooms.java：7 栋楼 + 13 个地标。
   其中「7号楼」与「7号宿舍楼」经纬度完全相同，合并成一个节点 —— 所以是 19 不是 20。 */
const nodes = campusMapNodes();
assert.equal(nodes.length, 19, '19 个点位（7 楼 + 13 地标，7 号楼与 7 号宿舍楼合并）');
assert.equal(new Set(nodes.map((n) => n.id)).size, 19, '节点 id 唯一');

for (const n of nodes) {
  assert.ok(n.big && typeof n.big === 'string', n.id + ' 有大字名');
  assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), n.id + ' 投影后坐标是数字');
  assert.ok(!/NaN|undefined|null/.test(n.x + ',' + n.y), n.id + ' 坐标干净');
  assert.ok(['teach', 'dorm', 'food', 'office', 'service', 'gate'].includes(n.kind), n.id + ' 类别在册');
  assert.ok(n.x >= 0 && n.x <= 1192 && n.y >= 0 && n.y <= 1660, n.id + ' 落在外接框内');
}

/* 「把楼的名字加大」是这个视图的原始需求：楼名字号必须显著大于旧 marker title 的 12sp，
   而且得是 SVG 里可调的 font-size 属性（osmdroid 那套写死在 12sp，改不动才要重画）。 */
const svg = campusMapSvg();
const bigSizes = [...svg.matchAll(/class="cp-big"[^>]*font-size="(\d+)"/g)].map((m) => Number(m[1]));
assert.ok(bigSizes.length >= nodes.length, '每栋楼至少一行大字（窄楼折两行，所以可能是 21 行）');
assert.equal((svg.match(/data-cp-id=/g) || []).length, nodes.length, '一行大字都没漏的楼才配齐节点');
assert.ok(Math.min(...bigSizes) >= 15, '最小楼名字号 15（窄楼按宽度反算，仍高于旧实现 12sp）');
assert.ok(Math.max(...bigSizes) >= 28, '主楼名字号 28+');
/* 字号必须跟着楼的宽度走：任何一行大字的估算宽度都不能超出它自己的矩形（否则压到邻居）。 */
for (const n of nodes) {
  const fs = Math.min(28, Math.floor((n.w - 12) / Math.max(1, [...(n.big2 ? (n.big2.length > n.big.length ? n.big2 : n.big) : n.big)].length)));
  assert.ok(fs * Math.max([...n.big].length, n.big2 ? [...n.big2].length : 0) <= n.w, n.id + ' 的文字放得进矩形');
}
const allSizes = [...svg.matchAll(/font-size="(\d+)"/g)].map((m) => Number(m[1]));
assert.ok(!bigSizes.includes(12), '大字不再是 12 号（旧 marker title 就是 12sp）');
assert.ok(Math.min(...allSizes) >= 12, '连副标题都保持 12 以上');
assert.equal((svg.match(/class="cp-node"/g) || []).length, 19, '19 个可点节点');
assert.ok(svg.includes('viewBox="0 0 1192 1660"'), '视口按校区外接框等比（1 unit ≈ 0.4965 m）');
assert.ok(svg.includes('西昌路') && svg.includes('恒康道'), '两条临街路画出来了，东门/南门才有参照');
assert.ok(svg.includes('role="button"') && svg.includes('tabindex="0"'), '节点可聚焦，键盘能到');
assert.ok(/aria-label="[^"]+"/.test(svg), '节点带可读标签');

/* 搜索口径（铁律十）：三个字段逐个比，不做 join(' ') —— 否则两个字段会被拼出假命中。 */
const code = moduleText.replace(/\/\*[\s\S]*?\*\//g, '');   // 注释里举例说明「不要 join」的那句不算
assert.ok(!/join\(['"] ['"]\)/.test(code) && !/fields\.join\(/.test(code), '搜索不把字段 join 成一个串');
assert.ok(moduleText.includes('initialHit('), '拉丁输入走拼音首字母 / 跳字简写');
assert.ok(/return\s+fields\.some/.test(moduleText), '逐字段匹配');

/* 高德深链：position 必须是 GCJ-02（Rooms.java 存的是 WGS-84 原始值）。 */
const campus = amapMarkerUrl(nodes.find((n) => n.id === 'a'));
const [, lon, lat] = campus.match(/position=([\d.]+),([\d.]+)/);
const wgs = nodes.find((n) => n.id === 'a');
assert.ok(campus.startsWith('https://uri.amap.com/marker?'), 'uri.amap.com/marker 深链');
assert.ok(campus.includes('coordinate=gaode') && campus.includes('callnative=1'), '声明 GCJ-02，手机上拉起 App');
assert.ok(Number(lon) - wgs.lon > 0.0010 && Number(lon) - wgs.lon < 0.0018, '经度东移 ≈ +0.00136（117 m）');
assert.ok(Number(lat) - wgs.lat > 0.0040 && Number(lat) - wgs.lat < 0.0050, '纬度北移 ≈ +0.00453（502 m）');
assert.equal(amapMarkerUrl(null), '', '没有节点就不给链接');

/* 展开/收起：grid-template-rows 0fr → 1fr（铁律七，内容不 display:none 一把切掉）。 */
assert.ok(/grid-template-rows:0fr/.test(moduleText) && /\.cp-detail\.open\{grid-template-rows:1fr\}/.test(moduleText), '详情有双向过渡');
assert.ok(/prefers-reduced-motion/.test(moduleText), '减少动效时不做过渡');
assert.ok(/selection-glow/.test(moduleText), '类别切换用宿主的滑动选中光（铁律六）');
assert.ok(/data-theme-mode="dark"/.test(moduleText), '深色走 data-theme-mode，不靠主题名');

/* 注册与图标：cppu-map 只注册一次，图标在 sprite 里存在且此前没被别的视图占用。 */
const registers = portal.match(/registerView\(\{[^}]*id:\s*"cppu-map"/g) || [];
assert.equal(registers.length, 1, 'cppu-map 只注册一次');
assert.ok(/id:\s*"cppu-map",\s*title:\s*"校园地图",\s*icon:\s*"map-location-dot"/.test(portal), '标题与图标连在一起写');
assert.ok(sprite.includes('id="map-location-dot"'), 'sprite 里有 map-location-dot');
const otherViews = [...portal.matchAll(/registerView\(\{\s*id:\s*"([a-z0-9-]+)"[^}]*icon:\s*['"]([a-z0-9-]+)['"]/g)];
assert.equal(otherViews.filter((m) => m[2] === 'map-location-dot').length, 1, '侧栏里没有第二个视图用这个图标');
assert.ok(portal.includes('mod.createCampusMapView(tide, mapBridge)'), '走懒加载并缓存实例');
assert.ok(/openRoom\(bld\)[\s\S]{0,160}jwState\.roomBld = bld/.test(portal), '跳自习室时先写楼名过滤再 navigate');

console.log('test-cppu-campus-map: 19 点位 / 楼名字号 / 搜索口径 / GCJ-02 深链 / 展开收起 / 注册 全部通过');
