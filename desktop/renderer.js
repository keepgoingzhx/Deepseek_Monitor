const bridge = window.deepseekMonitor;

const elements = {
  apiDot: document.querySelector("#apiDot"),
  compactWidgetBtn: document.querySelector("#compactWidgetBtn"),
  compactTokens: document.querySelector("#compactTokens"),
  compactBtn: document.querySelector("#compactBtn"),
  settingsBtn: document.querySelector("#settingsBtn"),
  minimizeBtn: document.querySelector("#minimizeBtn"),
  closeBtn: document.querySelector("#closeBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  todayTokens: document.querySelector("#todayTokens"),
  todayTokensFull: document.querySelector("#todayTokensFull"),
  todayPromptTokens: document.querySelector("#todayPromptTokens"),
  todayOutputTokens: document.querySelector("#todayOutputTokens"),
  todayCacheTokens: document.querySelector("#todayCacheTokens"),
  monthTokens: document.querySelector("#monthTokens"),
  todayRequests: document.querySelector("#todayRequests"),
  balanceValue: document.querySelector("#balanceValue"),
  apiStatus: document.querySelector("#apiStatus"),
  apiUrl: document.querySelector("#apiUrl"),
  operationStatus: document.querySelector("#operationStatus"),
  copyApiBtn: document.querySelector("#copyApiBtn"),
  openUsagePageMainBtn: document.querySelector("#openUsagePageMainBtn"),
  syncUsagePageBtn: document.querySelector("#syncUsagePageBtn"),
  autoExportBtn: document.querySelector("#autoExportBtn"),
  chartPanel: document.querySelector(".chart-panel"),
  chartEmpty: document.querySelector("#chartEmpty"),
  barChart: document.querySelector("#barChart"),
  usageList: document.querySelector("#usageList"),
  dataRange: document.querySelector("#dataRange"),
  lastUsage: document.querySelector("#lastUsage"),
  settingsPanel: document.querySelector("#settingsPanel"),
  settingsCloseBtn: document.querySelector("#settingsCloseBtn"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  rememberKeyInput: document.querySelector("#rememberKeyInput"),
  alwaysOnTopInput: document.querySelector("#alwaysOnTopInput"),
  openAtLoginInput: document.querySelector("#openAtLoginInput"),
  compactModeInput: document.querySelector("#compactModeInput"),
  portInput: document.querySelector("#portInput"),
  refreshIntervalInput: document.querySelector("#refreshIntervalInput"),
  baseUrlInput: document.querySelector("#baseUrlInput"),
  saveSettingsBtn: document.querySelector("#saveSettingsBtn"),
  importCsvBtn: document.querySelector("#importCsvBtn"),
  resetUsageBtn: document.querySelector("#resetUsageBtn"),
  settingsStatus: document.querySelector("#settingsStatus"),
  petWhale: document.querySelector("#petWhale"),
  petBadge: document.querySelector("#petBadge"),
  petTokens: document.querySelector("#petTokens")
};

let snapshot = null;
let prevTokenValue = null;

function snapshotKey(data) {
  const daily = data.dailyUsage || [];
  return JSON.stringify({
    d: daily,
    b: data.balance,
    l: data.lastBalanceCheckedAt,
    r: (data.runtime || {}).running,
    p: (data.runtime || {}).port,
    e: (data.runtime || {}).error
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  snapshot = await bridge.getSnapshot();
  render(snapshot);
  bridge.onSnapshot((next) => {
    if (snapshotKey(snapshot) === snapshotKey(next)) {
      snapshot = next;
      return;
    }
    snapshot = next;
    render(next);
  });
});

function bindEvents() {
  elements.compactWidgetBtn.addEventListener("click", () => setCompactMode(false));
  elements.compactBtn.addEventListener("click", () => setCompactMode(true));

  if (elements.petWhale) {
    elements.petWhale.addEventListener("click", (e) => e.stopPropagation());
  }
  elements.settingsBtn.addEventListener("click", openSettings);
  elements.settingsCloseBtn.addEventListener("click", closeSettings);
  elements.minimizeBtn.addEventListener("click", () => bridge.minimize());
  elements.closeBtn.addEventListener("click", () => bridge.close());
  elements.refreshBtn.addEventListener("click", refreshBalance);
  elements.copyApiBtn.addEventListener("click", importCsv);
  elements.openUsagePageMainBtn.addEventListener("click", openUsagePage);
  elements.syncUsagePageBtn.addEventListener("click", syncUsagePage);
  elements.autoExportBtn.addEventListener("click", autoExport);
  elements.saveSettingsBtn.addEventListener("click", saveSettings);
  elements.importCsvBtn.addEventListener("click", importCsv);
  elements.resetUsageBtn.addEventListener("click", resetUsage);
}

function render(data) {
  const normalized = {
    ...data,
    dailyUsage: sortDaily(data.dailyUsage || [])
  };

  renderSettings(normalized);
  renderRuntime(normalized);
  renderMetrics(normalized);
  renderChart(normalized.dailyUsage);
  renderUsageList(normalized.dailyUsage);
  document.body.classList.toggle("compact-mode", Boolean(normalized.settings && normalized.settings.compactMode));

  if (normalized.lastImportStatus) {
    setStatus(normalized.lastImportStatus);
  }
}

function renderSettings(data) {
  const settings = data.settings || {};
  elements.rememberKeyInput.checked = Boolean(settings.rememberKey);
  elements.alwaysOnTopInput.checked = Boolean(settings.alwaysOnTop);
  elements.openAtLoginInput.checked = Boolean(settings.openAtLogin);
  elements.compactModeInput.checked = Boolean(settings.compactMode);
  elements.portInput.value = settings.port || 8787;
  elements.refreshIntervalInput.value = settings.refreshIntervalSec || 3;
  elements.baseUrlInput.value = settings.baseUrl || "https://api.deepseek.com";

  if (settings.hasApiKey && !elements.apiKeyInput.value) {
    elements.apiKeyInput.placeholder = settings.apiKeyStorage === "encrypted" ? "已加密保存" : "已保存";
  }
}

function renderRuntime(data) {
  const runtime = data.runtime || {};
  const settings = data.settings || {};
  const hasError = Boolean(runtime.error);

  elements.apiDot.classList.toggle("on", !hasError);
  elements.apiStatus.textContent = hasError
    ? `用量爬取异常：${runtime.error}`
    : "已连接 DeepSeek 登录态用量接口";

  if (data.summary && data.summary.days) {
    elements.apiUrl.textContent = `后台每 30 分钟自动爬取；界面每 ${settings.refreshIntervalSec || 60} 秒刷新；最新日期 ${data.summary.lastDate || "--"}`;
  } else {
    elements.apiUrl.textContent = "点击登录并完成 DeepSeek 登录后会自动同步；同步成功后后台每 30 分钟更新";
  }
}

function renderMetrics(data) {
  const summary = data.summary || {};
  const daily = data.dailyUsage || [];
  const todayItem = daily.find((item) => item.date === summary.today) || null;
  const latestUsed = [...daily].reverse().find((item) => hasUsage(item)) || null;
  const balanceItem = Array.isArray(data.balance && data.balance.balance_infos)
    ? data.balance.balance_infos[0]
    : null;

  const todayTokens = todayItem ? Number(todayItem.totalTokens) || 0 : 0;
  elements.todayTokens.textContent = formatCompact(todayTokens);

  if (elements.petTokens) {
    elements.petTokens.textContent = formatCompact(todayTokens);
    if (prevTokenValue !== null && prevTokenValue !== todayTokens) {
      elements.petBadge.classList.remove("pop");
      void elements.petBadge.offsetWidth;
      elements.petBadge.classList.add("pop");
      setTimeout(() => elements.petBadge.classList.remove("pop"), 400);
    }
    prevTokenValue = todayTokens;
  }
  elements.todayTokensFull.textContent = `${formatNumber(todayTokens)} tokens`;
  elements.todayPromptTokens.textContent = formatCompact(todayItem ? todayItem.promptTokens : 0);
  elements.todayOutputTokens.textContent = formatCompact(todayItem ? todayItem.completionTokens : 0);
  elements.todayCacheTokens.textContent = formatCompact(todayItem ? todayItem.cacheHitTokens : 0);
  elements.monthTokens.textContent = formatCompact(summary.monthTokens || 0);
  elements.todayRequests.textContent = formatNumber(summary.todayRequests || 0);

  if (Number.isFinite(Number(summary.monthCost))) {
    elements.balanceValue.textContent = formatCurrency(summary.monthCost);
  } else if (balanceItem) {
    elements.balanceValue.textContent = formatBalance(balanceItem.total_balance, balanceItem.currency);
  } else {
    elements.balanceValue.textContent = "¥0.00";
  }

  elements.lastUsage.textContent = latestUsed
    ? `最近有消耗：${formatDateLabel(latestUsed.date)}，${formatNumber(latestUsed.totalTokens)} tokens`
    : "暂无请求";
  elements.dataRange.textContent = summary.days ? `${summary.firstDate} 至 ${summary.lastDate}` : "--";
}

function renderChart(daily) {
  const recent = daily.filter(hasUsage).slice(-14);
  if (!recent.length) {
    elements.chartPanel.classList.add("empty");
    elements.barChart.innerHTML = "";
    elements.barChart.style.gridTemplateColumns = "";
    return;
  }

  elements.chartPanel.classList.remove("empty");
  const max = Math.max(...recent.map((item) => Number(item.totalTokens) || 0), 1);
  elements.barChart.style.gridTemplateColumns = `repeat(${recent.length}, minmax(0, 1fr))`;
  elements.barChart.innerHTML = recent.map((item, index) => {
    const tokens = Number(item.totalTokens) || 0;
    const height = Math.max(tokens ? 8 : 0, Math.round((tokens / max) * 100));
    const title = `${item.date}: ${formatNumber(tokens)} tokens`;
    const dateParts = formatChartDate(item.date);
    const prevMonth = index > 0 ? formatChartDate(recent[index - 1].date).month : "";
    const showMonth = dateParts.month !== prevMonth;
    const label = showMonth ? `${dateParts.month}月` : dateParts.day;
    return `
      <div class="bar-item" title="${escapeHtml(title)}">
        <div class="bar-track"><span style="height:${height}%"></span></div>
        <span class="bar-label"><b>${escapeHtml(label)}</b></span>
      </div>
    `;
  }).join("");
}

function renderUsageList(daily) {
  const rows = daily.filter(hasUsage).slice(-10).reverse();

  if (!rows.length) {
    elements.usageList.innerHTML = '<div class="empty-row">暂无每日用量。点击登录并完成 DeepSeek 登录后，插件会自动同步用量。</div>';
    return;
  }

  const maxTokens = Math.max(...rows.map((item) => Number(item.totalTokens) || 0), 1);

  elements.usageList.innerHTML = rows.map((item) => {
    const total = Number(item.totalTokens) || 0;
    const prompt = Number(item.promptTokens) || 0;
    const output = Number(item.completionTokens) || 0;
    const cacheHit = Number(item.cacheHitTokens) || 0;
    const cacheMiss = Number(item.cacheMissTokens) || 0;
    const requests = Number(item.requests) || 0;
    const cost = Number(item.cost) || 0;
    const percent = Math.max(total ? 5 : 0, Math.round((total / maxTokens) * 100));

    return `
      <article class="usage-row">
        <div class="usage-row-head">
          <div>
            <strong>${escapeHtml(formatDateLabel(item.date))}</strong>
            <span>${escapeHtml(item.date)}</span>
          </div>
          <span class="row-cost">${cost ? escapeHtml(formatCurrency(cost)) : "费用 --"}</span>
        </div>
        <div class="daily-token-total">
          <span>daily tokens</span>
          <strong>${escapeHtml(formatNumber(total))} <em>tokens</em></strong>
        </div>
        <div class="usage-meter" aria-hidden="true"><span style="width:${percent}%"></span></div>
        <div class="usage-breakdown-row">
          <span><small>input</small><b>${escapeHtml(formatNumber(prompt))}</b></span>
          <span><small>output</small><b>${escapeHtml(formatNumber(output))}</b></span>
          <span><small>cache hit</small><b>${escapeHtml(formatNumber(cacheHit))}</b></span>
          <span><small>cache miss</small><b>${escapeHtml(formatNumber(cacheMiss))}</b></span>
          <span><small>requests</small><b>${escapeHtml(formatNumber(requests))}</b></span>
        </div>
      </article>
    `;
  }).join("");
}

async function setCompactMode(compactMode) {
  try {
    snapshot = await bridge.setCompactMode(compactMode);
    render(snapshot);
  } catch (error) {
    setStatus(error.message || "切换桌面按钮失败。", "error");
  }
}

function openSettings() {
  elements.settingsPanel.classList.add("open");
  elements.settingsPanel.setAttribute("aria-hidden", "false");
}

function closeSettings() {
  elements.settingsPanel.classList.remove("open");
  elements.settingsPanel.setAttribute("aria-hidden", "true");
}

async function refreshBalance() {
  setStatus("正在同步用量...");
  try {
    const syncResult = await bridge.syncUsagePage();
    snapshot = syncResult.snapshot;
    render(snapshot);
    try {
      snapshot = await bridge.refreshBalance();
      render(snapshot);
    } catch {}
    setStatus(syncResult.ok ? "已同步并刷新。" : (syncResult.message || "同步完成。"), syncResult.ok ? "success" : "error");
  } catch (error) {
    setStatus(error.message || "同步失败。", "error");
  }
}

async function saveSettings() {
  setStatus("正在保存...");
  try {
    snapshot = await bridge.saveSettings({
      apiKey: elements.apiKeyInput.value,
      rememberKey: elements.rememberKeyInput.checked,
      alwaysOnTop: elements.alwaysOnTopInput.checked,
      openAtLogin: elements.openAtLoginInput.checked,
      compactMode: elements.compactModeInput.checked,
      port: Number(elements.portInput.value),
      baseUrl: elements.baseUrlInput.value,
      refreshIntervalSec: Number(elements.refreshIntervalInput.value)
    });
    elements.apiKeyInput.value = "";
    snapshot = await bridge.setCompactMode(elements.compactModeInput.checked);
    render(snapshot);
    setStatus("已保存。", "success");
  } catch (error) {
    setStatus(error.message || "保存失败。", "error");
  }
}

async function importCsv() {
  setStatus("请选择 CSV 或 ZIP...");
  try {
    const result = await bridge.importCsv();
    snapshot = result.snapshot;
    render(snapshot);
    setStatus(result.canceled ? "已取消导入。" : "文件已导入。", result.canceled ? "" : "success");
  } catch (error) {
    setStatus(error.message || "导入失败。", "error");
  }
}

async function openUsagePage() {
  setStatus("已打开 DeepSeek 登录页。");
  try {
    snapshot = await bridge.openUsagePage();
    render(snapshot);
  } catch (error) {
    setStatus(error.message || "打开登录页失败。", "error");
  }
}

async function syncUsagePage() {
  setStatus("正在同步 DeepSeek 用量...");
  try {
    const result = await bridge.syncUsagePage();
    snapshot = result.snapshot;
    render(snapshot);
    setStatus(result.message || "同步完成。", result.ok ? "success" : "error");
  } catch (error) {
    setStatus(error.message || "同步失败。", "error");
  }
}

async function autoExport() {
  setStatus("正在尝试导出...");
  try {
    const result = await bridge.autoExport();
    snapshot = result.snapshot;
    render(snapshot);
    setStatus(result.message || "已触发导出。", result.ok ? "success" : "error");
  } catch (error) {
    setStatus(error.message || "自动导出失败。", "error");
  }
}

async function resetUsage() {
  setStatus("正在清空...");
  try {
    snapshot = await bridge.resetUsage();
    render(snapshot);
    setStatus("用量已清空。", "success");
  } catch (error) {
    setStatus(error.message || "清空失败。", "error");
  }
}

function setStatus(message, type) {
  const text = message || "";
  elements.settingsStatus.textContent = text;
  elements.operationStatus.textContent = text;
  [elements.settingsStatus, elements.operationStatus].forEach((element) => {
    element.classList.remove("error", "success");
    if (type) {
      element.classList.add(type);
    }
  });
}

function sortDaily(daily) {
  return [...daily].sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")));
}

function hasUsage(item) {
  return Boolean(item && (Number(item.totalTokens) || Number(item.cost) || Number(item.requests)));
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(Number(value) || 0));
}

function formatCompact(value) {
  const number = Math.round(Number(value) || 0);
  return new Intl.NumberFormat("zh-CN", {
    notation: number >= 100000 ? "compact" : "standard",
    maximumFractionDigits: 1
  }).format(number);
}

function formatBalance(value, currency) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value || "--");
  }
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(number)} ${currency || ""}`.trim();
}

function formatCurrency(value) {
  return `¥${new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value) || 0)}`;
}

function formatDateLabel(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value || "--";
  }
  return date.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric"
  });
}

function formatChartDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    const fallback = String(value || "--").slice(5).split(/[-/]/);
    return {
      month: fallback[0] || "--",
      day: fallback[1] || "--"
    };
  }
  return {
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(date.getDate()).padStart(2, "0")
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
