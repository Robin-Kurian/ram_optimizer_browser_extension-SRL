'use strict';

const $ = id => document.getElementById(id);
const PRESETS = [0, 0.5, 1, 2, 5, 15];
let isEnabled = true;
let cpuPrevious = null;
let cpuPreviousTime = 0;
let updating = false;
let extLoading = false;
let excludedHosts = [];
let savingExcluded = false;

function message(text) { $('feedback').textContent = text || ''; }
function prettyBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
function setEngineLook(active) {
  isEnabled = active;
  $('enabled').checked = active;
  $('engineStatus').textContent = active ? 'ON' : 'OFF';
  $('engineStatus').classList.toggle('off', !active);
}
function selectedTimer(value) {
  document.querySelectorAll('[data-minutes]').forEach(button => {
    const selected = Number(button.dataset.minutes) === Number(value);
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    if (selected) $('timerSummary').textContent = button.textContent;
  });

}
function renderExcluded() {
  $('excluded').replaceChildren(...excludedHosts.map(host => {
    const row = document.createElement('li');
    row.className = 'extension-choice';
    const name = document.createElement('span');
    name.textContent = host;
    name.title = host;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Remove';
    button.setAttribute('aria-label', `Remove ${host}`);
    button.addEventListener('click', () => changeExcluded(host));
    row.append(name, button);
    return row;
  }));
  protectionCount();
}

async function changeExcluded(removeHost) {
  if (savingExcluded) return;
  savingExcluded = true;
  try {
    let hosts;
    if (removeHost) {
      hosts = excludedHosts.filter(host => host !== removeHost);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!/^https?:\/\//i.test(tab?.url || '')) {
        message('Open a website to add it to exclusions.');
        return;
      }
      const host = new URL(tab.url).hostname;
      if (excludedHosts.includes(host)) {
        message('This website is already in the list.');
        return;
      }
      hosts = [...excludedHosts, host];
    }
    await chrome.storage.local.set({ excludedHosts: hosts });
    excludedHosts = hosts;
    renderExcluded();
    if (removeHost) $('addExcluded').focus();
    message('');
  } catch (error) { message(error.message || String(error)); }
  finally { savingExcluded = false; }
}

function protectionCount() {
  const checks = ['protectPinned', 'protectAudio', 'groupFrozen', 'memoryAlerts'];
  const count = checks.filter(id => $(id).checked).length + excludedHosts.length;
  $('protectionCount').textContent = count;
}

async function updateStats() {
  const tabs = await chrome.tabs.query({});
  const frozen = tabs.filter(tab => tab.discarded).length;
  $('tabsOpen').textContent = tabs.length;
  $('tabsFrozen').textContent = frozen;
  const loaded = tabs.length - frozen;
  $('tabsLoaded').textContent = loaded;
  $('tabsSummary').textContent = `${tabs.length} open · ${loaded} loaded · ${frozen} frozen`;
}
function cpuSample(data) {
  let total = 0, idle = 0;
  if (!Array.isArray(data?.processors) || !data.processors.length) return null;
  for (const processor of data.processors) {
    const used = processor?.usage;
    if (!used || !Number.isFinite(used.total) || !Number.isFinite(used.idle)) return null;
    total += used.total;
    idle += used.idle;
  }
  return { total, idle };
}
async function updateCpu() {
  try {
    const current = cpuSample(await chrome.system.cpu.getInfo());
    const sampledAt = performance.now();
    if (current && cpuPrevious && sampledAt - cpuPreviousTime >= 1100) {
      const total = current.total - cpuPrevious.total;
      const idle = current.idle - cpuPrevious.idle;
      if (total > 0 && idle >= 0 && idle <= total) {
        const pct = Math.round(Math.max(0, Math.min(100, 100 * (total - idle) / total)));
        $('cpuValue').textContent = `${pct}%`;
        $('cpuSummary').textContent = `CPU ${pct}%`;
        $('cpuBar').style.width = `${pct}%`;
      }
    }
    cpuPrevious = current;
    cpuPreviousTime = sampledAt;
  } catch {
    $('cpuValue').textContent = '—';
    $('cpuSummary').textContent = 'CPU —';
  }
}
async function updateMemory() {
  try {
    const [memory, settings] = await Promise.all([
      chrome.system.memory.getInfo(),
      chrome.storage.local.get({ enabled: true, ramStartFree: null }),
    ]);
    setEngineLook(settings.enabled);
    const free = memory.availableCapacity;
    const used = memory.capacity - free;
    $('ramFree').textContent = prettyBytes(free);
    $('ramFreeFraction').textContent = `${prettyBytes(free)} / ${prettyBytes(memory.capacity)}`;
    if (settings.enabled && Number.isFinite(settings.ramStartFree)) {
      const gained = free - settings.ramStartFree;
      $('ramPrimaryLabel').textContent = 'RAM freed';
      $('ramPrimary').textContent = gained >= 0 ? `+${prettyBytes(gained)}` : `−${prettyBytes(Math.abs(gained))}`;
      $('ramPrimary').title = 'Change in system available RAM since auto-freeze was enabled';
    } else {
      $('ramPrimaryLabel').textContent = 'RAM used';
      $('ramPrimary').textContent = prettyBytes(used);
      $('ramPrimary').title = '';
    }
  } catch {
    $('ramPrimary').textContent = '—';
    $('ramFree').textContent = '—';
    $('ramFreeFraction').textContent = '—';
  }
  $('ramSummary').textContent = `${$('ramPrimaryLabel').textContent} ${$('ramPrimary').textContent} · ${$('ramFree').textContent} free`;
}
async function updateAll() {
  if (updating) return;
  updating = true;
  try { await Promise.all([updateStats(), updateMemory(), updateCpu()]); }
  catch (error) { message(`Refresh failed: ${error.message || error}`); }
  finally { updating = false; }
}
async function saveTimer(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1440 || (value > 0 && value < 0.5)) {
    message('Choose 0.5–1440 minutes.');
    return;
  }
  await chrome.storage.local.set({ minutes: value });
  selectedTimer(value);
  message('');
}
async function updateExtensions() {
  if (extLoading) return;
  extLoading = true;
  const target = $('extensionChoices');
  try {
    const [items, stored] = await Promise.all([
      chrome.management.getAll(), chrome.storage.local.get({ pausedExtensions: [] }),
    ]);
    const paused = new Set(stored.pausedExtensions);
    const options = items.filter(item => item.type === 'extension' && item.id !== chrome.runtime.id);
    options.sort((a, b) => a.name.localeCompare(b.name));
    const fragment = document.createDocumentFragment();
    for (const item of options) {
      const row = document.createElement('div');
      row.className = 'extension-choice';
      const name = document.createElement('span');
      name.textContent = item.name;
      name.title = item.name;
      const button = document.createElement('button');
      const controlled = paused.has(item.id);
      button.type = 'button';
      button.textContent = controlled ? 'Restore' : 'Pause';
      button.disabled = !controlled && (!item.enabled || !item.mayDisable);
      button.title = controlled ? 'Restore extension' : 'Pause this extension only if it is unpinned';
      button.addEventListener('click', async () => {
        // Keep management.setEnabled directly in the click handler for user-gesture protection.
        button.disabled = true;
        try {
          await chrome.management.setEnabled(item.id, controlled);
          const current = await chrome.storage.local.get({ pausedExtensions: [] });
          const next = new Set(current.pausedExtensions);
          if (controlled) next.delete(item.id); else next.add(item.id);
          await chrome.storage.local.set({ pausedExtensions: [...next] });
          message('');
        } catch (error) { message(error.message || 'Extension could not be changed.'); }
        finally { extLoading = false; await updateExtensions(); }
      });
      row.append(name, button);
      fragment.append(row);
    }
    target.replaceChildren(fragment);
    $('pausedCount').textContent = paused.size ? `${paused.size} paused` : '';
  } catch { target.textContent = 'Unavailable'; }
  finally { extLoading = false; }
}
async function initialize() {
  const stored = await chrome.storage.local.get({
    enabled: true, minutes: 2, protectPinned: true, protectAudio: true,
    groupFrozen: true, memoryAlerts: true, excludedHosts: [],
  });
  setEngineLook(stored.enabled);
  const savedMinutes = Number(stored.minutes);
  const presetMinutes = PRESETS.includes(savedMinutes) ? savedMinutes : 2;
  if (presetMinutes !== savedMinutes) await chrome.storage.local.set({ minutes: presetMinutes });
  selectedTimer(presetMinutes);
  for (const key of ['protectPinned', 'protectAudio', 'groupFrozen', 'memoryAlerts']) $(key).checked = stored[key];
  excludedHosts = stored.excludedHosts;
  renderExcluded();

  document.querySelectorAll('[data-minutes]').forEach(button => {
    button.addEventListener('click', () => saveTimer(Number(button.dataset.minutes)).catch(err => message(String(err))));
  });
  $('enabled').addEventListener('change', async event => {
    const enabled = event.target.checked;
    $('enabled').disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'setEngine', enabled });
      if (result?.error) throw new Error(result.error);
      setEngineLook(enabled);
      await updateAll();
    } catch (error) { setEngineLook(!enabled); message(error.message || String(error)); }
    finally { $('enabled').disabled = false; }
  });
  for (const key of ['protectPinned', 'protectAudio', 'groupFrozen', 'memoryAlerts']) {
    $(key).addEventListener('change', async event => {
      await chrome.storage.local.set({ [key]: event.target.checked });
      protectionCount();
    });
  }
  $('addExcluded').addEventListener('click', () => changeExcluded());
  const protection = $('protection');
  let protectionOpen = protection.open;
  if (protectionOpen) updateExtensions();
  protection.addEventListener('toggle', () => {
    if (protection.open === protectionOpen) return;
    protectionOpen = protection.open;
    if (protectionOpen) {
      updateExtensions();
      requestAnimationFrame(() => { protection.scrollIntoView({ block: 'start', behavior: 'instant' }); });
    }
  });
  $('freezeNow').addEventListener('click', async () => {
    $('freezeNow').disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'freezeNow' });
      if (result?.error) throw new Error(result.error);
      message(`${result.count} tab${result.count === 1 ? '' : 's'} frozen`);
      await Promise.all([updateStats(), updateMemory()]);
    } catch (error) { message(error.message || String(error)); }
    finally { $('freezeNow').disabled = false; }
  });

  await updateAll();
  // Two separate CPU samples, three seconds apart, avoid unstable startup percentages.
  setTimeout(() => { if (!document.hidden) updateCpu().catch(() => {}); }, 1600);
  setInterval(() => { if (!document.hidden) updateAll(); }, 3000);
  chrome.tabs.onUpdated.addListener(() => { if (!document.hidden) updateStats().catch(() => {}); });
  chrome.tabs.onRemoved.addListener(() => { if (!document.hidden) updateStats().catch(() => {}); });
}

initialize().catch(error => message(error.message || String(error)));
