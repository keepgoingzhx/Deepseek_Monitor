const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } = require("electron");
const extractZip = require("extract-zip");
const usageTools = require("../usage.js");
const { DEFAULT_BASE_URL, createUsageApiServer, formatDate } = require("./usage-api-core");
const { parseUsageTables, parseUsageText } = require("./usage-importer");

const DEFAULT_SETTINGS = {
  apiKeySecret: "",
  rememberKey: false,
  alwaysOnTop: true,
  openAtLogin: true,
  compactMode: true,
  port: 8787,
  baseUrl: DEFAULT_BASE_URL,
  refreshIntervalSec: 60
};

const WINDOW_SIZE = {
  normal: { width: 460, height: 800, minWidth: 390, minHeight: 640 },
  compact: { width: 86, height: 86, minWidth: 76, minHeight: 76 }
};

let mainWindow = null;
let usageWindow = null;
let tray = null;
let apiServer = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsPath = "";
let balance = null;
let lastBalanceCheckedAt = "";
let lastImportStatus = "";
let refreshTimer = null;
let downloadHooked = false;
const usageNetworkRequests = new Map();
let autoScrapeTimer = null;
let backgroundCrawlTimer = null;
let crawlInFlight = false;
let isQuitting = false;
let lastTraySignature = "";
let cachedDeepSeekUserToken = { signature: "", token: "" };
let cachedDeepSeekAppVersion = { checkedAt: 0, value: "" };
let lastFullBackgroundCrawlAt = Date.now();
const capturedUsageResponses = [];
const API_CRAWL_MONTHS = 12;
const BACKGROUND_API_CRAWL_MONTHS = 2;
const USAGE_AUTO_CRAWL_INTERVAL_MS = 30 * 60 * 1000;
const FULL_BACKGROUND_CRAWL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const APP_VERSION_CACHE_MS = 24 * 60 * 60 * 1000;
const MIN_REFRESH_INTERVAL_SEC = 15;

app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  showMainWindow(false);
});

app.whenReady().then(async () => {
  app.setAppUserModelId("deepseek.desktop.monitor");
  settingsPath = path.join(app.getPath("userData"), "desktop-settings.json");
  settings = loadSettings();
  applyLoginItemSetting();
  await startApiServer();
  createWindow();
  createTray();
  bindIpc();
  scheduleSnapshotRefresh();
  scheduleBackgroundUsageCrawl();
  refreshBalance().catch(() => {});
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", async () => {
  if (!isQuitting) return;
  clearInterval(refreshTimer);
  clearInterval(backgroundCrawlTimer);
  clearInterval(autoScrapeTimer);
  if (apiServer) await apiServer.stop().catch(() => {});
  app.quit();
});

function createWindow() {
  const size = settings.compactMode ? WINDOW_SIZE.compact : WINDOW_SIZE.normal;
  mainWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    frame: false,
    alwaysOnTop: settings.alwaysOnTop,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: "#f3f6f1",
    icon: path.join(__dirname, "..", "desktop", "tray-icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.center();
  applyWindowMode(settings.compactMode);
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideToTray();
  });
  mainWindow.on("show", () => broadcastSnapshot({ updateTray: false }));
  mainWindow.loadFile(path.join(__dirname, "..", "desktop", "index.html"));
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip("DeepSeek Token 用量");
  tray.on("click", () => showMainWindow(false));
  tray.on("double-click", () => showMainWindow(false));
  updateTray(true);
}

function createTrayIcon() {
  return nativeImage.createFromPath(path.join(__dirname, "..", "desktop", "tray-icon.png"));
}

function showMainWindow(compactMode = false) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  settings.compactMode = Boolean(compactMode);
  saveSettings();
  applyWindowMode(settings.compactMode);
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  broadcastSnapshot();
  updateTray(true);
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  updateTray(true);
}

async function quitApplication() {
  isQuitting = true;
  clearInterval(refreshTimer);
  clearInterval(backgroundCrawlTimer);
  clearInterval(autoScrapeTimer);
  if (apiServer) await apiServer.stop().catch(() => {});
  app.quit();
}

function updateTray(force = false) {
  if (!tray) return;
  const snapshot = getSnapshot();
  const todayTokens = snapshot.summary ? snapshot.summary.todayTokens || 0 : 0;
  const label = formatStatusNumber(todayTokens);
  const signature = `${label}|${settings.compactMode ? "compact" : "normal"}`;
  if (!force && signature === lastTraySignature) {
    return;
  }
  lastTraySignature = signature;
  tray.setToolTip(`DeepSeek 今日 ${label} tokens`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `今日：${label} tokens`, enabled: false },
    { type: "separator" },
    { label: "显示完整面板", click: () => showMainWindow(false) },
    { label: "显示桌面按钮", click: () => showMainWindow(true) },
    { label: "隐藏到后台", click: () => hideToTray() },
    { type: "separator" },
    { label: "立即爬取", click: () => syncUsagePage().then(() => broadcastSnapshot()).catch(() => {}) },
    { label: "打开登录页", click: () => openUsageWindow() },
    { type: "separator" },
    { label: "退出程序", click: () => quitApplication() }
  ]));
}

function bindIpc() {
  ipcMain.handle("app:getSnapshot", () => getSnapshot());

  ipcMain.handle("settings:save", async (_event, incoming) => {
    const oldPort = settings.port;
    const oldBaseUrl = settings.baseUrl;
    settings = normalizeIncomingSettings(incoming || {});
    saveSettings();

    if (mainWindow) {
      mainWindow.setAlwaysOnTop(settings.alwaysOnTop || settings.compactMode, "floating");
    }
    applyLoginItemSetting();

    if (oldPort !== settings.port || oldBaseUrl !== settings.baseUrl) {
      await startApiServer();
    }

    scheduleSnapshotRefresh();
    await refreshBalance().catch(() => {});
    broadcastSnapshot();
    return getSnapshot();
  });

  ipcMain.handle("balance:refresh", async () => {
    await refreshBalance();
    broadcastSnapshot();
    return getSnapshot();
  });

  ipcMain.handle("usage:reset", () => {
    apiServer.resetUsage();
    lastImportStatus = "用量已清空。";
    broadcastSnapshot();
    return getSnapshot();
  });

  ipcMain.handle("usage:importCsv", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 DeepSeek 用量 CSV 或 ZIP",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Usage files", extensions: ["csv", "zip"] },
        { name: "All files", extensions: ["*"] }
      ]
    });

    if (result.canceled || !result.filePaths.length) {
      return { canceled: true, snapshot: getSnapshot() };
    }

    const imported = await importUsageFiles(result.filePaths);
    lastImportStatus = `已导入 ${imported.days} 天数据。`;
    broadcastSnapshot();
    return { canceled: false, snapshot: getSnapshot() };
  });

  ipcMain.handle("usage:openUsagePage", () => {
    openUsageWindow();
    return getSnapshot();
  });

  ipcMain.handle("usage:syncUsagePage", async () => {
    const result = await syncUsagePage();
    broadcastSnapshot();
    return { ...result, snapshot: getSnapshot() };
  });

  ipcMain.handle("usage:autoExport", async () => {
    const result = await autoExportUsagePage();
    broadcastSnapshot();
    return { ...result, snapshot: getSnapshot() };
  });

  ipcMain.handle("usage:startAutoScrape", () => {
    startAutoScrapeUsagePage();
    return getSnapshot();
  });

  ipcMain.handle("external:open", (_event, url) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle("window:minimize", () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle("window:setCompactMode", (_event, compactMode) => {
    settings.compactMode = Boolean(compactMode);
    saveSettings();
    applyWindowMode(settings.compactMode);
    showMainWindow(settings.compactMode);
    updateTray(true);
    broadcastSnapshot();
    return getSnapshot();
  });

  ipcMain.handle("window:close", () => {
    hideToTray();
  });
}

async function startApiServer() {
  if (apiServer) {
    await apiServer.stop().catch(() => {});
  }

  apiServer = createUsageApiServer({
    port: settings.port,
    baseUrl: settings.baseUrl,
    getApiKey: () => getSavedApiKey()
  });

  apiServer.on("usage", broadcastSnapshot);
  apiServer.on("runtime", broadcastSnapshot);

  try {
    await apiServer.start();
  } catch (error) {
    apiServer.runtime = {
      running: false,
      port: settings.port,
      baseUrl: settings.baseUrl,
      error: error.message || "接口启动失败",
      startedAt: ""
    };
  }
}

async function refreshBalance() {
  const apiKey = getSavedApiKey();
  if (!apiKey) {
    balance = null;
    lastBalanceCheckedAt = "";
    return;
  }

  const response = await fetch(`http://127.0.0.1:${settings.port}/api/deepseek/balance`, {
    headers: { authorization: `Bearer ${apiKey}` }
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload && (payload.message || payload.error && payload.error.message);
    throw new Error(message || `余额查询失败：HTTP ${response.status}`);
  }

  balance = payload;
  lastBalanceCheckedAt = new Date().toISOString();
}

function getSnapshot() {
  const usage = apiServer ? apiServer.getUsage() : { daily: [], summary: {} };
  const daily = usage.daily || [];
  const today = formatDate(new Date());
  const month = today.slice(0, 7);
  const todayItem = daily.find((item) => item.date === today) || null;
  const latest = daily[daily.length - 1] || null;
  const monthTokens = daily
    .filter((item) => item.date.slice(0, 7) === month)
    .reduce((sum, item) => sum + item.totalTokens, 0);
  const monthCost = daily
    .filter((item) => item.date.slice(0, 7) === month)
    .reduce((sum, item) => sum + (item.cost || 0), 0);

  return {
    settings: publicSettings(),
    runtime: apiServer ? apiServer.getRuntime() : {},
    balance,
    lastBalanceCheckedAt,
    lastImportStatus,
    dailyUsage: daily,
    summary: {
      today,
      todayTokens: todayItem ? todayItem.totalTokens : 0,
      todayRequests: todayItem ? todayItem.requests : 0,
      todayCost: todayItem ? todayItem.cost || 0 : 0,
      monthTokens,
      monthCost,
      latest,
      firstDate: daily[0] ? daily[0].date : "",
      lastDate: latest ? latest.date : "",
      days: daily.length
    }
  };
}

function openUsageWindow() {
  if (usageWindow && !usageWindow.isDestroyed()) {
    usageWindow.show();
    usageWindow.focus();
    return;
  }

  const usageSession = mainWindow.webContents.session;
  hookUsageDownloads(usageSession);

  usageWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    title: "DeepSeek Usage 登录同步",
    parent: mainWindow,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "desktop", "tray-icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: usageSession
    }
  });

  attachUsageNetworkCapture(usageWindow.webContents);
  usageWindow.webContents.on("did-finish-load", () => {
    injectUsageWindowHelper().catch(() => {});
    setTimeout(() => syncUsagePage().then(broadcastSnapshot).catch(() => {}), 2500);
  });
  usageWindow.on("closed", () => {
    stopAutoScrapeUsagePage();
    detachUsageNetworkCapture();
    usageWindow = null;
  });

  startAutoScrapeUsagePage();
  lastImportStatus = "已打开 DeepSeek Usage 页面。登录后插件会自动用当前登录态爬取用量接口，也可手动点“登录态爬取”。";
  usageWindow.loadURL("https://platform.deepseek.com/usage");
  broadcastSnapshot();
}

function startAutoScrapeUsagePage() {
  stopAutoScrapeUsagePage();
  runScheduledUsageCrawl().catch(() => {});
}

function stopAutoScrapeUsagePage() {
  if (autoScrapeTimer) {
    clearInterval(autoScrapeTimer);
    autoScrapeTimer = null;
  }
}

function scheduleBackgroundUsageCrawl() {
  clearInterval(backgroundCrawlTimer);
  setTimeout(() => runScheduledUsageCrawl().catch(() => {}), 10000);
  backgroundCrawlTimer = setInterval(() => {
    runScheduledUsageCrawl().catch(() => {});
  }, USAGE_AUTO_CRAWL_INTERVAL_MS);
}

async function runScheduledUsageCrawl() {
  if (crawlInFlight) return;
  if (!usageWindow && !readDeepSeekUserTokenFromLocalStorage()) return;

  crawlInFlight = true;
  try {
    const monthCount = getScheduledCrawlMonthCount();
    const result = await crawlLoggedInUsageApis({ monthCount });
    if (result.ok) {
      if (monthCount >= API_CRAWL_MONTHS) {
        lastFullBackgroundCrawlAt = Date.now();
      }
      closeUsageWindowForResources();
      broadcastSnapshot();
    }
  } finally {
    crawlInFlight = false;
  }
}

function getScheduledCrawlMonthCount() {
  const hasStoredUsage = Boolean(apiServer && apiServer.getUsage().daily.length);
  if (!hasStoredUsage) {
    return API_CRAWL_MONTHS;
  }
  if (Date.now() - lastFullBackgroundCrawlAt > FULL_BACKGROUND_CRAWL_INTERVAL_MS) {
    return API_CRAWL_MONTHS;
  }
  return BACKGROUND_API_CRAWL_MONTHS;
}

function attachUsageNetworkCapture(webContents) {
  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
      webContents.debugger.sendCommand("Network.enable");
    }
  } catch (error) {
    lastImportStatus = `无法监听网页接口：${error.message}`;
    return;
  }

  webContents.debugger.on("message", async (_event, method, params) => {
    if (method === "Network.responseReceived") {
      const response = params.response || {};
      if (isLikelyUsageResponse(response.url, response.mimeType)) {
        usageNetworkRequests.set(params.requestId, {
          url: response.url || "",
          contentType: response.mimeType || ""
        });
      }
      return;
    }

    if (method !== "Network.loadingFinished") {
      return;
    }

    const meta = usageNetworkRequests.get(params.requestId);
    if (!meta) {
      return;
    }
    usageNetworkRequests.delete(params.requestId);

    try {
      const body = await webContents.debugger.sendCommand("Network.getResponseBody", {
        requestId: params.requestId
      });
      const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
      const imported = importUsageText(text, meta);
      rememberCapturedResponse({
        url: meta.url,
        contentType: meta.contentType,
        bytes: text.length,
        days: imported.days,
        rows: imported.rows,
        sample: text.slice(0, 600)
      });
      if (imported.days) {
        lastImportStatus = `已自动同步 ${imported.days} 天用量。`;
        broadcastSnapshot();
      }
    } catch {
      // Some responses do not expose bodies. The download hook and manual sync remain available.
    }
  });
}

function detachUsageNetworkCapture() {
  usageNetworkRequests.clear();
  if (!usageWindow || usageWindow.isDestroyed()) return;
  try {
    if (usageWindow.webContents.debugger.isAttached()) {
      usageWindow.webContents.debugger.detach();
    }
  } catch {
    // Ignore debugger shutdown races.
  }
}

function closeUsageWindowForResources() {
  if (!usageWindow || usageWindow.isDestroyed()) return;
  try {
    usageWindow.close();
  } catch {
    // Ignore close races; the stored login session is already enough for background sync.
  }
}

function isLikelyUsageResponse(url, mimeType) {
  const lowerUrl = String(url || "").toLowerCase();
  const lowerMime = String(mimeType || "").toLowerCase();
  if (!lowerUrl.includes("deepseek.com")) return false;
  return (
    lowerMime.includes("json")
    || lowerMime.includes("csv")
    || /usage|bill|billing|amount|token|consume|quota|stat|cost|export/.test(lowerUrl)
  );
}

async function injectUsageWindowHelper() {
  if (!usageWindow || usageWindow.isDestroyed()) return;
  await usageWindow.webContents.executeJavaScript(`
    (() => {
      if (document.getElementById('deepseek-monitor-helper')) return;
      const box = document.createElement('div');
      box.id = 'deepseek-monitor-helper';
      box.textContent = 'DeepSeek 用量插件：登录后会自动抓取当前页面用量；也可以回到插件点击“抓取页面”。';
      Object.assign(box.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        padding: '10px 12px',
        borderRadius: '8px',
        background: '#0d8b70',
        color: '#fff',
        font: '13px system-ui, sans-serif',
        boxShadow: '0 12px 30px rgba(0,0,0,.18)',
        maxWidth: '340px'
      });
      document.body.appendChild(box);
    })();
  `);
}

async function syncUsagePage() {
  if (!usageWindow || usageWindow.isDestroyed()) {
    const storedLoginResult = await crawlLoggedInUsageApis();
    if (storedLoginResult.ok) {
      return storedLoginResult;
    }
    lastImportStatus = `${storedLoginResult.message || "未找到本地登录态。"} 请点击“打开登录页”确认 DeepSeek 已登录后，再点“登录态爬取”。`;
    return { ok: false, message: lastImportStatus };
  }

  const apiResult = await crawlLoggedInUsageApis();
  if (apiResult.ok) {
    closeUsageWindowForResources();
    return apiResult;
  }

  const pageSnapshots = await collectUsagePageSnapshots();
  const allTables = pageSnapshots.flatMap((item) => item.tables || []);
  const allText = pageSnapshots.map((item) => item.text || "").join("\\n");

  const tableResult = parseUsageTables(allTables);
  if (tableResult.daily.length) {
    apiServer.importDailyUsage(tableResult.daily);
    lastImportStatus = `已从页面表格同步 ${tableResult.daily.length} 天用量。`;
    closeUsageWindowForResources();
    return { ok: true, message: lastImportStatus };
  }

  const textResult = parseLooseVisibleUsageText(allText);
  if (textResult.daily.length) {
    apiServer.importDailyUsage(textResult.daily);
    lastImportStatus = `已从页面文本同步 ${textResult.daily.length} 天用量。`;
    closeUsageWindowForResources();
    return { ok: true, message: lastImportStatus };
  }

  const frameInfo = pageSnapshots.map((item) => `${item.title || "无标题"} ${item.url || ""}`).join(" | ");
  const recent = capturedUsageResponses.slice(-3).map((item) => {
    return `${item.days ? "已识别" : "未识别"} ${item.rows || 0}行 ${item.url}`;
  }).join("；");
  lastImportStatus = `未识别到用量。页面帧 ${pageSnapshots.length} 个，表格 ${allTables.length} 个，文本 ${allText.split(/\\r?\\n/).filter(Boolean).length} 行。${recent ? `最近接口：${recent}` : "暂未捕获到 Usage 接口响应。"} ${frameInfo}`;
  return { ok: false, message: lastImportStatus };
}

async function crawlLoggedInUsageApis(options = {}) {
  const monthCount = Math.max(1, Math.min(API_CRAWL_MONTHS, Number(options.monthCount) || API_CRAWL_MONTHS));
  const months = getRecentUtcMonths(monthCount);
  let authContext = null;
  let responses = [];

  try {
    authContext = await getDeepSeekAuthContext();
    if (!authContext.token) {
      lastImportStatus = "没有找到 DeepSeek 登录 token。";
      return { ok: false, message: lastImportStatus };
    }
    responses = await fetchDeepSeekUsageApis(months, authContext);
  } catch (error) {
    lastImportStatus = `登录态接口爬取失败：${error.message || error}`;
    return { ok: false, message: lastImportStatus };
  }

  const dailyParts = [];
  const parseStats = [];
  let recognized = 0;
  let okCount = 0;

  responses.forEach((response) => {
    if (response && response.ok) okCount += 1;
    if (!response || !response.ok || !response.text) return;

    const parsed = parseUsageText(response.text, {
      contentType: response.contentType || "application/json",
      url: response.url || ""
    });
    const tokenTotal = parsed.daily.reduce((sum, item) => sum + (Number(item.totalTokens) || 0), 0);
    parseStats.push({
      kind: response.kind || "",
      year: response.year || "",
      month: response.month || "",
      status: response.status || 0,
      days: parsed.daily.length,
      tokenTotal,
      shape: parsed.daily.length ? "" : summarizeJsonShape(response.text)
    });

    rememberCapturedResponse({
      url: response.url || "",
      contentType: response.contentType || "",
      bytes: response.text.length,
      days: parsed.daily.length,
      rows: parsed.rows.length,
      sample: response.text.slice(0, 600)
    });

    if (parsed.daily.length) {
      recognized += 1;
      dailyParts.push(...parsed.daily);
    }
  });

  const merged = mergeDailyUsageAdditive(dailyParts);
  const totalTokens = merged.reduce((sum, item) => sum + (Number(item.totalTokens) || 0), 0);
  const totalCost = merged.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
  if (merged.length) {
    apiServer.importDailyUsage(merged);
    if (totalTokens) {
      lastImportStatus = `已通过登录态接口爬取 ${merged.length} 天用量，合计 ${formatStatusNumber(totalTokens)} tokens。识别接口 ${recognized} 个，成功请求 ${okCount}/${responses.length} 个，认证来源 ${authContext.source}。`;
      return { ok: true, message: lastImportStatus };
    }

    lastImportStatus = `已爬到 ${merged.length} 天费用${totalCost ? `（${formatStatusMoney(totalCost)}）` : ""}，但 token 仍为 0。${summarizeAmountParseStats(parseStats)}`;
    return { ok: false, message: lastImportStatus };
  }

  const failureText = summarizeCrawlerFailures(responses);
  lastImportStatus = `登录态接口暂未返回可识别用量。成功请求 ${okCount}/${responses.length} 个。${failureText}`;
  return { ok: false, message: lastImportStatus };
}

async function getDeepSeekAuthContext() {
  const context = {
    token: "",
    appVersion: "",
    cookieHeader: "",
    source: "none"
  };

  if (usageWindow && !usageWindow.isDestroyed()) {
    try {
      const pageContext = await usageWindow.webContents.executeJavaScript(`
        (() => {
          const readStorageValue = (key) => {
            try {
              const raw = localStorage.getItem(key);
              if (!raw) return "";
              const parsed = JSON.parse(raw);
              return parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : raw;
            } catch {
              return localStorage.getItem(key) || "";
            }
          };
          return {
            token: readStorageValue("userToken") || "",
            appVersion: document.querySelector('meta[name="commit-id"]')?.getAttribute("content") || "",
            href: location.href
          };
        })();
      `, true);
      if (pageContext && pageContext.token) {
        context.token = pageContext.token;
        context.appVersion = pageContext.appVersion || "";
        context.source = "页面";
        if (context.appVersion) {
          cachedDeepSeekAppVersion = { checkedAt: Date.now(), value: context.appVersion };
        }
      }
    } catch {
      // Fall back to persisted localStorage below.
    }
  }

  if (!context.token) {
    context.token = readDeepSeekUserTokenFromLocalStorage();
    context.source = context.token ? "本地登录态" : "none";
  }

  if (!context.appVersion) {
    context.appVersion = await getDeepSeekAppVersion();
  }

  context.cookieHeader = await getDeepSeekCookieHeader();
  return context;
}

async function fetchDeepSeekUsageApis(months, authContext) {
  const headers = {
    accept: "application/json, text/plain, */*",
    authorization: `Bearer ${authContext.token}`,
    "user-agent": "Mozilla/5.0"
  };
  if (authContext.appVersion) {
    headers["x-app-version"] = authContext.appVersion;
  }
  if (authContext.cookieHeader) {
    headers.cookie = authContext.cookieHeader;
  }

  const endpoints = months.flatMap(({ year, month }) => [
    { kind: "amount", year, month, url: `https://platform.deepseek.com/api/v0/usage/amount?year=${year}&month=${month}` },
    { kind: "cost", year, month, url: `https://platform.deepseek.com/api/v0/usage/cost?year=${year}&month=${month}` }
  ]);

  const responses = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        method: "GET",
        headers,
        cache: "no-store"
      });
      const text = await response.text();
      responses.push({
        ...endpoint,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type") || "",
        text
      });
    } catch (error) {
      responses.push({
        ...endpoint,
        ok: false,
        status: 0,
        statusText: error && error.message ? error.message : String(error),
        contentType: "",
        text: ""
      });
    }
  }

  return responses;
}

function readDeepSeekUserTokenFromLocalStorage() {
  const storageDir = path.join(app.getPath("userData"), "Local Storage", "leveldb");
  if (!fs.existsSync(storageDir)) return "";

  const files = fs.readdirSync(storageDir)
    .filter((name) => /\.(log|ldb)$/i.test(name))
    .map((name) => path.join(storageDir, name));
  const signature = files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${path.basename(file)}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${path.basename(file)}:missing`;
    }
  }).join("|");
  if (signature && signature === cachedDeepSeekUserToken.signature) {
    return cachedDeepSeekUserToken.token;
  }

  let bestToken = "";

  for (const file of files) {
    let buffer = null;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      continue;
    }

    for (const encoding of ["utf8", "utf16le", "latin1"]) {
      const text = buffer.toString(encoding);
      const matcher = /userToken[^{]{0,80}\{"value":"([^"]+)"/g;
      let match = null;
      while ((match = matcher.exec(text))) {
        const token = match[1];
        if (token && token !== "null" && token.length > bestToken.length) {
          bestToken = token;
        }
      }
    }
  }

  cachedDeepSeekUserToken = { signature, token: bestToken };
  return bestToken;
}

async function getDeepSeekAppVersion() {
  const now = Date.now();
  if (cachedDeepSeekAppVersion.value && now - cachedDeepSeekAppVersion.checkedAt < APP_VERSION_CACHE_MS) {
    return cachedDeepSeekAppVersion.value;
  }

  try {
    const response = await fetch("https://platform.deepseek.com/usage", {
      headers: { "user-agent": "Mozilla/5.0" }
    });
    const text = await response.text();
    const match = text.match(/<meta name="commit-id" content="([^"]+)"/i);
    const value = match ? match[1] : "";
    cachedDeepSeekAppVersion = { checkedAt: now, value };
    return value;
  } catch {
    cachedDeepSeekAppVersion.checkedAt = now;
    return "";
  }
}

async function getDeepSeekCookieHeader() {
  const browserSession = usageWindow && !usageWindow.isDestroyed()
    ? usageWindow.webContents.session
    : mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.webContents.session
      : null;
  if (!browserSession) return "";

  try {
    const cookies = await browserSession.cookies.get({ url: "https://platform.deepseek.com" });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  } catch {
    return "";
  }
}

function buildDeepSeekUsageCrawlerScript(months) {
  return `
    (async (months) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const cookieMatch = document.cookie.match(/(?:^|; )XSRF-TOKEN=([^;]+)/);
      const xsrfToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : "";
      const readStorageValue = (key) => {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return "";
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : raw;
        } catch {
          return localStorage.getItem(key) || "";
        }
      };
      const userToken = readStorageValue("userToken");
      const appVersion = document.querySelector('meta[name="commit-id"]')?.getAttribute("content") || "";
      const headers = {
        accept: "application/json, text/plain, */*"
      };
      if (xsrfToken) {
        headers["X-XSRF-TOKEN"] = xsrfToken;
      }
      if (userToken) {
        headers.Authorization = "Bearer " + userToken;
      }
      if (appVersion) {
        headers["X-App-Version"] = appVersion;
      }

      const endpoints = months.flatMap(({ year, month }) => [
        { kind: "amount", year, month, path: "/api/v0/usage/amount?year=" + year + "&month=" + month },
        { kind: "cost", year, month, path: "/api/v0/usage/cost?year=" + year + "&month=" + month }
      ]);
      const results = [];

      for (const endpoint of endpoints) {
        const absoluteUrl = new URL(endpoint.path, location.origin).href;
        try {
          const response = await fetch(endpoint.path, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            headers
          });
          const contentType = response.headers.get("content-type") || "";
          const text = await response.text();
          results.push({
            ...endpoint,
            url: absoluteUrl,
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            contentType,
            text
          });
        } catch (error) {
          results.push({
            ...endpoint,
            url: absoluteUrl,
            ok: false,
            status: 0,
            statusText: error && error.message ? error.message : String(error),
            contentType: "",
            text: ""
          });
        }
        await sleep(120);
      }

      return {
        href: location.href,
        origin: location.origin,
        results
      };
    })(${JSON.stringify(months)});
  `;
}

function getRecentUtcMonths(count) {
  const now = new Date();
  const months = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;

  for (let index = 0; index < count; index += 1) {
    months.push({ year, month });
    month -= 1;
    if (month <= 0) {
      month = 12;
      year -= 1;
    }
  }

  return months;
}

function mergeDailyUsageAdditive(days) {
  const byDate = new Map();

  (days || []).forEach((day) => {
    if (!day || !day.date) return;
    if (!byDate.has(day.date)) {
      byDate.set(day.date, createEmptyUsageDay(day.date));
    }
    const bucket = byDate.get(day.date);
    bucket.totalTokens += Number(day.totalTokens) || 0;
    bucket.promptTokens += Number(day.promptTokens) || 0;
    bucket.completionTokens += Number(day.completionTokens) || 0;
    bucket.cacheHitTokens += Number(day.cacheHitTokens) || 0;
    bucket.cacheMissTokens += Number(day.cacheMissTokens) || 0;
    bucket.reasoningTokens += Number(day.reasoningTokens) || 0;
    bucket.cost += Number(day.cost) || 0;
    bucket.requests += Number(day.requests) || 0;
  });

  return Array.from(byDate.values())
    .filter((item) => item.totalTokens || item.cost || item.requests)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function createEmptyUsageDay(date) {
  return {
    date,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    requests: 0
  };
}

function summarizeCrawlerFailures(responses) {
  const failed = (responses || []).filter((item) => !item.ok);
  if (!failed.length) {
    return "接口有响应，但 JSON 结构没有匹配到日期/token 字段。";
  }

  const authFailed = failed.find((item) => item.status === 401 || item.status === 403);
  if (authFailed) {
    return "接口返回未登录或无权限，请确认打开的 DeepSeek 页面已经登录，并停留在 platform.deepseek.com。";
  }

  return failed.slice(0, 4)
    .map((item) => `${item.kind || "api"} ${item.year}-${item.month}: HTTP ${item.status || 0}`)
    .join("；");
}

function summarizeAmountParseStats(stats) {
  const amountStats = (stats || []).filter((item) => item.kind === "amount");
  if (!amountStats.length) {
    return "没有拿到 amount/token 接口响应。";
  }

  return `amount接口：${amountStats.slice(0, 4).map((item) => {
    const month = `${item.year}-${String(item.month).padStart(2, "0")}`;
    const shape = item.shape ? `，结构 ${item.shape}` : "";
    return `${month} HTTP ${item.status}，${item.days}天，${formatStatusNumber(item.tokenTotal)} token${shape}`;
  }).join("；")}`;
}

function summarizeJsonShape(text) {
  try {
    const json = JSON.parse(String(text || ""));
    return summarizeObjectShape(json);
  } catch {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean ? clean.slice(0, 80) : "空响应";
  }
}

function summarizeObjectShape(value, depth = 0) {
  if (depth > 2) return "";
  if (Array.isArray(value)) {
    return value.length ? `[${summarizeObjectShape(value[0], depth + 1)}]` : "[]";
  }
  if (!value || typeof value !== "object") {
    return typeof value;
  }
  const keys = Object.keys(value).slice(0, 8);
  const childKey = keys.find((key) => value[key] && typeof value[key] === "object");
  const child = childKey ? `>${childKey}:${summarizeObjectShape(value[childKey], depth + 1)}` : "";
  return `{${keys.join(",")}}${child}`;
}

function formatStatusNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(Number(value) || 0));
}

function formatStatusMoney(value) {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  }).format(Number(value) || 0);
}

async function autoExportUsagePage() {
  if (!usageWindow || usageWindow.isDestroyed()) {
    lastImportStatus = "请先点击“打开登录页”，登录 DeepSeek 并进入 Usage 页面后，再点击“自动导出”。";
    return { ok: false, message: lastImportStatus };
  }

  const result = await usageWindow.webContents.executeJavaScript(`
    (async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const candidates = Array.from(document.querySelectorAll('button,a,[role="button"],[aria-label],[title]'))
        .filter(isVisible)
        .map((el) => {
          const text = normalize([el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('href')].filter(Boolean).join(' '));
          return { el, text };
        });
      const directLink = candidates.find(({ el, text }) =>
        el.tagName === 'A' && /\\.csv|\\.zip|export|download|导出|下载/.test(text)
      );
      const exportButton = directLink || candidates.find(({ text }) =>
        /export|download|导出|下载|用量导出|usage export/.test(text)
      );
      if (!exportButton) {
        return {
          ok: false,
          reason: 'not_found',
          buttons: candidates.slice(0, 30).map(({ text }) => text).filter(Boolean)
        };
      }
      exportButton.el.scrollIntoView({ block: 'center', inline: 'center' });
      await sleep(200);
      exportButton.el.click();
      return {
        ok: true,
        clicked: exportButton.text
      };
    })();
  `);

  if (result && result.ok) {
    lastImportStatus = `已点击导出按钮：${result.clicked || "Export"}。如果 DeepSeek 开始下载，插件会自动导入。`;
    return { ok: true, message: lastImportStatus };
  }

  const seen = result && Array.isArray(result.buttons) && result.buttons.length
    ? `页面可见按钮：${result.buttons.join(" | ")}`
    : "页面没有可识别按钮。";
  lastImportStatus = `没有找到 Export/导出按钮。${seen}`;
  return { ok: false, message: lastImportStatus };
}

async function collectUsagePageSnapshots() {
  const snapshots = [];
  const frames = getAllFrames(usageWindow.webContents.mainFrame).filter(Boolean);

  for (const frame of frames) {
    try {
      const snapshot = await frame.executeJavaScript(`
    (() => {
      const tables = Array.from(document.querySelectorAll('table')).map((table) =>
        Array.from(table.querySelectorAll('tr')).map((tr) =>
          Array.from(tr.querySelectorAll('th,td')).map((cell) => cell.innerText.trim())
        ).filter((row) => row.some(Boolean))
      ).filter((table) => table.length);
      const gridTables = Array.from(document.querySelectorAll('[role="table"], [role="grid"]')).map((grid) =>
        Array.from(grid.querySelectorAll('[role="row"]')).map((row) =>
          Array.from(row.querySelectorAll('[role="columnheader"], [role="cell"], [role="gridcell"]')).map((cell) => cell.innerText.trim())
        ).filter((row) => row.some(Boolean))
      ).filter((table) => table.length);
      const textBlocks = Array.from(document.querySelectorAll('div,section,article,li,p,span'))
        .map((node) => node.innerText || node.textContent || '')
        .map((value) => value.trim())
        .filter((value) => value && /20\\d{2}|token|tokens|用量|总量|费用|金额|消费|amount|cost|¥|￥|\\$/.test(value))
        .slice(0, 600);
      return {
        url: location.href,
        title: document.title,
        tables: tables.concat(gridTables),
        textBlocks,
        text: document.body ? document.body.innerText : ''
      };
    })();
  `);
      snapshots.push(snapshot);
    } catch {
      // Cross-origin or detached frames can fail; keep collecting others.
    }
  }

  if (!snapshots.length) {
    return [];
  }

  return snapshots.map((snapshot) => ({
    ...snapshot,
    text: [snapshot.text || "", ...(snapshot.textBlocks || [])].join("\\n")
  }));
}

function getAllFrames(frame, output = []) {
  if (!frame) {
    return output;
  }
  output.push(frame);
  for (const child of frame.frames || []) {
    getAllFrames(child, output);
  }
  return output;
}

function rememberCapturedResponse(item) {
  capturedUsageResponses.push({
    at: new Date().toISOString(),
    ...item
  });
  while (capturedUsageResponses.length > 5) {
    capturedUsageResponses.shift();
  }
}

function hookUsageDownloads(session) {
  if (downloadHooked) return;
  downloadHooked = true;

  session.on("will-download", (_event, item) => {
    const downloadsDir = path.join(app.getPath("userData"), "usage-downloads");
    fs.mkdirSync(downloadsDir, { recursive: true });
    const filename = safeFilename(item.getFilename() || `deepseek-usage-${Date.now()}`);
    const targetPath = path.join(downloadsDir, `${Date.now()}-${filename}`);
    item.setSavePath(targetPath);
    lastImportStatus = `正在下载 ${filename}`;
    broadcastSnapshot();

    item.once("done", async (_doneEvent, state) => {
      if (state !== "completed") {
        lastImportStatus = `下载未完成：${state}`;
        broadcastSnapshot();
        return;
      }

      try {
        const imported = await importUsageFiles([targetPath]);
        lastImportStatus = `已从网页下载导入 ${imported.days} 天用量。`;
      } catch (error) {
        lastImportStatus = error.message || "网页导入失败。";
      }
      broadcastSnapshot();
    });
  });
}

async function importUsageFiles(filePaths) {
  const files = [];

  for (const filePath of filePaths) {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".csv")) {
      files.push(filePath);
    } else if (lower.endsWith(".zip")) {
      const extractDir = path.join(app.getPath("userData"), "usage-downloads", `extract-${Date.now()}`);
      await fsp.mkdir(extractDir, { recursive: true });
      await extractZip(filePath, { dir: extractDir });
      files.push(...await findCsvFiles(extractDir));
    }
  }

  if (!files.length) {
    throw new Error("没有找到 CSV 用量文件。");
  }

  const daily = [];
  let rows = 0;
  let skipped = 0;
  for (const file of files) {
    const result = parseUsageText(await fsp.readFile(file, "utf8"), {
      contentType: "text/csv",
      url: file
    });
    daily.push(...result.daily);
    rows += result.rows.length;
    skipped += result.skipped || 0;
  }

  const merged = usageTools.mergeDailyUsage([], daily);
  if (!merged.length) {
    throw new Error("没有识别到日期或 token 字段。");
  }

  apiServer.importDailyUsage(merged);
  return { days: merged.length, rows, skipped };
}

function importUsageText(text, source) {
  const result = parseUsageText(text, source);
  if (!result.daily.length) {
    return { days: 0, rows: result.rows.length, skipped: result.skipped || 0 };
  }
  apiServer.importDailyUsage(result.daily);
  return { days: result.daily.length, rows: result.rows.length, skipped: result.skipped || 0 };
}

function parseLooseVisibleUsageText(text) {
  const rows = [];
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const dateMatch = lines[index].match(/\b(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2})\b/);
    if (!dateMatch) continue;

    const windowText = lines.slice(index, index + 8).join(" ");
    const tokenMatch = windowText.match(/(?:token|tokens|用量|总量|total)[^\d]{0,12}([\d,]+)/i)
      || windowText.match(/([\d,]+)[^\d]{0,8}(?:token|tokens)/i);
    const costMatch = windowText.match(/(?:amount|cost|费用|金额|消费)[^\d]{0,12}([\d,.]+)/i);
    const currencyCostMatch = windowText.match(/[¥￥$]\s*([\d,.]+)/)
      || windowText.match(/\b(?:CNY|USD|RMB)\s*([\d,.]+)/i);

    if (tokenMatch || costMatch || currencyCostMatch) {
      rows.push({
        date: dateMatch[1],
        total_tokens: tokenMatch ? tokenMatch[1] : "",
        amount: costMatch ? costMatch[1] : currencyCostMatch ? currencyCostMatch[1] : ""
      });
    }
  }

  return { ...usageTools.aggregateUsage(rows), rows };
}

async function findCsvFiles(rootDir) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findCsvFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
      files.push(fullPath);
    }
  }
  return files;
}

function safeFilename(filename) {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 160);
}

function broadcastSnapshot(options = {}) {
  if (options.updateTray !== false) {
    updateTray(Boolean(options.forceTray));
  }
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  mainWindow.webContents.send("snapshot:update", getSnapshot());
}

function scheduleSnapshotRefresh() {
  clearInterval(refreshTimer);
  const intervalSec = Math.max(MIN_REFRESH_INTERVAL_SEC, settings.refreshIntervalSec);
  refreshTimer = setInterval(() => {
    broadcastSnapshot({ updateTray: false });
  }, intervalSec * 1000);
}

function normalizeIncomingSettings(incoming) {
  const next = { ...settings };
  next.alwaysOnTop = Boolean(incoming.alwaysOnTop);
  next.openAtLogin = Boolean(incoming.openAtLogin);
  next.rememberKey = Boolean(incoming.rememberKey);
  if (typeof incoming.compactMode === "boolean") {
    next.compactMode = incoming.compactMode;
  }
  next.port = clampInt(incoming.port, 1024, 65535, DEFAULT_SETTINGS.port);
  next.baseUrl = normalizeBaseUrl(incoming.baseUrl || DEFAULT_SETTINGS.baseUrl);
  next.refreshIntervalSec = clampInt(incoming.refreshIntervalSec, MIN_REFRESH_INTERVAL_SEC, 60, DEFAULT_SETTINGS.refreshIntervalSec);

  if (typeof incoming.apiKey === "string" && incoming.apiKey.trim()) {
    next.apiKeySecret = next.rememberKey ? encryptApiKey(incoming.apiKey.trim()) : "";
  } else if (!next.rememberKey) {
    next.apiKeySecret = "";
  }

  return next;
}

function publicSettings() {
  return {
    alwaysOnTop: settings.alwaysOnTop,
    openAtLogin: settings.openAtLogin,
    compactMode: settings.compactMode,
    rememberKey: settings.rememberKey,
    port: settings.port,
    baseUrl: settings.baseUrl,
    refreshIntervalSec: settings.refreshIntervalSec,
    hasApiKey: Boolean(settings.apiKeySecret),
    apiKeyStorage: settings.apiKeySecret.startsWith("safe:") ? "encrypted" : settings.apiKeySecret ? "plain" : "none"
  };
}

function loadSettings() {
  try {
    if (!fs.existsSync(settingsPath)) return { ...DEFAULT_SETTINGS };
    const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      port: clampInt(saved.port, 1024, 65535, DEFAULT_SETTINGS.port),
      refreshIntervalSec: clampInt(saved.refreshIntervalSec, MIN_REFRESH_INTERVAL_SEC, 60, DEFAULT_SETTINGS.refreshIntervalSec),
      baseUrl: normalizeBaseUrl(saved.baseUrl || DEFAULT_SETTINGS.baseUrl)
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

function applyWindowMode(compactMode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const size = compactMode ? WINDOW_SIZE.compact : WINDOW_SIZE.normal;
  mainWindow.setMinimumSize(size.minWidth, size.minHeight);
  mainWindow.setResizable(!compactMode);
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop || compactMode, "floating");
  mainWindow.setSize(size.width, size.height, true);
}

function applyLoginItemSetting() {
  const options = {
    openAtLogin: Boolean(settings.openAtLogin)
  };

  if (process.defaultApp) {
    options.path = process.execPath;
    options.args = [app.getAppPath()];
  }

  try {
    app.setLoginItemSettings(options);
  } catch {
    // Login item support depends on how Electron is launched; keep the app usable.
  }
}

function encryptApiKey(apiKey) {
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(apiKey).toString("base64")}`;
  }
  return `plain:${Buffer.from(apiKey, "utf8").toString("base64")}`;
}

function getSavedApiKey() {
  const secret = settings.apiKeySecret || "";
  if (secret.startsWith("safe:") && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(secret.slice(5), "base64"));
    } catch {
      return "";
    }
  }
  if (secret.startsWith("plain:")) {
    return Buffer.from(secret.slice(6), "base64").toString("utf8");
  }
  return "";
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(String(value || DEFAULT_SETTINGS.baseUrl));
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return DEFAULT_SETTINGS.baseUrl;
  }
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
