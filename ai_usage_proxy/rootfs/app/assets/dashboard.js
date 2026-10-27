'use strict';
const base = document.body.dataset.base || '';
const csrf = document.querySelector('meta[name="csrf-token"]').content;
const cards = new Map();
let mqtt = {};
let updating = false;
let lastStates = [];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label, handler, className = '') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}
async function api(path, payload) {
  const options = {credentials: 'same-origin', cache: 'no-store'};
  if (payload !== undefined) Object.assign(options, {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf},
    body: JSON.stringify(payload)
  });
  const response = await fetch(base + path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed. Please retry.');
  return result;
}
function age(timestamp) {
  if (!timestamp) return 'No successful reading yet';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return `Updated ${seconds}s ago`;
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
  return `Updated ${Math.floor(seconds / 3600)}h ago`;
}
function resetText(timestamp) {
  if (!timestamp) return 'Reset time unavailable';
  const seconds = timestamp - Date.now() / 1000;
  if (seconds <= 0) return 'Reset time passed; awaiting update';
  if (seconds < 86400) {
    const minutes = Math.ceil(seconds / 60);
    return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  return 'Resets ' + new Date(timestamp * 1000).toLocaleString(undefined,
    {weekday: 'long', hour: '2-digit', minute: '2-digit'});
}
async function copy(text, node) {
  try { await navigator.clipboard.writeText(text); node.title = 'Copied'; }
  catch { node.title = 'Select the text to copy'; }
}
function authLink(url, label) {
  const link = element('a', '', label);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Invalid link');
    link.href = parsed.href;
  } catch { link.textContent = 'Authorization link unavailable'; }
  link.target = '_blank'; link.rel = 'noopener noreferrer';
  return link;
}
function panelError(card, message) {
  card.error.textContent = message;
  card.error.hidden = !message;
}
async function action(card, name, value = '') {
  panelError(card, '');
  try {
    const result = await api(`/providers/${card.id}/${name}`, {
      value, flow_id: card.state.flow_id || ''
    });
    card.open = name !== 'disconnect' && name !== 'cancel' && name !== 'refresh';
    if (result.flow_id) card.state.flow_id = result.flow_id;
    await update();
    setTimeout(update, 400);
  } catch (error) {
    card.panel.hidden = false;
    panelError(card, error.message);
  }
}
function createCard(state) {
  const node = element('article', 'card');
  const heading = element('div', 'card-heading');
  const title = element('div', 'provider-title');
  const marks = {claude: '✳', openai: 'O', zai: 'Z'};
  title.append(element('span', 'monogram', marks[state.id] || state.name[0]));
  const titleText = element('div');
  titleText.append(element('h2', '', state.name), element('p', 'provider-note',
    state.id === 'openai' ? 'Codex subscription' : 'Subscription usage'));
  title.append(titleText);
  const badge = element('span', 'badge');
  heading.append(title, badge);
  const metrics = element('div', 'metrics');
  const message = element('p', 'card-message');
  message.setAttribute('role', 'status');
  const bottom = element('div', 'card-bottom');
  const updated = element('p', 'updated');
  const actions = element('div', 'actions');
  const card = {id: state.id, node, state, badge, metrics, message, updated, open: false,
    panel: element('section', 'panel'), panelContent: element('div'),
    error: element('p', 'form-error'), signature: ''};
  card.refresh = button('Refresh usage', () => action(card, 'refresh'), 'quiet');
  card.manage = button('Connect', () => {
    if (!card.state.flow_id && card.state.connection === 'disconnected') action(card, 'connect');
    else { card.open = !card.open; card.panel.hidden = !card.open; renderPanel(card); }
  });
  actions.append(card.refresh, card.manage);
  bottom.append(updated, actions);
  card.panel.hidden = true;
  card.error.hidden = true;
  card.error.setAttribute('role', 'alert');
  card.panel.append(card.panelContent, card.error);
  card.details = element('details', 'details');
  card.details.append(element('summary', '', 'MQTT topics'));
  node.append(heading, metrics, message, bottom, card.panel, card.details);
  document.querySelector('#providers').append(node);
  return card;
}
function renderMetric(window) {
  const row = element('div', 'metric');
  const top = element('div', 'metric-top');
  const value = window.used_percent;
  const known = typeof value === 'number' && Number.isFinite(value);
  const percent = element('span', 'metric-value', known ? `${value.toLocaleString(undefined,
    {maximumFractionDigits: 1})}%` : '—');
  percent.append(element('small', '', known ? 'used' : 'unavailable'));
  top.append(element('span', 'metric-name', window.label), percent);
  const track = element('div', 'track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', `${window.label}: percentage used`);
  track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
  if (known) track.setAttribute('aria-valuenow', Math.min(value, 100));
  const fill = element('div', 'fill' + (value >= 100 ? ' full' : value >= 80 ? ' high' : ''));
  fill.style.width = known ? `${Math.min(100, Math.max(0, value))}%` : '0%';
  track.append(fill);
  row.append(top, track, element('p', 'reset', resetText(window.resets_at)));
  return row;
}
async function renderPanel(card) {
  const state = card.state;
  const signature = state.flow_id ? `${state.flow_id}:${state.flow_ready}` : `${state.connection}:${card.open}`;
  card.panel.hidden = !card.open;
  card.manage.setAttribute('aria-expanded', String(card.open));
  if (!card.open || signature === card.signature) return;
  card.signature = signature;
  const panel = card.panelContent;
  panel.replaceChildren();
  panel.append(element('h3', '', `Manage ${state.name}`));
  if (state.snapshot) {
    if (state.snapshot.account) panel.append(element('p', 'account', state.snapshot.account));
    if (state.snapshot.plan) panel.append(element('p', '', `Plan: ${state.snapshot.plan}`));
  }
  if (!state.flow_id) {
    panel.append(element('p', '', state.connection === 'disconnected' ?
      'Connect once here. Usage monitoring continues with this page closed.' :
      'Credentials are stored privately on the Home Assistant host.'));
    const buttons = element('div', 'panel-buttons');
    buttons.append(button(state.auth_kind === 'api_key' ? 'Replace key' : 'Reconnect',
      () => action(card, 'connect'), 'primary'));
    if (state.connection !== 'disconnected') buttons.append(button('Disconnect proxy',
      () => action(card, 'disconnect'), 'danger'));
    panel.append(buttons);
    return;
  }
  if (!state.flow_ready) { panel.append(element('p', 'waiting', 'Preparing connection…')); return; }
  let flow;
  try { flow = await api(`/providers/${card.id}/flow?flow_id=${encodeURIComponent(state.flow_id)}`); }
  catch (error) { panelError(card, error.message); card.signature = ''; return; }
  if (card.state.flow_id !== flow.flow_id) return;
  if (flow.kind === 'authorization_code') {
    const list = element('ol');
    const first = element('li');
    first.append(authLink(flow.url, 'Open Claude authorization'), document.createTextNode(' and approve access.'));
    list.append(first, element('li', '', 'Copy code#state from the callback page and paste it below.'));
    panel.append(list);
    const input = element('textarea'); input.placeholder = 'code#state';
    input.setAttribute('aria-label', 'Claude authorization code'); input.autocomplete = 'off';
    panel.append(input, button('Connect Claude', () => action(card, 'complete', input.value.trim()), 'primary'));
  } else if (flow.kind === 'device_code') {
    panel.append(authLink(flow.url, 'Open OpenAI verification page'), element('p', '', 'Sign in and enter this code:'));
    const code = element('code', 'device-code', flow.code);
    panel.append(code, button('Copy code', () => copy(flow.code, code), 'quiet'),
      element('p', 'waiting', 'Waiting for approval…'),
      element('p', '', 'If device login is unavailable, enable it in your ChatGPT security settings or workspace permissions.'));
  } else if (flow.kind === 'api_key') {
    panel.append(element('p', '', 'Use your Personal Coding Plan key. Standard API keys may not expose subscription usage.'));
    panel.append(authLink('https://z.ai/manage-apikey/apikey-list', 'Open z.ai key management'));
    const label = element('label', 'field-label', 'Coding Plan API key');
    const input = element('input'); input.type = 'password'; input.autocomplete = 'off';
    input.placeholder = 'Paste key'; label.append(input);
    panel.append(label, button('Save and test', () => {
      const value = input.value.trim(); input.value = ''; action(card, 'credentials', value);
    }, 'primary'));
  }
  const buttons = element('div', 'panel-buttons');
  buttons.append(button('Cancel', () => action(card, 'cancel'), 'quiet'));
  panel.append(buttons);
}
function renderCard(state) {
  let card = cards.get(state.id);
  if (!card) { card = createCard(state); cards.set(state.id, card); }
  card.state = state;
  panelError(card, state.auth_message || '');
  const labels = {ok: 'Connected', disconnected: 'Not connected', auth_required: 'Reconnect',
    rate_limited: 'Updates paused', error: 'Update interrupted', unsupported: 'Format unsupported',
    starting: 'Checking', stale: 'Stale reading'};
  card.badge.textContent = labels[state.status] || state.status;
  card.badge.className = 'badge ' + (state.status === 'ok' ? 'good' :
    ['auth_required', 'error'].includes(state.status) ? 'error' : 'warning');
  card.message.hidden = ['ok', 'disconnected', 'starting'].includes(state.status);
  card.message.textContent = state.message + (state.retry_at ? ` Next retry ${new Date(state.retry_at * 1000).toLocaleTimeString()}.` : '');
  const extraWasOpen = card.metrics.querySelector('.extra')?.open || false;
  card.metrics.replaceChildren();
  const windows = state.snapshot?.windows || [];
  if (!windows.length) card.metrics.append(element('p', 'empty',
    state.connection === 'disconnected' ? 'Connect your subscription to see its usage windows and reset times.' :
    state.status === 'unsupported' ? 'The provider accepted your credentials, but its usage format needs support.' : 'Waiting for a usage reading…'));
  else {
    const extra = element('details', 'extra'); extra.open = extraWasOpen;
    extra.append(element('summary', '', 'More usage windows'));
    windows.forEach((window, index) => (index < 2 ? card.metrics : extra).append(renderMetric(window)));
    if (windows.length > 2) card.metrics.append(extra);
  }
  card.updated.textContent = age(state.snapshot?.fetched_at) + (state.stale ? ' · Last known reading' : '');
  card.refresh.disabled = !state.snapshot || state.connection === 'reconnect_required' || state.busy;
  card.manage.textContent = state.connection === 'disconnected' && !state.flow_id ? 'Connect' : 'Manage connection';
  const oldTopics = card.details.querySelectorAll('.topic'); oldTopics.forEach(node => node.remove());
  const prefix = `${mqtt.topic_root || 'ai/usage'}/${state.id}`;
  for (const suffix of ['state', 'session_percent', 'week_percent', 'command/refresh']) {
    const topic = element('code', 'topic', `${prefix}/${suffix}`);
    topic.tabIndex = 0; topic.title = 'Click to copy';
    topic.addEventListener('click', () => copy(topic.textContent, topic));
    card.details.append(topic);
  }
  renderPanel(card);
}
async function update() {
  if (updating || document.visibilityState === 'hidden') return;
  updating = true;
  try {
    const data = await api('/api/status'); mqtt = data.mqtt; lastStates = data.providers;
    document.querySelector('#connection-error').hidden = true;
    const badge = document.querySelector('#mqtt-badge');
    badge.textContent = mqtt.connected ? 'MQTT connected' : 'MQTT unavailable';
    badge.className = `badge ${mqtt.connected ? 'good' : 'warning'}`;
    const values = document.querySelector('#settings-values'); values.replaceChildren();
    for (const [name, value] of [['Broker', mqtt.source], ['Polling interval', `${mqtt.poll_interval}s`],
      ['MQTT root', mqtt.topic_root],
      ['Home Assistant discovery', mqtt.discovery ? 'Enabled' : 'Disabled']]) {
      values.append(element('dt', '', name), element('dd', '', value));
    }
    const configLink = document.querySelector('#addon-config');
    if (mqtt.addon_slug) configLink.href = `/hassio/addon/${encodeURIComponent(mqtt.addon_slug)}/config`;
    data.providers.forEach(renderCard);
    document.querySelector('#page-updated').textContent = 'Dashboard connected';
  } catch {
    document.querySelector('#connection-error').hidden = false;
  } finally { updating = false; }
}
document.querySelector('#settings-toggle').addEventListener('click', event => {
  const panel = document.querySelector('#settings'); panel.hidden = !panel.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
});
document.addEventListener('visibilitychange', update);
setInterval(() => { if (lastStates.some(state => state.flow_id || state.busy)) update(); }, 1000);
setInterval(update, 5000);
update();
