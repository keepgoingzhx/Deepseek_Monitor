const storage = (() => {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    return {
      get(keys) {
        return new Promise((resolve, reject) => {
          chrome.storage.local.get(keys, (result) => {
            const error = chrome.runtime && chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve(result);
          });
        });
      },
      set(values) {
        return new Promise((resolve, reject) => {
          chrome.storage.local.set(values, () => {
            const error = chrome.runtime && chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve();
          });
        });
      },
      remove(keys) {
        return new Promise((resolve, reject) => {
          chrome.storage.local.remove(keys, () => {
            const error = chrome.runtime && chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            resolve();
          });
        });
      }
    };
  }

  return {
    async get(keys) {
      const result = {};
      keys.forEach((key) => {
        const value = localStorage.getItem(key);
        result[key] = value ? JSON.parse(value) : undefined;
      });
      return result;
    },
    async set(values) {
      Object.entries(values).forEach(([key, value]) => {
        localStorage.setItem(key, JSON.stringify(value));
      });
    },
    async remove(keys) {
      keys.forEach((key) => localStorage.removeItem(key));
    }
  };
})();

const STORAGE_KEYS = {
  daily: "deepseekUsageDaily",
  meta: "deepseekUsageMeta",
  apiKey: "deepseekApiKey"
};

const elements = {
  apiKeyInput: document.querySelector("#apiKeyInput"),
  rememberKeyInput: document.querySelector("#rememberKeyInput"),
  balanceBtn: document.querySelector("#balanceBtn"),
  clearKeyBtn: document.querySelector("#clearKeyBtn"),
  balanceStatus: document.querySelector("#balanceStatus"),
  balanceList: document.querySelector("#balanceList"),
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  clearUsageBtn: document.querySelector("#clearUsageBtn"),
  importMeta: document.querySelector("#importMeta"),
  importStatus: document.querySelector("#importStatus"),
  todayTokens: document.querySelector("#todayTokens"),
  monthTokens: document.querySelector("#monthTokens"),
  monthFlashTokens: document.querySelector("#monthFlashTokens"),
  monthProTokens: document.querySelector("#monthProTokens"),
  latestTokens: document.querySelector("#latestTokens"),
  latestDate: document.querySelector("#latestDate"),
  dataRange: document.querySelector("#dataRange"),
  chartPanel: document.querySelector(".chart-panel"),
  barChart: document.querySelector("#barChart"),
  usageTableBody: document.querySelector("#usageTableBody")
};

let dailyUsage = [];
let meta = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const saved = await storage.get([STORAGE_KEYS.daily, STORAGE_KEYS.meta, STORAGE_KEYS.apiKey]);
  dailyUsage = Array.isArray(saved[STORAGE_KEYS.daily]) ? saved[STORAGE_KEYS.daily] : [];
  meta = saved[STORAGE_KEYS.meta] || null;

  if (saved[STORAGE_KEYS.apiKey]) {
    elements.apiKeyInput.value = saved[STORAGE_KEYS.apiKey];
    elements.rememberKeyInput.checked = true;
  }

  bindEvents();
  renderAll();
}

function bindEvents() {
  elements.balanceBtn.addEventListener("click", handleBalance);
  elements.clearKeyBtn.addEventListener("click", clearApiKey);
  elements.fileInput.addEventListener("change", () => handleFiles(elements.fileInput.files));
  elements.clearUsageBtn.addEventListener("click", clearUsage);

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("dragging");
    });
  });

  elements.dropZone.addEventListener("drop", (event) => {
    handleFiles(event.dataTransfer.files);
  });
}

async function handleBalance() {
  const apiKey = elements.apiKeyInput.value.trim();

  if (!apiKey) {
    setStatus(elements.balanceStatus, "请输入 DeepSeek API Key。", "error");
    return;
  }

  setStatus(elements.balanceStatus, "正在查询余额...");
  elements.balanceBtn.disabled = true;
  elements.balanceList.innerHTML = "";

  try {
    const response = await fetch("https://api.deepseek.com/user/balance", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload && (payload.message || payload.error && payload.error.message);
      throw new Error(message || `请求失败：HTTP ${response.status}`);
    }

    if (elements.rememberKeyInput.checked) {
      await storage.set({ [STORAGE_KEYS.apiKey]: apiKey });
    } else {
      await storage.remove([STORAGE_KEYS.apiKey]);
    }

    renderBalance(payload);
    setStatus(elements.balanceStatus, payload.is_available ? "余额可用。" : "余额不可用，请检查账户。", payload.is_available ? "success" : "error");
  } catch (error) {
    setStatus(elements.balanceStatus, error.message || "余额查询失败。", "error");
  } finally {
    elements.balanceBtn.disabled = false;
  }
}

function renderBalance(payload) {
  const balances = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos : [];

  if (!balances.length) {
    elements.balanceList.innerHTML = '<div class="empty-cell">没有返回余额明细</div>';
    return;
  }

  elements.balanceList.innerHTML = balances.map((item) => {
    return `
      <article class="balance-item">
        <span>${escapeHtml(item.currency || "CNY")}</span>
        <strong>${escapeHtml(item.total_balance || "0")}</strong>
        <small>赠金 ${escapeHtml(item.granted_balance || "0")}</small>
        <small>充值 ${escapeHtml(item.topped_up_balance || "0")}</small>
      </article>
    `;
  }).join("");
}

async function clearApiKey() {
  elements.apiKeyInput.value = "";
  elements.rememberKeyInput.checked = false;
  elements.balanceList.innerHTML = "";
  await storage.remove([STORAGE_KEYS.apiKey]);
  setStatus(elements.balanceStatus, "API Key 已清除。", "success");
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => /\.csv$/i.test(file.name) || file.type.includes("csv"));

  if (!files.length) {
    setStatus(elements.importStatus, "请选择 CSV 文件。", "error");
    return;
  }

  setStatus(elements.importStatus, `正在解析 ${files.length} 个文件...`);

  try {
    const allRows = [];
    const fileNames = [];

    for (const file of files) {
      const text = await file.text();
      const parsed = DeepSeekUsage.parseCsv(text);
      allRows.push(...parsed.rows);
      fileNames.push(file.name);
    }

    const result = DeepSeekUsage.aggregateUsage(allRows);

    if (!result.daily.length) {
      throw new Error("没有识别到日期或 token 字段，请确认导入的是 DeepSeek 用量 CSV。");
    }

    dailyUsage = DeepSeekUsage.mergeDailyUsage(dailyUsage, result.daily);
    meta = {
      files: fileNames,
      importedAt: new Date().toISOString(),
      rows: allRows.length,
      skipped: result.skipped,
      days: result.daily.length
    };

    await storage.set({
      [STORAGE_KEYS.daily]: dailyUsage,
      [STORAGE_KEYS.meta]: meta
    });

    renderAll();
    setStatus(elements.importStatus, `已导入 ${result.daily.length} 天数据，跳过 ${result.skipped} 行。`, "success");
  } catch (error) {
    setStatus(elements.importStatus, error.message || "CSV 解析失败。", "error");
  } finally {
    elements.fileInput.value = "";
  }
}

async function clearUsage() {
  dailyUsage = [];
  meta = null;
  await storage.remove([STORAGE_KEYS.daily, STORAGE_KEYS.meta]);
  renderAll();
  setStatus(elements.importStatus, "用量数据已清空。", "success");
}

function renderAll() {
  renderMeta();
  renderMetrics();
  renderChart();
  renderTable();
}

function renderMeta() {
  if (!meta) {
    elements.importMeta.textContent = "";
    return;
  }

  const date = new Date(meta.importedAt);
  const time = Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  elements.importMeta.textContent = `上次导入：${time}`;
}

function renderMetrics() {
  const summary = DeepSeekUsage.summarize(dailyUsage);

  elements.todayTokens.textContent = formatCompact(summary.todayTokens);
  elements.monthTokens.textContent = formatCompact(summary.monthTokens);
  const flashMonth = summary.flash?.monthTokens || 0;
  const proMonth = summary.pro?.monthTokens || 0;
  const hasMonthModelBreakdown = Boolean(flashMonth || proMonth);
  elements.monthFlashTokens.textContent = formatModelCompact(flashMonth, hasMonthModelBreakdown || !summary.monthTokens);
  elements.monthProTokens.textContent = formatModelCompact(proMonth, hasMonthModelBreakdown || !summary.monthTokens);
  elements.latestTokens.textContent = summary.latest ? formatCompact(summary.latest.totalTokens) : "0";
  elements.latestDate.textContent = summary.latest ? summary.latest.date : "暂无数据";

  if (summary.days) {
    elements.dataRange.textContent = `${summary.firstDate} 至 ${summary.lastDate}，共 ${summary.days} 天`;
  } else {
    elements.dataRange.textContent = "导入 CSV 后显示。";
  }
}

function renderChart() {
  if (!dailyUsage.length) {
    elements.chartPanel.classList.add("is-empty");
    elements.barChart.innerHTML = "";
    return;
  }

  elements.chartPanel.classList.remove("is-empty");
  const recent = dailyUsage.slice(-14);
  const max = Math.max(...recent.map((item) => item.totalTokens), 1);

  elements.barChart.innerHTML = recent.map((item) => {
    const height = Math.max(4, Math.round((item.totalTokens / max) * 128));
    const label = item.date.slice(5);
    const title = `${item.date}: ${formatNumber(item.totalTokens)} tokens`;

    return `
      <div class="bar-item" title="${escapeHtml(title)}">
        <span class="bar" style="height:${height}px"></span>
        <span class="bar-label">${escapeHtml(label)}</span>
      </div>
    `;
  }).join("");
}

function renderTable() {
  if (!dailyUsage.length) {
    elements.usageTableBody.innerHTML = '<tr><td colspan="7" class="empty-cell">暂无数据</td></tr>';
    return;
  }

  elements.usageTableBody.innerHTML = dailyUsage.slice(-12).reverse().map((item) => {
    const flash = Number(item.models?.flash?.totalTokens) || 0;
    const pro = Number(item.models?.pro?.totalTokens) || 0;
    const hasModelBreakdown = Boolean(flash || pro);
    return `
      <tr>
        <td>${escapeHtml(item.date)}</td>
        <td>${formatCompact(item.totalTokens)}</td>
        <td>${formatModelCompact(flash, hasModelBreakdown || !item.totalTokens)}</td>
        <td>${formatModelCompact(pro, hasModelBreakdown || !item.totalTokens)}</td>
        <td>${formatCompact(item.promptTokens)}</td>
        <td>${formatCompact(item.completionTokens)}</td>
        <td>${item.cost ? formatMoney(item.cost) : "-"}</td>
      </tr>
    `;
  }).join("");
}

function setStatus(element, message, type) {
  element.textContent = message;
  element.classList.remove("error", "success");
  if (type) {
    element.classList.add(type);
  }
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

function formatModelCompact(value, available) {
  return available ? formatCompact(value) : "--";
}

function formatMoney(value) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 4
  }).format(Number(value) || 0);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
