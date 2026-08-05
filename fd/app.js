/* 定期存款追蹤器 —— 純前端，資料存喺 localStorage。
   功能：新增/編輯/刪除定期、手動匯率、港元總資產、到期提醒、JSON 匯出/匯入、PWA 安裝。*/
(function () {
  'use strict';

  var STORE_KEY = 'fd.deposits.v1';
  var RATE_KEY = 'fd.rate.v1';
  var SOON_DAYS = 7; // 到期前幾日當「快到期」

  // ── 狀態 ──
  var deposits = load(STORE_KEY, []);
  var rate = parseFloat(load(RATE_KEY, '7.8')) || 7.8;

  // ── DOM ──
  var $ = function (id) { return document.getElementById(id); };
  var rateInput = $('rate'), rateEcho = $('rateEcho');
  var listEl = $('list'), bannersEl = $('banners');
  var totalHkdEl = $('totalHkd'), countEl = $('count'), soonCountEl = $('soonCount'), breakdownEl = $('breakdown');
  var totalInterestEl = $('totalInterest'), totalWithInterestEl = $('totalWithInterest');
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
    var basis = +dep.basis === 360 ? 360 : 365;
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

    // 列表
    if (!sorted.length) {
      listEl.innerHTML = '<div class="empty">尚未有定期存款記錄。<br>請按右下角 ＋ 新增第一筆 👇</div>';
      return;
    }
    listEl.innerHTML = '<div class="section-title">所有定期存款（按到期日排序）</div>' +
      sorted.map(cardHtml).join('');

    // 綁定卡片按鈕
    listEl.querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () { openForm(btn.getAttribute('data-edit')); });
    });
    listEl.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeDeposit(btn.getAttribute('data-del')); });
    });
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
    }

    var meta = [];
    meta.push('<span class="k">到期：</span>' + esc(d.maturity || '—'));
    if (d.start) meta.push('<span class="k">開始：</span>' + esc(d.start));
    if (d.durNum) meta.push('<span class="k">存期：</span>' + esc(d.durNum) + ' ' + unitLabel(d.durUnit));
    if (d.rate) meta.push('<span class="k">年利率：</span>' + esc(d.rate) + '%');
    if (it) meta.push('<span class="k">到期本利和：</span>' + esc(d.currency) + ' ' + fmt2((+d.amount || 0) + it.amount));
    if (d.note) meta.push('<span class="k">備註：</span>' + esc(d.note));

    return '<div class="' + cls + '">' +
      '<div class="row1">' +
        '<div class="bank">' + esc(d.bank) + '</div>' +
        '<div class="amt">' + fmtMoney(+d.amount || 0) + ' <small>' + esc(d.currency) + '</small></div>' +
      '</div>' +
      hkdLine +
      badge +
      intBlock +
      '<div class="meta">' + meta.join('<br>') + '</div>' +
      '<div class="actions">' +
        '<button data-edit="' + d.id + '">✏️ 編輯</button>' +
        '<button class="del" data-del="' + d.id + '">🗑 刪除</button>' +
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
    $('f_basis').value = '365';
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
        $('f_basis').value = String(+d.basis === 360 ? 360 : 365);
        $('f_interest').value = d.interest != null ? d.interest : '';
        $('f_note').value = d.note || '';
      }
    } else {
      sheetTitle.textContent = '新增定期存款';
    }
    updateInterestPreview();
    sheetBack.classList.add('open');
  }

  // 表單即時預覽利息
  function updateInterestPreview() {
    var el = $('interestPreview');
    var manual = parseFloat($('f_interest').value);
    var cur = $('f_currency').value;
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
    } else if (parseFloat($('f_rate').value) > 0) {
      el.textContent = '需要「開始存款日期」或「存款期限」先計到存期日數，才可自動計算利息。';
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
      basis: +$('f_basis').value === 360 ? 360 : 365,
      interest: $('f_interest').value !== '' ? parseFloat($('f_interest').value) : '',
      note: $('f_note').value.trim()
    };
    if (!rec.bank || !(rec.amount >= 0)) return;

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
            basis: +d.basis === 360 ? 360 : 365,
            interest: isFinite(parseFloat(d.interest)) ? parseFloat(d.interest) : '',
            note: d.note || ''
          };
        });
        if (mode === 'replace') {
          deposits = norm;
        } else {
          var ids = {};
          deposits.forEach(function (d) { ids[d.id] = true; });
          norm.forEach(function (d) { if (ids[d.id]) d.id = uid(); deposits.push(d); });
        }
        if (data && typeof data.rate === 'number' && data.rate > 0) { rate = data.rate; saveRate(); }
        saveDeposits();
        render();
        alert('匯入完成 ✅');
      } catch (err) {
        alert('匯入失敗：' + err.message);
      }
      $('importFile').value = '';
    };
    reader.readAsText(file);
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
