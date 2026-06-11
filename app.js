const API_BASE = window.location.protocol === 'file:' ? 'http://127.0.0.1:5177' : '';
const MAX_RANGE_DAYS = 92;
const DEDUCTION_MULTIPLIER = 1; // 扣分折算乘數（預設 1 點扣 1 分）
let apiAvailable = true;

// 全域資料存放
const data = {
  employees: [],
  personalRecords: [],
  allTypes: [],
  // 靜態備份資料以防 API 無法連線
  fallbackEmployees: [
    { employee_code: '0688', employee_name: '陳怡靜', latest_position: '1組員' },
    { employee_code: '1024', employee_name: '陳○廷', latest_position: '1組員' },
    { employee_code: '1188', employee_name: '黃○瑄', latest_position: '3品保' },
    { employee_code: '1202', employee_name: '林○翔', latest_position: '4機台' }
  ],
  fallbackTypes: [
    { item_code: '2貼紙-3', jobs: '2', category: '標籤印製', subcategory: '標籤印製錯誤', points: -2, usage_count: 18, is_unused: false },
    { item_code: '2貼紙-4', jobs: '2', category: '標籤印製', subcategory: '標籤印製錯誤', points: -3, usage_count: 11, is_unused: false },
    { item_code: '4機台-2', jobs: '4', category: '作業準備與確認', subcategory: '未檢查首包', points: -1, usage_count: 0, is_unused: true },
    { item_code: '1組員-5', jobs: '1', category: '效率與團隊作業', subcategory: '未依規定時間內回到工作崗位', points: -1, usage_count: 0, is_unused: true },
    { item_code: '0全員-2', jobs: '0', category: '收尾與環境維護', subcategory: '工作區域未清理', points: -1, usage_count: 9, is_unused: false },
    { item_code: '0全員-1', jobs: '0', category: '安全與稽核規範', subcategory: '使用拖板車，未依規定操作', points: -1, usage_count: 0, is_unused: true }
  ],
  fallbackRecords: [
    {
      event_date: '2026-06-05',
      employee_name: '陳怡靜',
      employee_code: '0688',
      employee_position: '1組員',
      item_code: '0全員-8',
      category: '效率與團隊作業',
      subcategory: '因重工導致耽誤該排程效率',
      notes: '做PLB洋菇（領料）把第一第二盒被包和第三盒被包放到一起未跟收箱人員和工主對人員講，導致第二筆履歷另一張收箱人員不曉得以為是收箱有誤。',
      points: -1
    }
  ]
};

const state = {
  selectedEmployee: null, // { employee_code, employee_name, latest_position }
  startDate: '',
  endDate: '',
  assessmentRole: 'crew', // 'crew' (1200) | 'machine' (1800)
  handbookJob: 'all'
};


// ── 日期輔助工具 ─────────────────────────────
function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseInputDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function enforceThreeMonthRange(startId, endId) {
  const startEl = document.getElementById(startId);
  const endEl = document.getElementById(endId);
  if (!startEl || !endEl) return;
  const start = parseInputDate(startEl.value);
  const end = parseInputDate(endEl.value);
  if (!start || !end) return;

  const diffDays = Math.floor((end.getTime() - start.getTime()) / 86400000);
  if (diffDays <= MAX_RANGE_DAYS) return;

  // 超過三個月則自動將開始日期向後縮短至 92 天前
  const adjusted = new Date(end);
  adjusted.setDate(adjusted.getDate() - MAX_RANGE_DAYS);
  startEl.value = formatDateInput(adjusted);
  state.startDate = startEl.value;
}

function initializeDateRangeDefault() {
  const startEl = document.getElementById('date-start-query');
  const endEl = document.getElementById('date-end-query');
  if (!startEl || !endEl) return;
  if (startEl.value || endEl.value) return;

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - MAX_RANGE_DAYS);
  startEl.value = formatDateInput(start);
  endEl.value = formatDateInput(end);
  state.startDate = startEl.value;
  state.endDate = endEl.value;
}

// ── HTTP API 串接 ──────────────────────────────
function toQuery(params) {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === null || v === undefined || v === '' || v === 'all') return;
    sp.set(k, String(v));
  });
  const q = sp.toString();
  return q ? `?${q}` : '';
}

async function fetchJson(path, params = {}) {
  const res = await fetch(`${API_BASE}${path}${toQuery(params)}`);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

async function loadEmployees() {
  try {
    const res = await fetchJson('/api/v1/employees');
    data.employees = res.items || [];
    apiAvailable = true;
  } catch (error) {
    apiAvailable = false;
    data.employees = data.fallbackEmployees;
    console.warn('無法連線後端 API 取得員工名單，已載入靜態測試名單。', error);
  }
  populateEmployeesDatalist();
}

async function loadPersonalRecords() {
  try {
    const params = {};
    if (state.selectedEmployee) {
      params.employee_code = state.selectedEmployee.employee_code;
      params.start_date = state.startDate;
      params.end_date = state.endDate;
      params.limit = 150;
    } else {
      params.limit = 100;
    }
    const res = await fetchJson('/api/v1/records', params);
    data.personalRecords = res.items || [];
    apiAvailable = true;
  } catch (error) {
    apiAvailable = false;
    if (state.selectedEmployee) {
      data.personalRecords = data.fallbackRecords.filter(r =>
        r.employee_code === state.selectedEmployee.employee_code &&
        (!state.startDate || r.event_date >= state.startDate) &&
        (!state.endDate || r.event_date <= state.endDate)
      );
    } else {
      data.personalRecords = data.fallbackRecords;
    }
    console.warn('無法連線後端 API 取得記點明細，已載入靜態備用記錄。', error);
  }
}

async function loadHandbookTypes() {
  try {
    const res = await fetchJson('/api/v1/types', { include_unused: true });
    data.allTypes = res.items || [];
    apiAvailable = true;
  } catch (error) {
    apiAvailable = false;
    data.allTypes = data.fallbackTypes;
    console.warn('無法連線後端 API 取得規章手冊，已載入靜態備用規章。', error);
  }
}

// ── UI 渲染邏輯 ──────────────────────────────────
function renderItemSummaryChart(items, emptyMessage) {
  const chart = document.getElementById('item-summary-chart');
  const badge = document.getElementById('item-summary-count-badge');
  if (!chart) return;

  if (!items || items.length === 0) {
    chart.innerHTML = `<p class="muted" style="text-align:center;padding:40px 0;">${emptyMessage}</p>`;
    badge.textContent = '0 種細項';
    return;
  }

  badge.textContent = `${items.length} 種細項`;
  const maxCount = Math.max(...items.map(i => i.count));
  const maxDed = Math.max(...items.map(i => i.totalDeduction));

  chart.innerHTML = items.map(item => {
    const catLabel = item.category || '其他';
    const cPct = maxCount > 0 ? (item.count / maxCount * 100).toFixed(1) : 0;
    const dPct = maxDed > 0 ? (item.totalDeduction / maxDed * 100).toFixed(1) : 0;
    return `
      <div class="item-bar-row">
        <div class="item-bar-label">
          <span class="pill gray">${catLabel}</span>
          <strong>${item.item_code}</strong>
          <span class="muted">${item.subcategory}</span>
        </div>
        <div class="item-bar-tracks">
          <div class="item-bar-line">
            <span class="item-bar-key">次數</span>
            <div class="item-bar-bg">
              <div class="item-bar-inner item-bar-inner--count" data-w="${cPct}" style="width:0%"></div>
            </div>
            <span class="item-bar-val">${item.count} 次</span>
          </div>
          <div class="item-bar-line">
            <span class="item-bar-key">扣分</span>
            <div class="item-bar-bg">
              <div class="item-bar-inner item-bar-inner--ded" data-w="${dPct}" style="width:0%"></div>
            </div>
            <span class="item-bar-val" style="color:var(--danger);">-${item.totalDeduction}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  requestAnimationFrame(() => {
    chart.querySelectorAll('.item-bar-inner').forEach(el => {
      el.style.width = el.dataset.w + '%';
    });
  });
}

function populateEmployeesDatalist() {
  const datalist = document.getElementById('employees-list');
  if (!datalist) return;
  datalist.innerHTML = data.employees.map(emp =>
    `<option value="${emp.employee_name} (${emp.employee_code})" data-code="${emp.employee_code}"></option>`
  ).join('');
}

function renderQueryPanel() {
  const deductionSummaryContent = document.getElementById('deduction-summary-content');
  const personalRecordsBody = document.getElementById('personal-records-body');
  const recordCountBadge = document.getElementById('record-count-badge');
  const recordsMetaText = document.getElementById('records-meta-text');

  const isPersonal = state.selectedEmployee !== null;

  // 動態更新記錄表格表頭（依是否為個人查詢決定是否顯示人員欄）
  const recordsThead = document.getElementById('records-thead');
  if (recordsThead) {
    recordsThead.innerHTML = `
      <tr>
        <th style="white-space: nowrap;">日期</th>
        ${isPersonal ? '' : '<th style="white-space: nowrap;">人員</th>'}
        <th style="white-space: nowrap;">考核維度</th>
        <th style="white-space: nowrap;">記點細項</th>
        <th>備註事由</th>
        <th style="white-space: nowrap; text-align: center;">扣點</th>
      </tr>
    `;
  }

  if (!isPersonal) {
    recordsMetaText.textContent = '顯示全體最新 100 筆的實際記點紀錄。';

    deductionSummaryContent.innerHTML = `
      <div class="total-score-display" style="color: var(--muted); font-size: 42px;">—</div>
      <p style="margin: 12px 0 0; font-size: 15px; font-weight: 800; color: var(--muted);">請輸入姓名或工號開始查詢</p>
    `;

    renderItemSummaryChart(null, '請選擇組員查詢記點細項統整。');
  } else {
    recordsMetaText.textContent = `顯示 ${state.selectedEmployee.employee_name} (${state.selectedEmployee.employee_code}) 的記點記錄。`;

    const totalCount = data.personalRecords.length;
    const totalDeduction = data.personalRecords.reduce((sum, r) => sum + Math.abs(Number(r.points || 0)) * DEDUCTION_MULTIPLIER, 0);

    if (totalCount === 0) {
      deductionSummaryContent.innerHTML = `
        <div class="total-score-display" style="color: var(--accent-2);">0<span class="total-score-max"> 次</span></div>
        <p style="margin: 12px 0 0; font-size: 15px; font-weight: 800; color: var(--accent-2);">此區間無任何記點扣分紀錄</p>
      `;
      renderItemSummaryChart([], '此查詢區間內無任何記點扣分紀錄。');
    } else {
      // 找出最常發生細項
      const itemCountMap = {};
      data.personalRecords.forEach(r => {
        const key = r.item_code || r.subcategory || '未知';
        itemCountMap[key] = (itemCountMap[key] || 0) + 1;
      });
      const topEntry = Object.entries(itemCountMap).sort((a, b) => b[1] - a[1])[0];

      deductionSummaryContent.innerHTML = `
        <div class="total-score-display" style="color: var(--danger);">
          ${totalCount}<span class="total-score-max"> 次</span>
        </div>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted);">共扣 <strong style="color: var(--danger);">-${totalDeduction} 點</strong></p>
        <p style="margin: 16px 0 0; font-size: 12px; color: var(--muted); font-weight: 700; letter-spacing: 0.05em;">最常發生細項</p>
        <p style="margin: 4px 0 0; font-size: 14px; font-weight: 800; color: var(--accent);">${topEntry ? `${topEntry[0]}（${topEntry[1]} 次）` : '—'}</p>
      `;

      // 依記點細項彙整
      const itemMap = {};
      data.personalRecords.forEach(r => {
        const key = r.item_code || r.subcategory || '未知';
        if (!itemMap[key]) {
          itemMap[key] = {
            item_code: r.item_code || '—',
            subcategory: r.subcategory || '—',
            category: r.category || '其他',
            count: 0,
            totalDeduction: 0
          };
        }
        itemMap[key].count += 1;
        itemMap[key].totalDeduction += Math.abs(Number(r.points || 0)) * DEDUCTION_MULTIPLIER;
      });

      const items = Object.values(itemMap).sort((a, b) => b.totalDeduction - a.totalDeduction || b.count - a.count);

      renderItemSummaryChart(items, null);
    }
  }

  // 渲染個人記點明細表格
  const listRows = data.personalRecords.map(rec => {
    const date = rec.event_date ? String(rec.event_date).slice(0, 10) : '-';
    const pts = Number(rec.points || 0);
    const catLabel = rec.category || '其他';
    const notes = rec.notes && rec.notes.trim() ? rec.notes : '無備註事由';
    const who = `${rec.employee_name || '未填'} (${rec.employee_code || ''})`;
    const whoHtml = isPersonal ? '' : `<td><strong>${who}</strong><br/><span class="muted" style="font-size:12px;">${rec.employee_position || '未填'}</span></td>`;

    return `
      <tr>
        <td>${date}</td>
        ${whoHtml}
        <td><span class="pill gray">${catLabel}</span></td>
        <td><strong>${rec.item_code || '-'}</strong><br/><span class="muted" style="font-size:12px;">${rec.subcategory || '-'}</span></td>
        <td style="font-size:14px; max-width: 400px; word-break: break-all;">${notes}</td>
        <td style="text-align: center; font-weight:800; color:var(--danger);">${pts} 點</td>
      </tr>
    `;
  });

  if (listRows.length > 0) {
    personalRecordsBody.innerHTML = listRows.join('');
  } else {
    personalRecordsBody.innerHTML = `<tr><td colspan="${isPersonal ? 5 : 6}" class="muted" style="text-align: center; padding: 40px 0;">在此查詢區間內，無任何記點扣分紀錄。</td></tr>`;
  }

  recordCountBadge.textContent = `${listRows.length} 筆記錄`;
}

function renderHandbook() {
  // 獲取各分類 tbody 的 DOM
  const bodies = {
    0: document.getElementById('handbook-job0-body'),
    1: document.getElementById('handbook-job1-body'),
    2: document.getElementById('handbook-job2-body'),
    3: document.getElementById('handbook-job3-body'),
    4: document.getElementById('handbook-job4-body'),
    5: document.getElementById('handbook-job5-body'),
    6: document.getElementById('handbook-job6-body')
  };

  // 獲取各分類筆數 badge 的 DOM
  const counts = {
    0: document.getElementById('handbook-job0-count'),
    1: document.getElementById('handbook-job1-count'),
    2: document.getElementById('handbook-job2-count'),
    3: document.getElementById('handbook-job3-count'),
    4: document.getElementById('handbook-job4-count'),
    5: document.getElementById('handbook-job5-count'),
    6: document.getElementById('handbook-job6-count')
  };

  // 初始化各組的 rows 陣列
  const groups = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

  // 將 allTypes 分群
  data.allTypes.forEach(t => {
    const jobVal = parseInt(t.jobs, 10);
    let targetGroup = null;

    if (jobVal === 0) {
      targetGroup = 0;
    } else if (jobVal === 1) {
      targetGroup = 1;
    } else if (jobVal === 2) {
      targetGroup = 2;
    } else if (jobVal === 3) {
      targetGroup = 3;
    } else if (jobVal === 4) {
      targetGroup = 4;
    } else if (jobVal === 5) {
      targetGroup = 5;
    } else if (jobVal === 6) {
      targetGroup = 6;
    }

    if (targetGroup !== null) {
      const pts = Number(t.points || 0);
      const rowHtml = `
        <tr>
          <td style="padding-left: 8px; font-weight:700;">${t.item_code}</td>
          <td><strong>${t.subcategory}</strong><br/><span class="muted" style="font-size:12px;">分類: ${t.category}</span></td>
          <td style="text-align: center; padding-right: 8px; font-weight:800; color:var(--accent); white-space:nowrap;">${pts} 點</td>
        </tr>
      `;
      groups[targetGroup].push(rowHtml);
    }
  });

  // 渲染各組表格與更新筆數
  const emptyTemplate = `<tr><td colspan="3" class="muted" style="text-align: center; padding: 20px 0;">此分類下無規章條款。</td></tr>`;

  Object.keys(bodies).forEach(groupKey => {
    const bodyEl = bodies[groupKey];
    const countEl = counts[groupKey];
    if (bodyEl) {
      bodyEl.innerHTML = groups[groupKey].join('') || emptyTemplate;
    }
    if (countEl) {
      countEl.textContent = `${groups[groupKey].length} 筆條款`;
    }
  });
}

function renderAll() {
  renderQueryPanel();
  renderHandbook();
}

// ── 事件處理與綁定 ─────────────────────────────
function bindEvents() {
  // 1. 頁面切換導覽
  const navButtons = Array.from(document.querySelectorAll('.nav button'));
  const panels = Array.from(document.querySelectorAll('.panel'));
  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      navButtons.forEach(item => item.classList.toggle('active', item === btn));
      panels.forEach(panel => panel.classList.toggle('active', panel.id === target));
      // 切換至規章手冊時，確保有渲染
      if (target === 'handbook-panel') {
        renderHandbook();
      }
    });
  });

  // 2. 人員搜尋輸入監聽與清除機制
  const empSearchInput = document.getElementById('employee-search');
  const clearSearchBtn = document.getElementById('clear-employee-search');

  function updateClearBtnVisibility() {
    if (empSearchInput.value.trim().length > 0) {
      clearSearchBtn.style.display = 'block';
    } else {
      clearSearchBtn.style.display = 'none';
    }
  }

  // 點擊或聚焦時自動全選文字，方便直接輸入下一個人而不用手動刪除
  empSearchInput.addEventListener('focus', () => empSearchInput.select());
  empSearchInput.addEventListener('click', () => empSearchInput.select());

  empSearchInput.addEventListener('input', () => {
    updateClearBtnVisibility();
    const val = empSearchInput.value.trim();
    // 檢查是否符合名單中的 "員工名 (工號)" 格式
    const matched = data.employees.find(emp =>
      `${emp.employee_name} (${emp.employee_code})` === val || emp.employee_code === val
    );

    if (matched) {
      state.selectedEmployee = matched;

      // 自動識別身分標準
      const pos = String(matched.latest_position || '');
      if (pos.includes('機台') || pos.includes('4')) {
        state.assessmentRole = 'machine';
      } else {
        state.assessmentRole = 'crew';
      }
      syncRoleToggleUI();

      // 重新載入明細並渲染
      loadPersonalRecords().then(renderQueryPanel);
    } else if (val === '') {
      state.selectedEmployee = null;
      loadPersonalRecords().then(renderQueryPanel);
    }
  });

  // 監聽變更事件以處理複製貼上或清空
  empSearchInput.addEventListener('change', () => {
    updateClearBtnVisibility();
    if (empSearchInput.value.trim() === '') {
      state.selectedEmployee = null;
      loadPersonalRecords().then(renderQueryPanel);
    }
  });

  // 點擊一鍵清除按鈕
  clearSearchBtn.addEventListener('click', () => {
    empSearchInput.value = '';
    state.selectedEmployee = null;
    updateClearBtnVisibility();
    loadPersonalRecords().then(renderQueryPanel);
    empSearchInput.focus();
  });

  // 3. 身分標準切換按鈕
  const roleCrewBtn = document.getElementById('role-crew-btn');
  const roleMachineBtn = document.getElementById('role-machine-btn');

  roleCrewBtn.addEventListener('click', () => {
    state.assessmentRole = 'crew';
    syncRoleToggleUI();
    renderQueryPanel();
  });

  roleMachineBtn.addEventListener('click', () => {
    state.assessmentRole = 'machine';
    syncRoleToggleUI();
    renderQueryPanel();
  });

  function syncRoleToggleUI() {
    roleCrewBtn.classList.toggle('active', state.assessmentRole === 'crew');
    roleMachineBtn.classList.toggle('active', state.assessmentRole === 'machine');
  }

  // 4. 日期區間變更監聽
  const dateStartInput = document.getElementById('date-start-query');
  const dateEndInput = document.getElementById('date-end-query');

  [dateStartInput, dateEndInput].forEach(el => {
    el.addEventListener('change', () => {
      enforceThreeMonthRange('date-start-query', 'date-end-query');
      state.startDate = dateStartInput.value;
      state.endDate = dateEndInput.value;
      loadPersonalRecords().then(renderQueryPanel);
    });
  });

  // 5. 規章手冊職位篩選已移除，改為 7 大分類折疊面板同時展示
}

// ── 初始化啟動 ───────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  initializeDateRangeDefault();
  bindEvents();

  // 先載入員工與規章列表，並載入最新記點紀錄
  await Promise.all([
    loadEmployees(),
    loadHandbookTypes(),
    loadPersonalRecords()
  ]);

  renderAll();
});
