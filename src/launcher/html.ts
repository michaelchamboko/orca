export function renderLauncherHtml(cspNonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ORCA Launcher</title>
  <style nonce="${cspNonce}">${launcherCss}</style>
</head>
<body>
  <main class="shell">
    <section class="topbar">
      <div>
        <h1>ORCA Launcher</h1>
        <p id="project-root"></p>
      </div>
      <div class="status-stack">
        <span id="controller-state" class="pill">loading</span>
        <span id="opencode-state" class="pill">OpenCode unknown</span>
      </div>
    </section>
    <section id="alerts" class="alerts"></section>
    <section class="actions">
      <button id="install-assets" type="button">Install Assets</button>
      <button id="pair-roster" type="button">Pair Sessions</button>
      <button id="start-controller" type="button">Start ORCA</button>
      <button id="stop-controller" type="button">Stop</button>
      <button id="test-opencode" type="button">Test OpenCode</button>
      <button id="refresh-state" type="button">Refresh</button>
    </section>
    <section class="panel">
      <div class="panel-head">
        <h2>Role Assignment</h2>
        <span id="roster-state" class="muted"></span>
      </div>
      <div id="role-rows" class="role-rows"></div>
    </section>
    <section class="panel split">
      <div>
        <h2>Runtime</h2>
        <dl id="runtime-list"></dl>
      </div>
      <div>
        <h2>Sessions</h2>
        <div id="session-list" class="session-list"></div>
      </div>
    </section>
  </main>
  <script nonce="${cspNonce}">${launcherJs}</script>
</body>
</html>`;
}

const launcherCss = `
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f4f6f8;
  color: #16202a;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
button, select { font: inherit; }
.shell { max-width: 1180px; margin: 0 auto; padding: 24px; }
.topbar { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 18px; }
h1 { margin: 0; font-size: 24px; letter-spacing: 0; }
h2 { margin: 0; font-size: 15px; letter-spacing: 0; }
p { margin: 6px 0 0; color: #536170; font-size: 13px; overflow-wrap: anywhere; }
.status-stack { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.pill { display: inline-flex; align-items: center; min-height: 28px; border: 1px solid #c9d2dc; border-radius: 6px; padding: 4px 9px; background: #ffffff; font-size: 12px; color: #344453; }
.pill.good { border-color: #8ac49f; background: #eef9f1; color: #175b2b; }
.pill.warn { border-color: #d6b36a; background: #fff8e6; color: #624700; }
.pill.bad { border-color: #d99a9a; background: #fff1f1; color: #7a1f1f; }
.alerts { display: grid; gap: 8px; margin-bottom: 14px; }
.alert { border: 1px solid #d6b36a; background: #fff8e6; border-radius: 6px; padding: 10px 12px; color: #3f3520; font-size: 13px; }
.alert.bad { border-color: #d99a9a; background: #fff1f1; color: #7a1f1f; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
button { min-height: 34px; border: 1px solid #aeb9c4; border-radius: 6px; background: #ffffff; color: #16202a; padding: 0 12px; cursor: pointer; }
button:hover:not(:disabled) { background: #edf2f7; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
#start-controller { background: #1f6feb; border-color: #1f6feb; color: #ffffff; }
#start-controller:hover:not(:disabled) { background: #195fc8; }
#stop-controller { border-color: #cc6b6b; color: #8a2424; }
.panel { background: #ffffff; border: 1px solid #d9e0e7; border-radius: 8px; padding: 14px; margin-bottom: 14px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.muted { color: #687684; font-size: 12px; }
.role-rows { display: grid; gap: 8px; }
.role-row { display: grid; grid-template-columns: 150px minmax(220px, 1fr) minmax(200px, 280px); gap: 10px; align-items: center; min-height: 48px; border-top: 1px solid #eef1f4; padding-top: 8px; }
.role-row:first-child { border-top: 0; padding-top: 0; }
.role-name { font-weight: 650; font-size: 13px; }
.role-meta { color: #687684; font-size: 12px; overflow-wrap: anywhere; }
select { width: 100%; min-height: 34px; border: 1px solid #aeb9c4; border-radius: 6px; background: #ffffff; color: #16202a; padding: 0 8px; }
.split { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.3fr); gap: 18px; }
dl { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 8px 12px; margin: 10px 0 0; font-size: 13px; }
dt { color: #687684; }
dd { margin: 0; overflow-wrap: anywhere; }
.session-list { display: grid; gap: 8px; margin-top: 10px; }
.session { border: 1px solid #e2e8ef; border-radius: 6px; padding: 8px; font-size: 13px; }
.session strong { display: block; margin-bottom: 3px; overflow-wrap: anywhere; }
.session span { color: #687684; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .shell { padding: 14px; }
  .topbar, .panel-head { flex-direction: column; align-items: stretch; }
  .status-stack { justify-content: flex-start; }
  .role-row, .split { grid-template-columns: 1fr; }
  dl { grid-template-columns: 1fr; }
}
`;

const launcherJs = `
(function () {
  var csrf = '';
  var currentState = null;
  var selections = {};
  var roles = ['orchestrator', 'planner', 'builder', 'reviewer', 'tester'];

  function text(node, value) {
    node.textContent = value == null ? '' : String(value);
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function classifyPill(node, state) {
    node.className = 'pill';
    if (state === 'ready' || state === 'healthy') node.classList.add('good');
    else if (state === 'blocked' || state === 'recovery-required' || state === 'unhealthy') node.classList.add('bad');
    else if (state !== 'stopped') node.classList.add('warn');
  }

  async function requestJson(path, options) {
    var init = options || {};
    init.headers = Object.assign({}, init.headers || {});
    if (init.method && init.method !== 'GET') {
      init.headers['content-type'] = 'application/json';
      init.headers['x-orca-csrf'] = csrf;
      init.body = init.body || '{}';
    }
    var response = await fetch(path, init);
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(body.error || body.code || 'INVALID_REQUEST');
    }
    return body;
  }

  async function bootstrap() {
    var params = new URLSearchParams(window.location.hash.slice(1));
    var nonce = params.get('nonce');
    if (!nonce) throw new Error('UNAUTHORIZED');
    var body = await fetch('/api/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: nonce })
    }).then(async function (response) {
      var parsed = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(parsed.error || 'UNAUTHORIZED');
      return parsed;
    });
    csrf = body.csrfToken;
    window.history.replaceState(null, '', window.location.pathname);
    await refresh();
  }

  async function refresh() {
    currentState = await requestJson('/api/state');
    render(currentState);
  }

  function render(state) {
    text(byId('project-root'), state.project.root);
    var controller = byId('controller-state');
    text(controller, 'Controller ' + state.controller.lifecycle);
    classifyPill(controller, state.controller.lifecycle);
    var opencode = byId('opencode-state');
    text(opencode, 'OpenCode ' + (state.opencode.healthy ? 'healthy' : 'unhealthy'));
    classifyPill(opencode, state.opencode.healthy ? 'healthy' : 'unhealthy');
    text(byId('roster-state'), state.roster.present ? ('Roster ' + state.roster.drift) : 'No roster');
    renderAlerts(state);
    renderRows(state);
    renderRuntime(state);
    renderSessions(state);
    setButtons(state);
  }

  function renderAlerts(state) {
    var alerts = byId('alerts');
    alerts.textContent = '';
    if (state.assets.restartRequired) addAlert(alerts, 'OpenCode restart required before pairing or starting.', false);
    state.blockers.forEach(function (code) { addAlert(alerts, code, true); });
    if (state.opencode.error) addAlert(alerts, state.opencode.error + ' (origin: ' + state.opencode.origin + ')', true);
    if (state.controller.lastFailureCode) addAlert(alerts, state.controller.lastFailureCode, true);
  }

  function addAlert(parent, message, bad) {
    var div = document.createElement('div');
    div.className = bad ? 'alert bad' : 'alert';
    text(div, message);
    parent.appendChild(div);
  }

  function renderRows(state) {
    var rows = byId('role-rows');
    rows.textContent = '';
    state.roles.forEach(function (roleRow) {
      var row = document.createElement('div');
      row.className = 'role-row';
      var label = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'role-name';
      text(name, roleRow.position + '. ' + roleRow.label);
      var meta = document.createElement('div');
      meta.className = 'role-meta';
      text(meta, 'fixed role');
      label.appendChild(name);
      label.appendChild(meta);
      var select = document.createElement('select');
      select.dataset.role = roleRow.role;
      var empty = document.createElement('option');
      empty.value = '';
      text(empty, 'Select session');
      select.appendChild(empty);
      state.sessions.forEach(function (session) {
        var option = document.createElement('option');
        option.value = session.id;
        option.disabled = !session.eligible;
        text(option, session.title + ' | ' + session.shortId + ' | ' + session.model.providerId + '/' + session.model.modelId);
        select.appendChild(option);
      });
      select.value = selections[roleRow.role] || roleRow.selectedSessionId || '';
      selections[roleRow.role] = select.value;
      select.addEventListener('change', function () {
        selections[roleRow.role] = select.value;
      });
      var detail = document.createElement('div');
      detail.className = 'role-meta';
      var selected = state.sessions.find(function (session) { return session.id === select.value; });
      text(detail, selected ? sessionDetail(selected) : 'No session assigned');
      row.appendChild(label);
      row.appendChild(select);
      row.appendChild(detail);
      rows.appendChild(row);
    });
  }

  function sessionDetail(session) {
    return session.directoryVerified ? session.activity + ' in project' : 'unverified directory';
  }

  function renderRuntime(state) {
    var list = byId('runtime-list');
    list.textContent = '';
    addTerm(list, 'OpenCode', state.opencode.origin);
    addTerm(list, 'Assets', state.assets.active ? 'active' : 'not active');
    addTerm(list, 'Roster', state.roster.present ? state.roster.drift : 'missing');
    addTerm(list, 'Controller', state.controller.ownership + ' / ' + state.controller.lifecycle);
    addTerm(list, 'Mission', state.activeMission.active ? state.activeMission.state : 'none');
    addTerm(list, 'Ingress', state.controller.ingressHealth);
  }

  function addTerm(parent, key, value) {
    var dt = document.createElement('dt');
    var dd = document.createElement('dd');
    text(dt, key);
    text(dd, value);
    parent.appendChild(dt);
    parent.appendChild(dd);
  }

  function renderSessions(state) {
    var list = byId('session-list');
    list.textContent = '';
    state.sessions.forEach(function (session) {
      var div = document.createElement('div');
      div.className = 'session';
      var title = document.createElement('strong');
      text(title, session.title);
      var meta = document.createElement('span');
      text(meta, session.shortId + ' | ' + session.model.providerId + '/' + session.model.modelId + ' | ' + session.activity + ' | ' + (session.directoryVerified ? 'verified' : 'unverified'));
      div.appendChild(title);
      div.appendChild(meta);
      list.appendChild(div);
    });
  }

  function setButtons(state) {
    byId('install-assets').disabled = !state.permittedActions.installAssets;
    byId('pair-roster').disabled = !state.permittedActions.pairRoster;
    byId('start-controller').disabled = !state.permittedActions.startController;
    byId('stop-controller').disabled = !state.permittedActions.stopController;
  }

  async function mutate(path, body) {
    try {
      await requestJson(path, { method: 'POST', body: JSON.stringify(body || {}) });
      await refresh();
    } catch (error) {
      await refresh().catch(function () {});
      var alerts = byId('alerts');
      addAlert(alerts, error.message, true);
    }
  }

  byId('install-assets').addEventListener('click', function () { void mutate('/api/assets/install'); });
  byId('pair-roster').addEventListener('click', function () {
    var assignments = {};
    roles.forEach(function (role) { assignments[role] = selections[role] || ''; });
    void mutate('/api/roster/pair', { assignments: assignments });
  });
  byId('start-controller').addEventListener('click', function () { void mutate('/api/controller/start'); });
  byId('stop-controller').addEventListener('click', function () { void mutate('/api/controller/stop'); });
  byId('refresh-state').addEventListener('click', function () { void refresh().catch(function (error) { addAlert(byId('alerts'), 'Refresh failed: ' + (error && error.message ? error.message : String(error)), true); }); });
  byId('test-opencode').addEventListener('click', function () { void testOpenCode(); });

  async function testOpenCode() {
    var alerts = byId('alerts');
    addAlert(alerts, 'Probing OpenCode ' + (currentState && currentState.opencode ? currentState.opencode.origin : ''), false);
    try {
      var response = await fetch('/api/opencode/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orca-csrf': csrf },
        body: '{}'
      });
      var body = await response.json().catch(function () { return {}; });
      if (response.status === 200 && body.healthy) {
        addAlert(alerts, 'OpenCode reachable at ' + body.origin + ' (version: ' + (body.version || 'unknown') + ').', false);
      } else {
        addAlert(alerts, 'OpenCode probe failed (HTTP ' + response.status + '): ' + (body.error || 'no error message'), true);
      }
    } catch (error) {
      addAlert(alerts, 'OpenCode probe error: ' + (error && error.message ? error.message : String(error)), true);
    } finally {
      await refresh().catch(function () {});
    }
  }

  bootstrap().catch(function (error) {
    addAlert(byId('alerts'), error.message, true);
  });
})();
`;
