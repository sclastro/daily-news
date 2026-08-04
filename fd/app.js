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
  var sheetBack = $('sheetBack'), form = $('form'), sheetTitle = $('sheetTitle');

  // ── 工具 ──
  function load(k, def) {
    try { var v = localStorage.getItem(k); return v == null ? def : (k === STORE_KEY ? JSON.parse(v) : v); }
    catch (e) { return def; }
  }
  function saveDeposits() { localStorage.setItem(STORE_KEY, JSON.stringify(deposits)); }
  function saveRate() { localStorage.setItem(RATE_KEY, String(rate)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // 以本地午夜計算相差日數（正 = 未到期，負 = 已過期）
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    var t = todayStr().split('-'), m = dateStr.split('-');
    var a = new Date(+t[0], +t[1] - 1, +t[2]);
    var b = new Date(+m[0], +m[1] - 1, +m[2]);
    return Math.round((b - a) / 86400000);
  }

  function toHkd(dep) {
    var amt = +dep.amount || 0;
    return dep.currency === 'HKD' ? amt : amt * rate;
  }

  function fmtMoney(n, cur) {
    var s = Math.abs(n) >= 1000 || Number.isInteger(n)
      ? Math.round(n).toLocaleString('en-US')
      : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return (cur ? cur + ' ' : '') + s;
  }
  function fmtHkd(n) { return 'HK$ ' + Math.round(n).toLocaleString('en-US'); }

  function unitLabel(u) { return u === 'day' ? '日' : u === 'year' ? '年' : '個月'; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 由開始日 + 存期計到期日
  function calcMaturity(startStr, num, unit) {
    if (!startStr || !num) return '';
    var p = startStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    num = +num;
    if (unit === 'day') d.setDate(d.getDate() + num);
    else if (unit === 'year') d.setFullYear(d.getFullYear() + num);
    else d.setMonth(d.getMonth() + num);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
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
    sorted.forEach(function (d) {
      totalHkd += toHkd(d);
      if (d.currency === 'HKD') hkdSum += +d.amount || 0; else usdSum += +d.amount || 0;
      var du = daysUntil(d.maturity);
      if (du != null && du < 0) over++;
      else if (du != null && du <= SOON_DAYS) soon++;
    });

    totalHkdEl.textContent = fmtHkd(totalHkd);
    countEl.textContent = sorted.length;
    soonCountEl.textContent = soon;
    var parts = [];
    if (usdSum) parts.push('美元本金合計：' + fmtMoney(usdSum, 'USD'));
    if (hkdSum) parts.push('港元本金合計：' + fmtMoney(hkdSum, 'HKD'));
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

    var meta = [];
    meta.push('<span class="k">到期：</span>' + esc(d.maturity || '—'));
    if (d.start) meta.push('<span class="k">開始：</span>' + esc(d.start));
    if (d.durNum) meta.push('<span class="k">存期：</span>' + esc(d.durNum) + ' ' + unitLabel(d.durUnit));
    if (d.note) meta.push('<span class="k">備註：</span>' + esc(d.note));

    return '<div class="' + cls + '">' +
      '<div class="row1">' +
        '<div class="bank">' + esc(d.bank) + '</div>' +
        '<div class="amt">' + fmtMoney(+d.amount || 0) + ' <small>' + esc(d.currency) + '</small></div>' +
      '</div>' +
      hkdLine +
      badge +
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
    if (id) {
      var d = deposits.find(function (x) { return x.id === id; });
      if (d) {
        sheetTitle.textContent = '編輯定期';
        $('editId').value = d.id;
        $('f_bank').value = d.bank || '';
        $('f_amount').value = d.amount != null ? d.amount : '';
        $('f_currency').value = d.currency || 'USD';
        $('f_maturity').value = d.maturity || '';
        $('f_start').value = d.start || '';
        $('f_durNum').value = d.durNum || '';
        $('f_durUnit').value = d.durUnit || 'month';
        $('f_note').value = d.note || '';
      }
    } else {
      sheetTitle.textContent = '新增定期';
    }
    sheetBack.classList.add('open');
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
    var payload = { app: 'fd-tracker', version: 1, exportedAt: new Date().toISOString(), rate: rate, deposits: deposits };
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
