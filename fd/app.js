/* 定期存款追蹤器 —— 純前端，資料存喺 localStorage。
   功能：新增/編輯/刪除定期、手動匯率、港元總資產、到期提醒、JSON 匯出/匯入、PWA 安裝。*/
(function () {
  'use strict';

  var STORE_KEY = 'fd.deposits.v1';
  var RATE_KEY = 'fd.rate.v1';
  var SORT_KEY = 'fd.sort.v1';
  var SOON_DAYS = 7; // 到期前幾日當「快到期」
  var DEFAULT_BASIS = 360; // 預設計息基礎（美元定期多數銀行用 360 日）

  // ── 狀態 ──
  var deposits = load(STORE_KEY, []);
  var rate = parseFloat(load(RATE_KEY, '7.8')) || 7.8;
  // 檢視狀態：搜尋／篩選係即時性（重開回復預設），排序會記住
  var view = { q: '', filter: 'all', sort: localStorage.getItem(SORT_KEY) || 'maturity' };
  var expanded = {}; // 展開咗嘅卡片 id

  // ── DOM ──
  var $ = function (id) { return document.getElementById(id); };
  var rateInput = $('rate'), rateEcho = $('rateEcho');
  var listEl = $('list'), bannersEl = $('banners');
  var totalHkdEl = $('totalHkd'), countEl = $('count'), soonCountEl = $('soonCount'), breakdownEl = $('breakdown');
  var totalInterestEl = $('totalInterest'), totalWithInterestEl = $('totalWithInterest');
  var hdrEl = $('hdr'), cTotalEl = $('cTotal'), cMetaEl = $('cMeta'), cRateEl = $('cRate');
  var qEl = $('q'), qClearEl = $('qClear'), sortEl = $('sortBy'), chipsEl = $('chips');
  var sheetBack = $('sheetBack'), form = $('form'), sheetTitle = $('sheetTitle');

  // ── 工具 ──
  function load(k, def) {
    try { var v = localStorage.getItem(k); return v == null ? def : (k === STORE_KEY ? JSON.parse(v) : v); }
    catch (e) { return def; }
  }
  function saveDeposits() { localStorage.setItem(STORE_KEY, JSON.stringify(deposits)); }
  function saveRate() { localStorage.setItem(RATE_KEY, String(rate)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDate(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function todayStr() { return fmtDate(new Date()); }

  // 以本地午夜計算相差日數
  function diffDays(fromStr, toStr) {
    return Math.round((parseDate(toStr) - parseDate(fromStr)) / 86400000);
  }
  // 距離到期日仲有幾多日（正 = 未到期，負 = 已過期）
  function daysUntil(dateStr) { return dateStr ? diffDays(todayStr(), dateStr) : null; }

  // 加／減月份時將日數夾實喺當月最後一日（例：1月31日 + 1個月 = 2月28日）
  function addMonths(d, n) {
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
  }

  // 由某日期推前（sign = 1）或推後（sign = -1）一段存期
  function shiftDate(dateStr, num, unit, sign) {
    if (!dateStr || !num) return '';
    var d = parseDate(dateStr), n = (+num) * sign;
    if (unit === 'day') d.setDate(d.getDate() + n);
    else if (unit === 'year') addMonths(d, n * 12);
    else addMonths(d, n);
    return fmtDate(d);
  }

  function toHkd(dep) {
    var amt = +dep.amount || 0;
    return dep.currency === 'HKD' ? amt : amt * rate;
  }

  // 整數唔顯示小數點；有斗零就完整顯示兩位（唔可以四捨五入蓋住本金銀碼）
  function fmtMoney(n, cur) {
    var s = Number.isInteger(n)
      ? n.toLocaleString('en-US')
      : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (cur ? cur + ' ' : '') + s;
  }
  function fmtHkd(n) { return 'HK$ ' + Math.round(n).toLocaleString('en-US'); }
  // 利息通常有斗零，固定顯示兩位小數
  function fmt2(n) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function unitLabel(u) { return u === 'day' ? '日' : u === 'year' ? '年' : '個月'; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 由開始日 + 存期計到期日
  function calcMaturity(startStr, num, unit) { return shiftDate(startStr, num, unit, 1); }

  // ── 利息計算 ──
  // 存期日數：優先用「開始日期 → 到期日期」；若無開始日期，用到期日期倒推存款期限
  function termDays(dep) {
    if (!dep.maturity) return null;
    var start = dep.start || shiftDate(dep.maturity, dep.durNum, dep.durUnit, -1);
    if (!start) return null;
    var days = diffDays(start, dep.maturity);
    return days > 0 ? days : null;
  }

  // 回傳 { amount, manual, days, basis } 或 null（資料不足以計算）
  function interestOf(dep) {
    var manual = parseFloat(dep.interest);
    if (isFinite(manual)) return { amount: manual, manual: true, days: termDays(dep), basis: null };
    var r = parseFloat(dep.rate);
    if (!(r > 0)) return null;
    var days = termDays(dep);
    if (days == null) return null;
    var basis = +dep.basis === 365 ? 365 : DEFAULT_BASIS;
    // 單利：本金 × 年利率 × 存期日數 ÷ 一年日數
    return { amount: (+dep.amount || 0) * (r / 100) * days / basis, manual: false, days: days, basis: basis };
  }

  // ── 渲染 ──
  function render() {
    rateInput.value = rate;
    rateEcho.textContent = rate;

    var sorted = deposits.slice().sort(function (a, b) {
      return (a.maturity || '').localeCompare(b.maturity || '');
    });

    // 統計
    var totalHkd = 0, usdSum = 0, hkdSum = 0, soon = 0, over = 0;
    var intHkd = 0, intUsd = 0, intHkdOnly = 0, missingRate = 0;
    sorted.forEach(function (d) {
      totalHkd += toHkd(d);
      if (d.currency === 'HKD') hkdSum += +d.amount || 0; else usdSum += +d.amount || 0;
      var du = daysUntil(d.maturity);
      if (du != null && du < 0) over++;
      else if (du != null && du <= SOON_DAYS) soon++;

      var it = interestOf(d);
      if (it) {
        intHkd += d.currency === 'HKD' ? it.amount : it.amount * rate;
        if (d.currency === 'HKD') intHkdOnly += it.amount; else intUsd += it.amount;
      } else {
        missingRate++;
      }
    });

    totalHkdEl.textContent = fmtHkd(totalHkd);
    totalInterestEl.textContent = '+ ' + fmtHkd(intHkd);
    totalWithInterestEl.textContent = fmtHkd(totalHkd + intHkd);
    countEl.textContent = sorted.length;
    soonCountEl.textContent = soon;

    var parts = [];
    if (usdSum) parts.push('美元本金合計：' + fmtMoney(usdSum, 'USD'));
    if (hkdSum) parts.push('港元本金合計：' + fmtMoney(hkdSum, 'HKD'));
    if (intUsd) parts.push('美元利息合計：USD ' + fmt2(intUsd));
    if (intHkdOnly) parts.push('港元利息合計：HKD ' + fmt2(intHkdOnly));
    if (missingRate && sorted.length) parts.push('（' + missingRate + ' 筆未填年利率或存期，未計入利息）');
    breakdownEl.textContent = parts.join('　·　');

    // 提醒 banner
    bannersEl.innerHTML = '';
    if (over > 0) {
      addBanner('danger', '有 <b>' + over + '</b> 筆定期存款<b>已到期</b>，請盡快處理或轉存。');
    }
    if (soon > 0) {
      var b = addBanner('warn', '有 <b>' + soon + '</b> 筆定期存款將於 <b>' + SOON_DAYS + ' 日內到期</b>，可準備調動資金。');
      maybeAddNotifyButton(b);
    }

    // 縮小版頁首（碌落之後長期見到總數）
    cTotalEl.textContent = fmtHkd(totalHkd);
    cMetaEl.textContent = sorted.length + ' 筆' + (soon ? ' · ' + soon + ' 即將到期' : '') + (over ? ' · ' + over + ' 已到期' : '');
    cRateEl.textContent = '@ ' + rate;

    // 篩選標籤計數
    setChip('all', sorted.length);
    setChip('soon', soon);
    setChip('over', over);

    // 列表（套用搜尋 / 篩選 / 排序）
    if (!sorted.length) {
      renderCharts([]);   // 刪清所有記錄後唔可以留低舊圖表
      listEl.innerHTML = '<div class="empty">尚未有定期存款記錄。<br>請按右下角 ＋ 新增第一筆 👇</div>';
      return;
    }
    var shown = applyView(sorted);
    renderCharts(shown);   // 圖表跟同一個篩選範圍（篩選列喺圖表上面）
    if (!shown.length) {
      listEl.innerHTML = '<div class="empty">沒有符合條件的記錄。<br>請清除搜尋，或選擇「全部」。</div>';
      return;
    }
    listEl.innerHTML = '<div class="section-title">' + viewTitle(shown.length, sorted.length) + '</div>' +
      shown.map(cardHtml).join('');

    // 綁定卡片事件
    listEl.querySelectorAll('.c-head').forEach(function (h) {
      h.addEventListener('click', function () { toggleCard(h.getAttribute('data-id')); });
      h.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          toggleCard(h.getAttribute('data-id'));
        }
      });
    });
    listEl.querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { openForm(btn.getAttribute('data-edit')); });
    });
    listEl.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeDeposit(btn.getAttribute('data-del')); });
    });
  }

  // ── 圖表 ──
  // 全部用單一色相：銀行同月份都係名目類別，用深淺去分只會重覆編碼條形長度已經表達嘅嘢。
  // 每條都直接標數值，所以數字唔會淨係靠顏色傳達。
  function barRow(name, valText, ratio) {
    return '<div class="bar-row">' +
      '<div class="bar-top"><span class="bar-name">' + esc(name) + '</span>' +
      '<span class="bar-val">' + valText + '</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' +
        Math.max(0, Math.min(100, ratio * 100)).toFixed(2) + '%"></div></div>' +
    '</div>';
  }

  function renderCharts(list) {
    var scopeEl = $('chScope');
    scopeEl.textContent = (view.filter !== 'all' || view.q)
      ? '（只計算目前篩選的 ' + list.length + ' 筆）' : '';

    var total = list.reduce(function (s, d) { return s + toHkd(d); }, 0);
    if (!list.length || total <= 0) {
      var none = '<div class="ch-empty">沒有資料</div>';
      $('chBanks').innerHTML = none; $('chMaturity').innerHTML = none; $('chCurrency').innerHTML = none;
      $('chBankSub').textContent = '按港元價值由大至小排列';
      return;
    }

    // 1. 各銀行資產（合併同名銀行）
    var byBank = {};
    list.forEach(function (d) { byBank[d.bank] = (byBank[d.bank] || 0) + toHkd(d); });
    var banks = Object.keys(byBank).map(function (k) { return { name: k, v: byBank[k] }; })
      .sort(function (a, b) { return b.v - a.v; });
    var top = banks[0];
    $('chBankSub').textContent = '共 ' + banks.length + ' 間銀行　·　佔比最高一間為 ' +
      (top.v / total * 100).toFixed(1) + '%（' + top.name + '）';
    $('chBanks').innerHTML = banks.map(function (b) {
      return barRow(b.name, fmtHkd(b.v) + '　·　' + (b.v / total * 100).toFixed(1) + '%', b.v / top.v);
    }).join('');

    // 2. 到期時間分佈（按月，只列有定期嘅月份）
    var byMonth = {};
    list.forEach(function (d) {
      if (!d.maturity) return;
      var k = d.maturity.slice(0, 7);
      if (!byMonth[k]) byMonth[k] = { v: 0, n: 0 };
      byMonth[k].v += toHkd(d); byMonth[k].n++;
    });
    var months = Object.keys(byMonth).sort();
    if (!months.length) {
      $('chMaturity').innerHTML = '<div class="ch-empty">沒有到期日資料</div>';
    } else {
      var maxM = Math.max.apply(null, months.map(function (k) { return byMonth[k].v; }));
      $('chMaturity').innerHTML = months.map(function (k) {
        var p = k.split('-');
        return barRow(p[0] + ' 年 ' + (+p[1]) + ' 月',
          fmtHkd(byMonth[k].v) + '　·　' + byMonth[k].n + ' 筆', byMonth[k].v / maxM);
      }).join('');
    }

    // 3. 貨幣分佈
    var cur = { USD: 0, HKD: 0 };
    list.forEach(function (d) { cur[d.currency === 'HKD' ? 'HKD' : 'USD'] += toHkd(d); });
    var maxC = Math.max(cur.USD, cur.HKD);
    var rows = [];
    if (cur.USD > 0) rows.push(barRow('美元 USD', fmtHkd(cur.USD) + '　·　' + (cur.USD / total * 100).toFixed(1) + '%', cur.USD / maxC));
    if (cur.HKD > 0) rows.push(barRow('港元 HKD', fmtHkd(cur.HKD) + '　·　' + (cur.HKD / total * 100).toFixed(1) + '%', cur.HKD / maxC));
    $('chCurrency').innerHTML = rows.join('');
    $('chCurSub').textContent = '按港元價值計　·　美元以 @ ' + rate + ' 換算';
  }

  function setChip(f, n) {
    var c = chipsEl.querySelector('[data-f="' + f + '"]');
    c.querySelector('b').textContent = n;
    c.classList.toggle('on', view.filter === f);
    c.disabled = (f !== 'all' && n === 0);
    if (c.disabled && view.filter === f) { view.filter = 'all'; }
  }

  // 搜尋 → 篩選 → 排序
  function applyView(list) {
    var q = view.q.trim().toLowerCase();
    var out = list.filter(function (d) {
      if (q && (d.bank + ' ' + (d.note || '')).toLowerCase().indexOf(q) < 0) return false;
      var du = daysUntil(d.maturity);
      if (view.filter === 'soon') return du != null && du >= 0 && du <= SOON_DAYS;
      if (view.filter === 'over') return du != null && du < 0;
      return true;
    });
    if (view.sort === 'amount') {
      out.sort(function (a, b) { return toHkd(b) - toHkd(a); });
    } else if (view.sort === 'interest') {
      out.sort(function (a, b) { return intHkdOf(b) - intHkdOf(a); });
    }
    return out; // maturity：已經按到期日排好
  }

  // 用港元計，等美元同港元可以公平比較
  function intHkdOf(d) {
    var it = interestOf(d);
    if (!it) return -1;
    return d.currency === 'HKD' ? it.amount : it.amount * rate;
  }

  function viewTitle(shownN, totalN) {
    var byLabel = { maturity: '按到期日', amount: '按金額', interest: '按利息' }[view.sort];
    var scope = { all: '所有定期存款', soon: '即將到期', over: '已到期' }[view.filter];
    var t = scope + '（' + byLabel + '排序）';
    return shownN < totalN ? t + '　顯示 ' + shownN + ' / ' + totalN : t;
  }

  function toggleCard(id) {
    if (expanded[id]) delete expanded[id]; else expanded[id] = true;
    var el = listEl.querySelector('.card[data-id="' + id + '"]');
    if (el) {
      el.classList.toggle('open', !!expanded[id]);
      el.querySelector('.c-head').setAttribute('aria-expanded', expanded[id] ? 'true' : 'false');
    }
  }

  function cardHtml(d) {
    var du = daysUntil(d.maturity);
    var cls = 'card', badge = '';
    if (du != null && du < 0) {
      cls += ' overdue';
      badge = '<span class="badge over">已到期 ' + (-du) + ' 日</span>';
    } else if (du != null && du <= SOON_DAYS) {
      cls += ' due-soon';
      badge = '<span class="badge soon">' + (du === 0 ? '今日到期' : '尚餘 ' + du + ' 日到期') + '</span>';
    } else if (du != null) {
      badge = '<span class="badge ok">尚餘 ' + du + ' 日到期</span>';
    }

    var hkd = toHkd(d);
    var hkdLine = d.currency === 'USD'
      ? '<div class="hkd">≈ ' + fmtHkd(hkd) + '（@ ' + rate + '）</div>'
      : '';

    // 預期利息
    var it = interestOf(d);
    var intBlock = '';
    if (it) {
      var intHkd = d.currency === 'HKD' ? it.amount : it.amount * rate;
      var tag = it.manual
        ? '<span class="tag">手動輸入</span>'
        : '<span class="tag">' + it.days + ' 日 ÷ ' + it.basis + '</span>';
      intBlock = '<div class="int">' +
        '<span class="lab">預期利息</span>' +
        '<b>+ ' + esc(d.currency) + ' ' + fmt2(it.amount) + '</b>' +
        (d.currency === 'USD' ? '<small>≈ ' + fmtHkd(intHkd) + '</small>' : '') +
        tag +
      '</div>';
    } else {
      // 計唔到利息時要講明原因，唔可以靜靜雞當零
      var why = parseFloat(d.rate) > 0
        ? '未填開始存款日期或存款期限，無法計算存期'
        : '未填年利率';
      intBlock = '<div class="int missing">' +
        '<span class="lab">預期利息</span><b>—</b>' +
        '<small>' + why + '</small>' +
      '</div>';
    }

    var meta = [];
    meta.push('<span class="k">到期：</span>' + esc(d.maturity || '—'));
    if (d.start) meta.push('<span class="k">開始：</span>' + esc(d.start));
    if (d.durNum) meta.push('<span class="k">存期：</span>' + esc(d.durNum) + ' ' + unitLabel(d.durUnit));
    if (d.rate) meta.push('<span class="k">年利率：</span>' + esc(d.rate) + '%');
    if (it) meta.push('<span class="k">到期本利和：</span>' + esc(d.currency) + ' ' + fmt2((+d.amount || 0) + it.amount));
    if (d.note) meta.push('<span class="k">備註：</span>' + esc(d.note));

    // 摺疊時嘅一行摘要：利息（或「—」）
    var sumInt = it
      ? '<span class="sum-int">+ ' + esc(d.currency) + ' ' + fmt2(it.amount) + '</span>'
      : '<span class="sum-int none">利息 —</span>';

    return '<div class="' + cls + (expanded[d.id] ? ' open' : '') + '" data-id="' + d.id + '">' +
      '<div class="c-head" data-id="' + d.id + '" role="button" tabindex="0"' +
        ' aria-expanded="' + (expanded[d.id] ? 'true' : 'false') + '">' +
        '<div class="row1">' +
          '<div class="bank">' + esc(d.bank) + '</div>' +
          '<div class="amt">' + fmtMoney(+d.amount || 0) + ' <small>' + esc(d.currency) + '</small></div>' +
        '</div>' +
        '<div class="row2">' + badge + sumInt + '<span class="chev">▼</span></div>' +
      '</div>' +
      '<div class="c-body">' +
        hkdLine +
        intBlock +
        '<div class="meta">' + meta.join('<br>') + '</div>' +
        '<div class="actions">' +
          '<button data-edit="' + d.id + '">✏️ 編輯</button>' +
          '<button class="del" data-del="' + d.id + '">🗑 刪除</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function addBanner(type, html) {
    var el = document.createElement('div');
    el.className = 'banner ' + type;
    el.innerHTML = html;
    bannersEl.appendChild(el);
    return el;
  }

  // ── 通知 ──
  function maybeAddNotifyButton(banner) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') { fireNotification(); return; }
    if (Notification.permission === 'denied') return;
    var btn = document.createElement('button');
    btn.className = 'notify-btn';
    btn.textContent = '🔔 開啟到期提醒';
    btn.addEventListener('click', function () {
      Notification.requestPermission().then(function (p) {
        if (p === 'granted') { btn.remove(); fireNotification(); }
      });
    });
    banner.appendChild(document.createElement('br'));
    banner.appendChild(btn);
  }

  function fireNotification() {
    try {
      var soonList = deposits.filter(function (d) {
        var du = daysUntil(d.maturity);
        return du != null && du >= 0 && du <= SOON_DAYS;
      });
      if (!soonList.length) return;
      var body = soonList.map(function (d) {
        var du = daysUntil(d.maturity);
        return '• ' + d.bank + '（' + (du === 0 ? '今日到期' : '尚餘 ' + du + ' 日') + '）';
      }).join('\n');
      new Notification('💰 定期存款即將到期', { body: body, icon: 'icons/icon-192.png', tag: 'fd-soon' });
    } catch (e) {}
  }

  // ── 表單 ──
  function openForm(id) {
    form.reset();
    $('editId').value = '';
    $('f_currency').value = 'USD';
    $('f_durUnit').value = 'month';
    $('f_basis').value = String(DEFAULT_BASIS);
    if (id) {
      var d = deposits.find(function (x) { return x.id === id; });
      if (d) {
        sheetTitle.textContent = '編輯定期存款';
        $('editId').value = d.id;
        $('f_bank').value = d.bank || '';
        $('f_amount').value = d.amount != null ? d.amount : '';
        $('f_currency').value = d.currency || 'USD';
        $('f_maturity').value = d.maturity || '';
        $('f_start').value = d.start || '';
        $('f_durNum').value = d.durNum || '';
        $('f_durUnit').value = d.durUnit || 'month';
        $('f_rate').value = d.rate != null ? d.rate : '';
        $('f_basis').value = String(+d.basis === 365 ? 365 : DEFAULT_BASIS);
        $('f_interest').value = d.interest != null ? d.interest : '';
        $('f_note').value = d.note || '';
      }
    } else {
      sheetTitle.textContent = '新增定期存款';
    }
    updateInterestPreview();
    sheetBack.classList.add('open');
  }

  // 到期日期必須喺開始日期之後，否則存期日數會變負數，靜靜雞計唔到利息
  function dateProblem() {
    var s = $('f_start').value, m = $('f_maturity').value;
    if (!s || !m) return '';
    if (m === s) return '到期日期同開始存款日期一樣，存期為零。';
    if (m < s) return '到期日期早於開始存款日期，請檢查。';
    return '';
  }
  function updateDateErr() {
    var msg = dateProblem(), el = $('dateErr');
    el.textContent = msg ? '⚠️ ' + msg : '';
    el.hidden = !msg;
    return msg;
  }

  // 表單即時預覽利息
  function updateInterestPreview() {
    updateDateErr();
    var el = $('interestPreview');
    var manual = parseFloat($('f_interest').value);
    var cur = $('f_currency').value;
    el.className = 'autonote';
    if (isFinite(manual)) {
      el.textContent = '已手動指定利息：' + cur + ' ' + fmt2(manual) + '（不會按年利率自動計算）';
      return;
    }
    var draft = {
      amount: parseFloat($('f_amount').value) || 0,
      maturity: $('f_maturity').value || calcMaturity($('f_start').value, $('f_durNum').value, $('f_durUnit').value),
      start: $('f_start').value,
      durNum: $('f_durNum').value,
      durUnit: $('f_durUnit').value,
      rate: $('f_rate').value,
      basis: $('f_basis').value
    };
    var it = interestOf(draft);
    if (it) {
      // 同時顯示另一個計息基礎嘅金額，方便對銀行張單揀啱
      draft.basis = it.basis === 365 ? 360 : 365;
      var alt = interestOf(draft);
      el.textContent = '預計到期利息：' + cur + ' ' + fmt2(it.amount) +
        '（存期 ' + it.days + ' 日 ÷ ' + it.basis + ' 日）' +
        (alt ? '　·　若揀 ' + alt.basis + ' 日基礎則為 ' + cur + ' ' + fmt2(alt.amount) : '');
    } else if (dateProblem()) {
      el.className = 'autonote warn';
      el.textContent = '⚠️ 日期不正確，未能計算利息。請先修正上方的到期日期。';
    } else if (parseFloat($('f_rate').value) > 0) {
      el.className = 'autonote warn';
      el.textContent = '⚠️ 已填年利率，但未填「開始存款日期」或「存款期限」，無法計算存期日數，' +
        '利息會顯示為「—」。補填其中一項即可自動計算。';
    } else {
      el.textContent = '填寫年利率後會自動計算到期利息；若與銀行報價不同，可於此欄手動填寫覆寫。';
    }
  }
  function closeForm() { sheetBack.classList.remove('open'); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var maturity = $('f_maturity').value;
    var start = $('f_start').value;
    var durNum = $('f_durNum').value;
    var durUnit = $('f_durUnit').value;

    // 如到期日未填而有開始日 + 存期，自動計
    if (!maturity && start && durNum) {
      maturity = calcMaturity(start, durNum, durUnit);
      $('f_maturity').value = maturity;
    }
    if (!maturity) { $('f_maturity').focus(); return; }

    // 唔可以靜靜雞收埋壞資料：日期倒轉／金額為零都要即時講明
    if (updateDateErr()) { $('f_maturity').focus(); return; }
    if (!(parseFloat($('f_amount').value) > 0)) {
      alert('請輸入大於 0 的金額。');
      $('f_amount').focus();
      return;
    }
    if (!$('f_bank').value.trim()) { $('f_bank').focus(); return; }

    var rec = {
      id: $('editId').value || uid(),
      bank: $('f_bank').value.trim(),
      amount: parseFloat($('f_amount').value),
      currency: $('f_currency').value,
      maturity: maturity,
      start: start || '',
      durNum: durNum ? +durNum : '',
      durUnit: durUnit,
      rate: $('f_rate').value !== '' ? parseFloat($('f_rate').value) : '',
      basis: +$('f_basis').value === 365 ? 365 : DEFAULT_BASIS,
      interest: $('f_interest').value !== '' ? parseFloat($('f_interest').value) : '',
      note: $('f_note').value.trim()
    };
    if (!rec.bank || !(rec.amount > 0)) return;

    var idx = deposits.findIndex(function (x) { return x.id === rec.id; });
    if (idx >= 0) deposits[idx] = rec; else deposits.push(rec);
    saveDeposits();
    closeForm();
    render();
  });

  // 開始日/存期改動 → 若到期日空就即時預覽
  function autoFillMaturity() {
    if ($('f_maturity').value) return;
    var m = calcMaturity($('f_start').value, $('f_durNum').value, $('f_durUnit').value);
    if (m) $('f_maturity').value = m;
  }
  ['f_start', 'f_durNum', 'f_durUnit'].forEach(function (id) {
    $(id).addEventListener('change', autoFillMaturity);
  });

  // 任何影響利息嘅欄位改動 → 即時更新預覽
  ['f_amount', 'f_currency', 'f_maturity', 'f_start', 'f_durNum', 'f_durUnit', 'f_rate', 'f_basis', 'f_interest']
    .forEach(function (id) {
      $(id).addEventListener('input', updateInterestPreview);
      $(id).addEventListener('change', updateInterestPreview);
    });

  function removeDeposit(id) {
    var d = deposits.find(function (x) { return x.id === id; });
    if (!confirm('確定刪除「' + (d ? d.bank : '') + '」這筆定期存款？')) return;
    deposits = deposits.filter(function (x) { return x.id !== id; });
    saveDeposits();
    render();
  }

  // ── 匯率 ──
  rateInput.addEventListener('input', function () {
    var v = parseFloat(rateInput.value);
    if (v > 0) { rate = v; saveRate(); rateEcho.textContent = v; render(); }
  });

  // ── 匯出 / 匯入 ──
  $('exportBtn').addEventListener('click', function () {
    var payload = { app: 'fd-tracker', version: 2, exportedAt: new Date().toISOString(), rate: rate, deposits: deposits };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fixed-deposit-backup-' + todayStr() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  $('importBtn').addEventListener('click', function () { $('importFile').click(); });
  $('importFile').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var incoming = Array.isArray(data) ? data : data.deposits;
        if (!Array.isArray(incoming)) throw new Error('檔案格式不正確');
        var mode = deposits.length
          ? (confirm('將匯入 ' + incoming.length + ' 筆記錄。\n\n按「確定」＝ 合併至現有記錄\n按「取消」＝ 完全取代現有記錄') ? 'merge' : 'replace')
          : 'replace';
        // 正規化
        var norm = incoming.map(function (d) {
          return {
            id: d.id || uid(),
            bank: d.bank || '',
            amount: parseFloat(d.amount) || 0,
            currency: d.currency === 'HKD' ? 'HKD' : 'USD',
            maturity: d.maturity || d.maturityDate || '',
            start: d.start || d.startDate || '',
            durNum: d.durNum ? +d.durNum : '',
            durUnit: d.durUnit || 'month',
            rate: isFinite(parseFloat(d.rate)) ? parseFloat(d.rate) : '',
            basis: +d.basis === 365 ? 365 : DEFAULT_BASIS,
            interest: isFinite(parseFloat(d.interest)) ? parseFloat(d.interest) : '',
            note: d.note || ''
          };
        });
        var added = 0, updated = 0;
        if (mode === 'replace') {
          deposits = norm;
          added = norm.length;
        } else {
          // 合併：同一個 id 視為同一筆，直接更新；唔可以重新編號，否則
          // 匯入同一份備份兩次就會將所有記錄複製一份。
          var pos = {};
          deposits.forEach(function (d, i) { pos[d.id] = i; });
          norm.forEach(function (d) {
            if (pos[d.id] != null) { deposits[pos[d.id]] = d; updated++; }
            else { pos[d.id] = deposits.push(d) - 1; added++; }
          });
        }
        if (data && typeof data.rate === 'number' && data.rate > 0) { rate = data.rate; saveRate(); }
        saveDeposits();
        render();
        alert('匯入完成 ✅\n\n' + (mode === 'replace'
          ? '已取代為 ' + added + ' 筆記錄。'
          : '新增 ' + added + ' 筆，更新 ' + updated + ' 筆。'));
      } catch (err) {
        alert('匯入失敗：' + err.message);
      }
      $('importFile').value = '';
    };
    reader.readAsText(file);
  });

  // ── 搜尋 / 篩選 / 排序 ──
  qEl.addEventListener('input', function () {
    view.q = qEl.value;
    qClearEl.hidden = !view.q;
    render();
  });
  qClearEl.addEventListener('click', function () {
    qEl.value = ''; view.q = ''; qClearEl.hidden = true; render(); qEl.focus();
  });
  sortEl.value = view.sort;
  sortEl.addEventListener('change', function () {
    view.sort = sortEl.value;
    localStorage.setItem(SORT_KEY, view.sort);
    render();
  });
  chipsEl.addEventListener('click', function (e) {
    var c = e.target.closest('.chip');
    if (!c || c.disabled) return;
    view.filter = c.getAttribute('data-f');
    render();
  });

  // ── 圖表面板開合（記住狀態）──
  var CHARTS_KEY = 'fd.charts.v1';
  var chartsEl = $('charts'), chToggle = $('chToggle');
  if (localStorage.getItem(CHARTS_KEY) === '1') {
    chartsEl.classList.add('open');
    chToggle.setAttribute('aria-expanded', 'true');
  }
  chToggle.addEventListener('click', function () {
    var open = chartsEl.classList.toggle('open');
    chToggle.setAttribute('aria-expanded', String(open));
    localStorage.setItem(CHARTS_KEY, open ? '1' : '0');
  });

  // ── 碌動時頁首縮細（加滯後範圍，避免喺臨界點閃來閃去）──
  var isCompact = false;
  window.addEventListener('scroll', function () {
    var y = window.pageYOffset;
    if (!isCompact && y > 150) { isCompact = true; hdrEl.classList.add('compact'); }
    else if (isCompact && y < 60) { isCompact = false; hdrEl.classList.remove('compact'); }
  }, { passive: true });
  $('hCompact').addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ── FAB / sheet 事件 ──
  $('fab').addEventListener('click', function () { openForm(); });
  $('cancelBtn').addEventListener('click', closeForm);
  sheetBack.addEventListener('click', function (e) { if (e.target === sheetBack) closeForm(); });

  // ── PWA 安裝提示 ──
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    var b = $('installBtn');
    b.style.display = 'inline-block';
    b.addEventListener('click', function () {
      b.style.display = 'none';
      deferredPrompt.prompt();
      deferredPrompt = null;
    });
  });

  // ── 啟動 ──
  render();
})();
