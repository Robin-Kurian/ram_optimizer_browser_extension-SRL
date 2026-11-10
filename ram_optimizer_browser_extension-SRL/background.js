'use strict';

const DEFAULTS = Object.freeze({
  enabled: true, minutes: 2, groupFrozen: true,
  protectPinned: true, protectAudio: true, excludedHosts: [], memoryAlerts: true,
});
const ALARM = 'stackroot-maintenance';
const WARNING = 'stackroot-memory-warning';
const WARNING_AT = 85;
const WARNING_REARM = 78;
const WARNING_COOLDOWN = 60 * 60 * 1000;
const GROUP_TITLE = 'Frozen';
const GROUP_COLOR = 'grey';
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE ?? -1;

let pending = Promise.resolve();
function serial(action) {
  const task = pending.then(action, action);
  pending = task.catch(error => console.warn('RAM Optimizer Browser Extension - SRL:', error));
  return task;
}

async function config() {
  return { ...DEFAULTS, ...await chrome.storage.local.get(Object.keys(DEFAULTS)) };
}
function isExcluded(tab, cfg) {
  try {
    const host = new URL(tab.url).hostname.toLowerCase();
    return cfg.excludedHosts.some(domain => host === domain || host.endsWith('.' + domain));
  } catch { return true; }
}
function eligible(tab, cfg) {
  return Boolean(tab && Number.isInteger(tab.id) && !tab.active && !tab.discarded &&
    (!cfg.protectPinned || !tab.pinned) && (!cfg.protectAudio || !tab.audible) &&
    tab.autoDiscardable !== false && /^https?:\/\//i.test(tab.url || '') &&
    !isExcluded(tab, cfg));
}

async function sessionState() {
  return chrome.storage.session.get({ frozenGroups: {}, originalGroups: {}, selectedTabs: {}, firstSeen: {} });
}
async function updateSession(patch) { await chrome.storage.session.set(patch); }

async function ownedGroup(windowId) {
  const { frozenGroups } = await sessionState();
  const id = frozenGroups[String(windowId)];
  const groups = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
  const group = groups.find(group => group.id === id) || groups[0] || null;
  if (group && id !== group.id) {
    frozenGroups[String(windowId)] = group.id;
    await updateSession({ frozenGroups });
  } else if (!group && id !== undefined) {
    delete frozenGroups[String(windowId)];
    await updateSession({ frozenGroups });
  }
  return group;
}

async function rememberOriginal(tab) {
  const state = await sessionState();
  const key = String(tab.id);
  if (!(key in state.originalGroups)) {
    state.originalGroups[key] = { windowId: tab.windowId, groupId: tab.groupId ?? NO_GROUP };
    await updateSession({ originalGroups: state.originalGroups });
  }
}

async function addToFrozen(tabId, manual = false) {
  const cfg = await config();
  if (!cfg.groupFrozen) return;
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  if (!frozenEligible(tab, cfg)) return;
  const group = await ownedGroup(tab.windowId);
  if (group && tab.groupId === group.id) return;
  if (tab.groupId === NO_GROUP || !(await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE })).some(item => item.id === tab.groupId)) {
    await rememberOriginal(tab);
  }
  try {
    // Recheck after asynchronous storage/group discovery: activation can race us.
    tab = await chrome.tabs.get(tabId);
    if (!frozenEligible(tab, await config())) return;
    const groupId = group
      ? await chrome.tabs.group({ tabIds: [tab.id], groupId: group.id })
      : await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    if (!group) {
      // Record ownership before any later tab-management event is handled.
      const state = await sessionState();
      state.frozenGroups[String(tab.windowId)] = groupId;
      await updateSession({ frozenGroups: state.frozenGroups });
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
    }
    tab = await chrome.tabs.get(tabId);
    if (tab.active || !tab.discarded) await releaseFromFrozen(tabId);
    if (!group) await collapseFrozen(groupId);
  } catch (error) {
    console.warn('Cannot group frozen tab:', error);
  }
}

async function releaseFromFrozen(tabId) {
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  const state = await sessionState();
  const original = state.originalGroups[String(tabId)];
  const owned = (await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE })).find(group => group.id === tab.groupId);
  if (!owned || tab.groupId !== owned.id) return;
  try {
    // Grouping with the original group also removes the tab from Frozen.
    if (original && original.groupId >= 0 && original.groupId !== owned.id) {
      try {
        const oldGroup = await chrome.tabGroups.get(original.groupId);
        if (oldGroup.windowId === tab.windowId) {
          await chrome.tabs.group({ tabIds: [tabId], groupId: original.groupId });
          if (tab.active && oldGroup.collapsed) await chrome.tabGroups.update(oldGroup.id, { collapsed: false });
          delete state.originalGroups[String(tabId)];
          await updateSession({ originalGroups: state.originalGroups });
          return;
        }
      } catch { /* original group no longer exists */ }
    }
    await chrome.tabs.ungroup(tabId);
    delete state.originalGroups[String(tabId)];
    await updateSession({ originalGroups: state.originalGroups });
  } catch (error) { console.warn('Cannot restore tab group:', error); }
}

function frozenEligible(tab, cfg) {
  return Boolean(tab && tab.id !== chrome.tabs.TAB_ID_NONE && tab.discarded && !tab.active &&
    !tab.pinned && (!cfg.protectAudio || !tab.audible) &&
    /^https?:\/\//i.test(tab.url || '') && !isExcluded(tab, cfg));
}
async function collapseFrozen(groupId) {
  try {
    const members = await chrome.tabs.query({ groupId });
    const group = await chrome.tabGroups.get(groupId);
    if (members.some(tab => tab.active)) return;
    if (!group.collapsed || group.color !== GROUP_COLOR) {
      await chrome.tabGroups.update(groupId, { collapsed: true, color: GROUP_COLOR });
    }
  } catch { /* last tab or window closed */ }
}
async function reconcile() {
  const cfg = await config();
  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
  const ids = new Set(groups.map(group => group.id));
  for (const tab of tabs) {
    try {
      if (ids.has(tab.groupId) && (!cfg.groupFrozen || !frozenEligible(tab, cfg))) {
        await releaseFromFrozen(tab.id);
      } else if (cfg.groupFrozen && frozenEligible(tab, cfg)) {
        await addToFrozen(tab.id);
      }
    } catch (error) { console.warn('Frozen reconciliation:', error); }
  }
}
let reconcileTimer;
function scheduleReconcile() {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    serial(reconcile).catch(console.error);
  }, 100);
}

async function freezeTab(tabId, cfg, manual = false) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!eligible(tab, cfg)) return false;
    if (!manual && !(await config()).enabled) return false;
    const result = await chrome.tabs.discard(tabId);
    if (!result?.discarded) return false;
    await addToFrozen(tabId, manual);
    return true;
  } catch { return false; }
}
async function recordFreezes(n) {
  if (!n) return;
  const { freezeCount = 0 } = await chrome.storage.local.get({ freezeCount: 0 });
  await chrome.storage.local.set({ freezeCount: freezeCount + n });
}

async function scan(force = false) {
  return serial(async () => {
    const cfg = await config();
    if (!cfg.enabled && !force) return 0;
    const tabs = await chrome.tabs.query({});
    const now = Date.now();
    const state = await sessionState();
    let changedFirstSeen = false;
    let count = 0;
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id)) continue;
      const key = String(tab.id);
      const fallback = state.firstSeen[key] ?? now;
      if (!(key in state.firstSeen)) {
        state.firstSeen[key] = now;
        changedFirstSeen = true;
      }
      if (!eligible(tab, cfg)) continue;
      const lastActive = Number.isFinite(tab.lastAccessed) && tab.lastAccessed > 0
        ? tab.lastAccessed : fallback;
      if (!force && cfg.minutes > 0 && now - lastActive < cfg.minutes * 60000) continue;
      if (await freezeTab(tab.id, cfg, force)) count++;
    }
    if (changedFirstSeen) await updateSession({ firstSeen: state.firstSeen });
    await recordFreezes(count);
    return count;
  });
}

async function ensureBaseline() {
  const existing = await chrome.storage.local.get({ ramStartFree: null });
  if (typeof existing.ramStartFree === 'number') return;
  try {
    const info = await chrome.system.memory.getInfo();
    await chrome.storage.local.set({ ramStartFree: info.availableCapacity });
  } catch { /* system API unavailable */ }
}
async function setEngine(enabled) {
  if (enabled) {
    try {
      const info = await chrome.system.memory.getInfo();
      await chrome.storage.local.set({ ramStartFree: info.availableCapacity });
    } catch { await chrome.storage.local.set({ ramStartFree: null }); }
  }
  await chrome.storage.local.set({ enabled: Boolean(enabled) });
  if (enabled) await scan();
  if (enabled) await chrome.notifications.clear(WARNING).catch(() => {});
  return { enabled: Boolean(enabled) };
}

async function checkMemory() {
  try {
    const cfg = await config();
    if (cfg.enabled || !cfg.memoryAlerts) return;
    const info = await chrome.system.memory.getInfo();
    if (!info.capacity) return;
    const usedPercent = Math.round(100 * (1 - info.availableCapacity / info.capacity));
    const data = await chrome.storage.local.get({ warningArmed: true, lastWarning: 0 });
    if (usedPercent < WARNING_REARM) {
      if (!data.warningArmed) await chrome.storage.local.set({ warningArmed: true });
      return;
    }
    if (usedPercent < WARNING_AT || !data.warningArmed || Date.now() - data.lastWarning < WARNING_COOLDOWN) return;
    await chrome.notifications.create(WARNING, {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'High memory usage',
      message: `RAM is ${usedPercent}% full. Turn on RAM Optimizer Browser Extension - SRL?`,
      buttons: [{ title: 'Turn on' }, { title: 'Dismiss' }],
      priority: 1,
    });
    await chrome.storage.local.set({ lastWarning: Date.now(), warningArmed: false });
  } catch (error) { console.warn('RAM alert:', error); }
}

async function initialize() {
  const current = await config();
  const active = await chrome.tabs.query({ active: true });
  const state = await sessionState();
  for (const tab of active) if (Number.isInteger(tab.id)) state.selectedTabs[String(tab.windowId)] = tab.id;
  await updateSession({ selectedTabs: state.selectedTabs });
  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  if (current.enabled) await ensureBaseline();
  await serial(reconcile);
  await scan();
  await checkMemory();
}

chrome.runtime.onInstalled.addListener(() => initialize().catch(console.error));
chrome.runtime.onStartup.addListener(() => initialize().catch(console.error));
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== ALARM) return;
  scan().catch(console.error);
  checkMemory().catch(console.error);
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  serial(async () => {
    const state = await sessionState();
    const key = String(windowId);
    const previous = state.selectedTabs[key];
    state.selectedTabs[key] = tabId;
    await updateSession({ selectedTabs: state.selectedTabs });
    await releaseFromFrozen(tabId);
    scheduleReconcile();
    const cfg = await config();
    if (cfg.enabled && cfg.minutes === 0 && Number.isInteger(previous) && previous !== tabId) {
      const count = await freezeTab(previous, cfg) ? 1 : 0;
      await recordFreezes(count);
    }
  }).catch(console.error);
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (['groupId', 'discarded', 'pinned', 'audible', 'url'].some(key => key in change)) scheduleReconcile();
  if (change.discarded === true) {
    serial(() => addToFrozen(tabId)).catch(console.error);
  } else if (change.discarded === false || (change.status === 'loading' && tab.active)) {
    serial(() => releaseFromFrozen(tabId)).catch(console.error);
  }
});
chrome.tabs.onCreated.addListener(tab => {
  scheduleReconcile();
  if (!Number.isInteger(tab.id)) return;
  serial(async () => {
    const state = await sessionState();
    state.firstSeen[String(tab.id)] = Date.now();
    await updateSession({ firstSeen: state.firstSeen });
  }).catch(console.error);
});
chrome.tabs.onRemoved.addListener((tabId, { windowId }) => {
  serial(async () => {
    const state = await sessionState();
    delete state.firstSeen[String(tabId)];
    delete state.originalGroups[String(tabId)];
    if (state.selectedTabs[String(windowId)] === tabId) delete state.selectedTabs[String(windowId)];
    await updateSession({ firstSeen: state.firstSeen, originalGroups: state.originalGroups, selectedTabs: state.selectedTabs });
  }).catch(console.error);
});
chrome.tabGroups.onRemoved.addListener(group => {
  scheduleReconcile();
  serial(async () => {
    const state = await sessionState();
    if (state.frozenGroups[String(group.windowId)] === group.id) {
      delete state.frozenGroups[String(group.windowId)];
      await updateSession({ frozenGroups: state.frozenGroups });
    }
  }).catch(console.error);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('enabled' in changes && changes.enabled.newValue === true) {
    ensureBaseline().catch(console.error);
    chrome.notifications.clear(WARNING).catch(() => {});
  }
  if ('minutes' in changes || 'enabled' in changes || 'excludedHosts' in changes ||
      'protectPinned' in changes || 'protectAudio' in changes || 'groupFrozen' in changes) {
    scheduleReconcile();
    scan().catch(console.error);
  }
});
chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id !== WARNING) return;
  if (index === 0) setEngine(true).catch(console.error);
  chrome.notifications.clear(WARNING).catch(() => {});
});
chrome.notifications.onClicked.addListener(id => {
  if (id === WARNING) chrome.notifications.clear(WARNING).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const reply = action => {
    Promise.resolve().then(action).then(sendResponse, error => sendResponse({ error: String(error) }));
    return true;
  };
  if (message.type === 'setEngine') return reply(() => setEngine(message.enabled));
  if (message.type === 'freezeNow') return reply(async () => ({ count: await scan(true) }));
  if (message.type === 'refreshGroups') return reply(async () => {
    await serial(reconcile);
    return { count: (await chrome.tabs.query({ discarded: true })).length };
  });
});

chrome.tabs.onAttached.addListener(scheduleReconcile);
chrome.tabs.onDetached.addListener(scheduleReconcile);
chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  serial(async () => {
    const state = await sessionState();
    if (state.originalGroups[String(removedId)]) {
      state.originalGroups[String(addedId)] = state.originalGroups[String(removedId)];
      delete state.originalGroups[String(removedId)];
    }
    delete state.firstSeen[String(removedId)];
    await updateSession({ originalGroups: state.originalGroups, firstSeen: state.firstSeen });
  }).catch(console.error);
  scheduleReconcile();
});
chrome.windows.onRemoved.addListener(windowId => {
  serial(async () => {
    const state = await sessionState();
    delete state.frozenGroups[String(windowId)];
    delete state.selectedTabs[String(windowId)];
    await updateSession({ frozenGroups: state.frozenGroups, selectedTabs: state.selectedTabs });
  }).catch(console.error);
});
// Every MV3 worker wake must repair browser state, even when the alarm already exists.
initialize().catch(console.error);
