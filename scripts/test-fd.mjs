/**
 * 定期存款追蹤器（fd/）回歸測試
 *
 * 用法：
 *   python3 -m http.server 8099 --directory fd &
 *   node scripts/test-fd.mjs
 *
 * 需要 Playwright（npx playwright install chromium，或用系統已裝嘅版本）。
 * 以 PW 環境變數指定 playwright 路徑，預設用 /opt/node22 嗰個。
 */
const PW = process.env.PW || '/opt/node22/lib/node_modules/playwright/index.mjs';
const BASE = process.env.BASE || 'http://localhost:8099/index.html';
const { chromium } = await import(PW);

const fail = [];
let group = '';
const G = (n) => { group = n; console.log('\n【' + n + '】'); };
const eq = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fail.push(`[${group}] ${name}\n      got:  ${got}\n      want: ${want}`);
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + ' → ' + got);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
const errors = [];
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
await p.goto(BASE, { waitUntil: 'networkidle' });

// ── 小工具 ──
const card = (t) => p.locator('.card', { hasText: t }).first();
const txt = async (loc) => (await loc.count()) ? (await loc.first().textContent()).trim() : null;
async function openCard(t) {
  const c = card(t);
  if (!(await c.locator('.c-body').isVisible())) {
    await c.locator('.c-head').click();
    await p.waitForTimeout(150);
  }
  return c;
}
async function seed(list, rate = '7.8') {
  await p.evaluate(([l, r]) => {
    localStorage.setItem('fd.rate.v1', r);
    localStorage.setItem('fd.deposits.v1', JSON.stringify(l));
  }, [list, rate]);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(150);
}
const dep = (o) => Object.assign({
  id: 'x' + Math.random().toString(36).slice(2, 7), bank: '銀行', amount: 10000, currency: 'USD',
  maturity: '2027-01-01', start: '2026-01-01', durNum: 12, durUnit: 'month',
  rate: 4, basis: 360, interest: '', status: '', note: ''
}, o);

// ══════════════════════════════════════════════
G('利息計算');
// 2026-01-01 → 2027-01-01 = 365 日
await seed([dep({ id: 'a', bank: 'A365', rate: 4.5, basis: 365 })]);
eq('365 基礎：10000 × 4.5% × 365/365', await txt(card('A365').locator('.int b')), '+ USD 450.00');
eq('計息標籤', await txt(card('A365').locator('.int .tag')), '365 日 ÷ 365');

await seed([dep({ id: 'b', bank: 'B360', amount: 100000, currency: 'HKD', rate: 3, basis: 360,
                  start: '2026-01-01', maturity: '2026-06-30', durNum: 6 })]);
eq('360 基礎：100000 × 3% × 180/360', await txt(card('B360').locator('.int b')), '+ HKD 1,500.00');
eq('港元卡唔會重複換算', await card('B360').locator('.int small').count(), '0');

await seed([dep({ id: 'c', bank: 'C推算', amount: 20000, rate: 5, basis: 365, start: '', durNum: 12 })]);
eq('無開始日期時由存期倒推', await txt(card('C推算').locator('.int b')), '+ USD 1,000.00');

await seed([dep({ id: 'd', bank: 'D手動', amount: 50000, rate: 4, interest: 888 })]);
eq('手動利息覆寫年利率', await txt(card('D手動').locator('.int b')), '+ USD 888.00');
eq('標示為手動輸入', await txt(card('D手動').locator('.int .tag')), '手動輸入');

await seed([dep({ id: 'e', bank: 'E缺料', amount: 1000, rate: 4, start: '', durNum: '' })]);
eq('資料不足時講明原因', await txt(card('E缺料').locator('.int.missing')),
   '預期利息—未填開始存款日期或存款期限，無法計算存期');
eq('唔會扮有利息', await card('E缺料').locator('.int:not(.missing)').count(), '0');

// ══════════════════════════════════════════════
G('對真實銀行存單核對');
// 本金 33,359.63 USD、3.20%、2025-12-16 → 2026-12-16（365 日）、360 日基礎
await seed([dep({ id: 'r', bank: '實單', amount: 33359.63, rate: 3.2, basis: 360,
                  start: '2025-12-16', maturity: '2026-12-16' })]);
eq('到期利息 = 銀行 1,082.33', await txt(card('實單').locator('.int b')), '+ USD 1,082.33');
eq('本金完整顯示斗零（唔四捨五入）', await txt(card('實單').locator('.amt')), '33,359.63 USD');
const meta = await openCard('實單').then(c => c.locator('.meta').innerText());
eq('到期本利和 = 銀行 34,441.96', /到期本利和：(.+)/.exec(meta)[1].trim(), 'USD 34,441.96');

// ══════════════════════════════════════════════
G('年化統計');
await seed([
  dep({ id: 's1', bank: '短期', amount: 10000, rate: 4, basis: 360, start: '2026-06-01', maturity: '2026-09-01', durNum: 3 }),
  dep({ id: 's2', bank: '長期', amount: 10000, rate: 4, basis: 360, start: '2026-01-01', maturity: '2027-01-01', durNum: 12 }),
]);
// 年化 = (10000+10000)×7.8×4% = 6,240
eq('年化利息收入', await txt(p.locator('#annualInterest')), '+ HK$ 6,240');
eq('加權平均年利率', await txt(p.locator('#avgRate')), '4.00%');
const termTotal = Number((await p.textContent('#totalInterest')).replace(/[^0-9]/g, ''));
eq('年化 > 到期利息合計（短期被存期攤薄）', 6240 > termTotal, 'true');

// ══════════════════════════════════════════════
G('到期處理（結算）');
// 已到期：本金 20000 USD、4.5%、360 制、2025-09-10 → 2026-09-10（365 日）
// 利息 = 20000 × 4.5% × 365/360 = 912.50 → 本利和 20,912.50
const matured = dep({ id: 'M', bank: '恒生銀行', amount: 20000, rate: 4.5, basis: 360,
                      start: '2025-09-10', maturity: '2026-09-10', durNum: '', note: '年息4.5厘' });
await seed([matured, dep({ id: 'F', bank: '未到期行', amount: 30000 })]);
eq('總資產含兩筆', await txt(p.locator('#totalHkd')), 'HK$ 390,000');
let c = await openCard('恒生銀行');
eq('已到期先有「到期處理」', await c.locator('[data-settle]').count(), '1');
eq('未到期冇', await card('未到期行').locator('[data-settle]').count(), '0');

await c.locator('[data-settle]').click(); await p.waitForTimeout(300);
eq('實收預填本利和', await p.inputValue('#s_actual'), '20912.5');
eq('即時算出已實現利息', /已實現利息：USD 912.50/.test(await p.textContent('#s_realized')), 'true');
await p.fill('#s_actual', '19000'); await p.waitForTimeout(200);
eq('實收少於本金會警告', /虧損 USD 1,000.00/.test(await p.textContent('#s_realized')), 'true');
await p.fill('#s_actual', '20912.5'); await p.waitForTimeout(200);

await p.check('input[name="sk"][value="principal"]'); await p.waitForTimeout(200);
await p.click('#settleGo'); await p.waitForTimeout(400);
eq('帶去續存表單', (await p.textContent('#sheetTitle')).trim(), '續存（來自「恒生銀行」）');
eq('續存金額 = 本金', await p.inputValue('#f_amount'), '20000');
eq('開始日 = 舊到期日', await p.inputValue('#f_start'), '2026-09-10');
eq('原本冇填存期都推算得返', await p.inputValue('#f_durNum'), '12');
eq('新到期日自動計', await p.inputValue('#f_maturity'), '2027-09-10');
eq('備註跟住過去', await p.inputValue('#f_note'), '年息4.5厘');
await p.click('#sheet .save'); await p.waitForTimeout(400);

const recs = await p.evaluate(() => JSON.parse(localStorage.getItem('fd.deposits.v1')));
const oldR = recs.find(r => r.id === 'M'), newR = recs.find(r => r.fromId === 'M');
eq('舊筆標記已處理', oldR.status, 'done');
eq('分類為部分提取', oldR.doneKind, 'partial');
eq('記低實收本利和', oldR.actualTotal, '20912.5');
eq('記低已實現利息', oldR.realizedInterest, '912.5');
eq('記低提取金額', oldR.withdrawn, '912.5');
eq('舊筆指向新筆', oldR.rolledToId, newR.id);
eq('新筆指返舊筆', newR.fromId, 'M');

c = await openCard('未到期行');   // 先避開同名
await p.click('.chip[data-f="done"]'); await p.waitForTimeout(250);
c = await openCard('恒生銀行');
const dm = await c.locator('.meta').innerText();
eq('續存鏈：→ 續存至', /→ 續存至：恒生銀行（2027-09-10）/.test(dm), 'true');
eq('顯示實收同提取', /實收本利和：USD 20,912.50/.test(dm) && /已提取：USD 912.50/.test(dm), 'true');
eq('今年已實現利息（912.50 × 7.8）', await txt(p.locator('#realizedYear')), 'HK$ 7,118');
eq('累計已實現利息', await txt(p.locator('#realizedAll')), 'HK$ 7,118');

// 全數提取
await seed([matured]);
c = await openCard('恒生銀行');
await c.locator('[data-settle]').click(); await p.waitForTimeout(300);
await p.check('input[name="sk"][value="none"]'); await p.waitForTimeout(200);
await p.click('#settleGo'); await p.waitForTimeout(400);
eq('全數提取不開新定期', await p.locator('#sheetBack').evaluate(e => e.classList.contains('open')), 'false');
const r2 = await p.evaluate(() => JSON.parse(localStorage.getItem('fd.deposits.v1')));
eq('只剩一筆', r2.length, '1');
eq('分類為提取', r2[0].doneKind, 'withdraw');

// 續存指定金額
await seed([matured]);
c = await openCard('恒生銀行');
await c.locator('[data-settle]').click(); await p.waitForTimeout(300);
await p.check('input[name="sk"][value="custom"]'); await p.waitForTimeout(200);
await p.fill('#s_custom', '30000'); await p.waitForTimeout(200);
eq('續存多過實收會攔截', /不可以多過實收/.test(await p.textContent('#s_summary')), 'true');
await p.fill('#s_custom', '15000'); await p.waitForTimeout(200);
await p.click('#settleGo'); await p.waitForTimeout(400);
await p.click('#sheet .save'); await p.waitForTimeout(400);
eq('提取 = 實收 − 續存', await p.evaluate(() =>
  JSON.parse(localStorage.getItem('fd.deposits.v1')).find(r => r.id === 'M').withdrawn), '5912.5');

// 到期安排
await seed([Object.assign({}, matured, { maturityPlan: 'auto' })]);
c = await openCard('恒生銀行');
eq('自動續存用另一種提示', /自動續存/.test(await c.locator('.idle').innerText()), 'true');
eq('明細顯示到期安排', /到期安排：自動續存/.test(await c.locator('.meta').innerText()), 'true');

// 編輯保留結算記錄
await seed([Object.assign({}, matured, { status: 'done', doneKind: 'rollover',
  actualTotal: 20912.5, realizedInterest: 912.5, withdrawn: 0, settledOn: '2026-09-11' })]);
await p.click('.chip[data-f="done"]'); await p.waitForTimeout(250);
c = await openCard('恒生銀行');
await c.locator('[data-edit]').click(); await p.waitForTimeout(250);
await p.fill('#f_note', '改咗'); await p.click('#sheet .save'); await p.waitForTimeout(400);
const r3 = await p.evaluate(() => JSON.parse(localStorage.getItem('fd.deposits.v1')));
eq('編輯唔會洗走結算記錄', r3[0].realizedInterest + '/' + r3[0].settledOn, '912.5/2026-09-11');
eq('狀態仍係已處理', r3[0].status, 'done');

G('資料安全');
await seed([dep({ id: 'z', bank: '刪除測試', amount: 10000 })]);
p.once('dialog', d => d.accept());
c = await openCard('刪除測試');
await c.locator('[data-del]').click(); await p.waitForTimeout(400);
eq('刪除後彈出復原提示', await p.locator('#toast').evaluate(e => e.classList.contains('show')), 'true');
await p.click('#toastAction'); await p.waitForTimeout(300);
eq('可以復原', await p.locator('.card', { hasText: '刪除測試' }).count(), '1');

await p.evaluate(() => localStorage.removeItem('fd.lastBackup.v1'));
await p.reload({ waitUntil: 'networkidle' });
eq('未備份過會警告', /尚未備份過/.test(await p.textContent('#backupInfo')), 'true');
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportBtn')]);
await p.waitForTimeout(300);
eq('匯出後記錄日期', /上次備份：\d{4}-\d{2}-\d{2}（今日）/.test(await p.textContent('#backupInfo')), 'true');
const { readFile } = await import('node:fs/promises');
const json = JSON.parse(await readFile(await dl.path(), 'utf8'));
eq('匯出格式版本', json.version, '4');

let msg = '', n = 0;
p.on('dialog', async d => { n++; if (n === 1) await d.accept(); else { msg = d.message(); await d.accept(); } });
await p.setInputFiles('#importFile', await dl.path());
await p.waitForTimeout(500);
eq('重複匯入唔會產生雙份', (await p.textContent('.chip[data-f="all"]')).replace(/\s+/g, ''), '進行中1');
eq('並報告更新筆數', /新增 0 筆，更新 1 筆/.test(msg), 'true');

// ══════════════════════════════════════════════
G('輸入驗證');
await p.click('#fab'); await p.waitForTimeout(250);
await p.fill('#f_bank', '日期倒轉'); await p.fill('#f_amount', '5000');
await p.fill('#f_start', '2027-01-01'); await p.fill('#f_maturity', '2026-01-01');
await p.waitForTimeout(250);
eq('到期日早過開始日會即時報錯', await p.locator('#dateErr').isVisible(), 'true');
const before = await p.evaluate(() => JSON.parse(localStorage.getItem('fd.deposits.v1')).length);
await p.click('#sheet .save'); await p.waitForTimeout(250);
eq('而且攔截儲存', await p.evaluate(() => JSON.parse(localStorage.getItem('fd.deposits.v1')).length), String(before));
await p.keyboard.press('Escape'); await p.waitForTimeout(200);

// ══════════════════════════════════════════════
G('列表操作');
await seed(['滙豐', '中銀', '渣打', '恒生', '東亞'].map((b, i) =>
  dep({ id: 'L' + i, bank: b, amount: (i + 1) * 10000, rate: 3 + i * 0.5,
        maturity: '2027-0' + (i + 1) + '-01', start: '2026-0' + (i + 1) + '-01' })));
eq('卡片預設摺疊', await p.locator('.card .c-body').first().isVisible(), 'false');
eq('摺疊時見到利息摘要', (await p.locator('.sum-int').first().textContent()).trim().startsWith('+'), 'true');
await p.fill('#q', '渣打'); await p.waitForTimeout(250);
eq('搜尋', await p.locator('.card').count(), '1');
await p.click('#qClear'); await p.waitForTimeout(250);
await p.selectOption('#sortBy', 'amount'); await p.waitForTimeout(250);
eq('按金額排序（大先）', (await p.locator('.card .bank').first().textContent()).trim(), '東亞');
await p.selectOption('#sortBy', 'maturity'); await p.waitForTimeout(250);
eq('按到期日排序（近先）', (await p.locator('.card .bank').first().textContent()).trim(), '滙豐');

// ══════════════════════════════════════════════
G('無障礙 / 表單行為');
const h = await p.evaluate(() => {
  const x = document.querySelector('.c-head');
  return { role: x.getAttribute('role'), ti: x.getAttribute('tabindex') };
});
eq('卡片標題可用鍵盤', h.role + '/' + h.ti, 'button/0');
await p.locator('.c-head').first().focus();
await p.keyboard.press('Enter'); await p.waitForTimeout(250);
eq('Enter 可展開', await p.locator('.card .c-body').first().isVisible(), 'true');
eq('aria-expanded 同步', await p.locator('.c-head').first().getAttribute('aria-expanded'), 'true');
eq('篩選標籤有 aria-pressed', await p.getAttribute('.chip[data-f="all"]', 'aria-pressed'), 'true');

await p.click('#fab'); await p.waitForTimeout(300);
eq('開表單自動聚焦第一欄', await p.evaluate(() => document.activeElement.id), 'f_bank');
eq('背景鎖住捲動', await p.evaluate(() => getComputedStyle(document.body).overflow), 'hidden');
await p.keyboard.press('Escape'); await p.waitForTimeout(250);
eq('Escape 關閉表單', await p.locator('#sheetBack').evaluate(e => e.classList.contains('open')), 'false');
eq('關閉後解鎖', await p.evaluate(() => getComputedStyle(document.body).overflow), 'visible');

// ══════════════════════════════════════════════
G('頁首 / 圖表');
await p.evaluate(() => window.scrollTo(0, 700)); await p.waitForTimeout(350);
eq('碌落後頁首縮細', await p.locator('#hdr').evaluate(e => e.classList.contains('compact')), 'true');
eq('常駐顯示總資產', (await p.textContent('#cTotal')).trim().startsWith('HK$'), 'true');
await p.click('#cRate'); await p.waitForTimeout(200);
eq('撳匯率掣可即時編輯', await p.evaluate(() => document.activeElement.id), 'rate');

await p.evaluate(() => localStorage.setItem('fd.charts.v1', '0'));
await p.reload({ waitUntil: 'networkidle' });
eq('圖表收埋時唔預先計算', await p.locator('#chBanks .bar-row').count(), '0');
await p.click('#chToggle'); await p.waitForTimeout(350);
eq('撳開即刻畫齊條形', await p.locator('#chBanks .bar-row').count(), '5');
eq('環形圖分段數（5 間，無「其他」）', await p.locator('#chDonut circle').count(), '5');
const lg = await p.$$eval('.lg-row', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
eq('圖例每行都有金額同百分比', lg.every(x => /HK\$ [\d,]+ · [\d.]+%/.test(x)), 'true');
eq('銀行條形有加權平均年利率', /^\d+\.\d{2}%$/.test(await p.textContent('#chBanks .bar-name em')), 'true');
eq('未有結算時每月已收利息顯示提示',
   /尚未有已結算的定期/.test(await p.textContent('#chRealized')), 'true');

// ══════════════════════════════════════════════
G('版面');
eq('無水平溢出', await p.evaluate(() => document.body.scrollWidth > window.innerWidth), 'false');
const small = await ctx.newPage();
await small.setViewportSize({ width: 320, height: 700 });
await small.goto(BASE, { waitUntil: 'networkidle' });
eq('320px 闊度無水平溢出', await small.evaluate(() => document.body.scrollWidth > window.innerWidth), 'false');
await small.close();

// ══════════════════════════════════════════════
console.log('\nCONSOLE ERRORS:', JSON.stringify(errors));
if (errors.length) fail.push('console errors: ' + errors.join('; '));
await browser.close();
console.log('\n' + (fail.length ? '✗ 失敗 ' + fail.length + ' 項:\n' + fail.join('\n') : '✓ 全部通過'));
process.exit(fail.length ? 1 : 0);
