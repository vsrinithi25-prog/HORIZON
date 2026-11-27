/* HORIZON interface controller. The server remains the source of truth. */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  user: null,
  data: null,
  page: 'overview',
  projectId: null,
  workspaceId: null,
  authMode: 'login',
  socket: null,
  calendar: []
};

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));

async function api(url, options = {}) {
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(state.user?.csrf_token ? { 'X-CSRF-Token': state.user.csrf_token } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  let result;

  if (contentType.includes('json')) {
    try {
      result = await response.json();
    } catch {
      result = null;
    }
  } else {
    result = await response.text();
  }

  if (!response.ok) {
    const message =
      result?.error ||
      result?.message ||
      (response.status >= 500
        ? `The server had a problem (${response.status}). Check the Render logs.`
        : `Request failed (${response.status}).`);

    throw new Error(message);
  }

  return result;
}

function toast(message) {
  const element = $('#toast');
  if (!element) return;

  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}

function openDialog(dialog) {
  dialog.showModal();
}

function closeDialogs() {
  $$('dialog[open]').forEach(dialog => dialog.close());
}

async function boot() {
  try {
    state.user = await api('/api/me');
    $('#welcome').hidden = true;
    $('#app').hidden = false;
    $('#profile-name').textContent = state.user.name;
    $('#profile-email').textContent = state.user.email;
    $('#profile-avatar').textContent = (state.user.name[0] || 'H').toUpperCase();
    document.documentElement.dataset.theme =
      state.user.theme === 'dark' ? 'dark' : 'light';

    await refresh();
    render();
  } catch {
    $('#welcome').hidden = false;
    $('#app').hidden = true;

    if (new URLSearchParams(location.search).get('login')) {
      showAuth('login');
    }

    if (new URLSearchParams(location.search).get('verified')) {
      toast('Email verified. You can now sign in.');
    }
  }
}

async function refresh() {
  const query = state.workspaceId
    ? `?workspace_id=${state.workspaceId}`
    : '';

  state.data = await api(`/api/dashboard${query}`);
  state.user.workspaces = state.data.workspaces;

  if (!state.workspaceId && state.data.workspaces.length) {
    state.workspaceId = state.data.workspaces[0].id;
  }

  const picker = $('#workspace-select');
  picker.innerHTML = state.data.workspaces
    .map(workspace =>
      `<option value="${workspace.id}">${esc(workspace.name)} · ${workspace.kind === 'team' ? 'Team' : 'Personal'}</option>`
    )
    .join('');
  picker.value = state.workspaceId || '';

  if (
    !state.projectId ||
    !state.data.projects.some(project => project.id === state.projectId)
  ) {
    state.projectId = state.data.projects[0]?.id || null;
  }

  $('#crumb-space').textContent =
    state.data.workspaces.find(workspace => workspace.id === state.workspaceId)?.name ||
    'My workspace';

  $('#project-nav').innerHTML = state.data.projects
    .map(project => `
      <a href="#" class="project-link ${state.projectId === project.id ? 'selected' : ''}" data-project="${project.id}">
        <i class="project-color" style="background:${esc(project.color)}"></i>
        ${esc(project.name)}
        <small>${state.data.tasks.filter(task => task.project_id === project.id && task.status !== 'done').length}</small>
      </a>
    `)
    .join('') || '<div class="subtle" style="padding:7px 10px">No projects yet</div>';

  $('#task-project').innerHTML = state.data.projects
    .map(project => `<option value="${project.id}">${esc(project.name)}</option>`)
    .join('');
}

function setPage(page) {
  state.page = page;
  $$('.nav-item').forEach(item =>
    item.classList.toggle('active', item.dataset.page === page)
  );
  $('#sidebar').classList.remove('open');
  render();
}

function projectTasks(projectId = state.projectId) {
  return state.data.tasks.filter(
    task => !projectId || task.project_id === Number(projectId)
  );
}

function taskRow(task) {
  const project = state.data.projects.find(item => item.id === task.project_id);

  return `
    <div class="task-row">
      <button class="task-check" data-complete="${task.id}" title="Mark complete"></button>
      <div class="task-main">
        <b>${esc(task.title)}</b>
        <small>${esc(project?.name || 'Project')}</small>
      </div>
      <span class="priority ${esc(task.priority)}">${esc(task.priority)}</span>
      <span class="task-date">
        ${task.due_date
          ? new Date(`${task.due_date}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          : ''}
      </span>
    </div>
  `;
}

function projectCard(project) {
  const tasks = state.data.tasks.filter(task => task.project_id === project.id);
  const done = tasks.filter(task => task.status === 'done').length;

  return `
    <button class="project-card" data-open-project="${project.id}">
      <div class="project-card-top">
        <i class="project-dot" style="background:${esc(project.color)}"></i>
        <span class="subtle">↗</span>
      </div>
      <h4>${esc(project.name)}</h4>
      <p>${esc(project.description || 'A good place for your next steps.')}</p>
      <div class="project-card-foot">
        <span>${done} of ${tasks.length} complete</span>
        <span>${tasks.length - done} open</span>
      </div>
    </button>
  `;
}

function heading(kicker, title, description, button = '') {
  return `
    <div class="page-heading">
      <div>
        <div class="eyebrow">${kicker}</div>
        <h2>${title}</h2>
        <p>${description}</p>
      </div>
      ${button}
    </div>
  `;
}

function overview() {
  const stats = state.data.stats;
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
  const tasks = state.data.tasks.filter(task => task.status !== 'done').slice(0, 5);

  return `
    <div class="welcome-line">
      <div>
        <div class="eyebrow">${today.toUpperCase()}</div>
        <h2>Good day, ${esc(state.user.name.split(' ')[0])}.</h2>
        <p>A little progress adds up. Here’s what’s moving.</p>
      </div>
      <button class="button button-primary" data-action="new-task">＋ New task</button>
    </div>

    <div class="stats-grid">
      <div class="stat-card"><span>ACTIVE PROJECTS</span><strong>${stats.projects}</strong><div class="stat-note">Places where things grow</div></div>
      <div class="stat-card"><span>OPEN TASKS</span><strong>${stats.open}</strong><div class="stat-note">Ready for your attention</div></div>
      <div class="stat-card"><span>COMPLETED</span><strong>${stats.done}</strong><div class="stat-note">Good work, already done</div></div>
      <div class="stat-card"><span>OVERDUE</span><strong class="${stats.overdue ? 'stat-accent' : ''}">${stats.overdue}</strong><div class="stat-note">A chance to reset priorities</div></div>
    </div>

    <div class="dashboard-grid">
      <section>
        <div class="section-heading">
          <h3>Your projects</h3>
          <button class="text-button" data-action="new-project">＋ New project</button>
        </div>
        <div class="project-grid">
          ${state.data.projects.slice(0, 4).map(projectCard).join('') ||
            `<div class="panel empty-state"><strong>A fresh start</strong>Create a project to gather related work in one place.<button class="text-button" data-action="new-project"> Create your first project</button></div>`}
        </div>
      </section>

      <section>
        <div class="section-heading">
          <h3>Coming up</h3>
          <span class="subtle">Your open tasks</span>
        </div>
        <div class="panel">
          ${tasks.map(taskRow).join('') ||
            '<div class="empty-state"><strong>Room to breathe.</strong>Nothing urgent on your list.</div>'}
        </div>
      </section>
    </div>
  `;
}

function projectsPage() {
  return `
    ${heading(
      'YOUR WORKSPACE',
      'Projects',
      'A clear view of the work you’re moving forward.',
      '<button class="button button-primary" data-action="new-project">＋ New project</button>'
    )}
    <div class="project-grid">
      ${state.data.projects.map(projectCard).join('') ||
        '<div class="panel empty-state"><strong>Start with one project.</strong>Bring a goal and its tasks together.</div>'}
    </div>
  `;
}

function projectView() {
  const project = state.data.projects.find(item => item.id === state.projectId);
  if (!project) return projectsPage();

  const tasks = projectTasks(project.id);

  return `
    ${heading(
      'PROJECT',
      esc(project.name),
      esc(project.description || 'Plan the work, keep it moving, and see what comes next.'),
      '<button class="button button-primary" data-action="new-task">＋ Add task</button>'
    )}
    <div class="toolbar" style="margin-bottom:16px">
      <button class="button button-quiet button-small" data-view="list">List</button>
      <button class="button button-quiet button-small" data-view="board">Board</button>
      <a class="button button-quiet button-small" href="/api/projects/${project.id}/export.csv">Export CSV</a>
      <label class="button button-quiet button-small" for="csv-import">Import CSV</label>
      <input hidden id="csv-import" type="file" accept=".csv">
    </div>
    <div id="project-view">${taskTable(tasks)}</div>
  `;
}

function taskTable(tasks) {
  return `
    <div class="panel table-wrap">
      <table class="task-table">
        <thead>
          <tr><th>TASK</th><th>STATUS</th><th>PRIORITY</th><th>DUE DATE</th><th>DEPENDENCIES</th><th></th></tr>
        </thead>
        <tbody>
          ${tasks.map(task => `
            <tr>
              <td>${esc(task.title)}${task.parent_id ? '<span class="subtle"> · subtask</span>' : ''}</td>
              <td>
                <select class="select-small" data-status="${task.id}">
                  <option value="todo" ${task.status === 'todo' ? 'selected' : ''}>To do</option>
                  <option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>In progress</option>
                  <option value="done" ${task.status === 'done' ? 'selected' : ''}>Done</option>
                </select>
              </td>
              <td><span class="priority ${esc(task.priority)}">${esc(task.priority)}</span></td>
              <td>${task.due_date || '—'}</td>
              <td>${task.delay_impact ? `<span class="subtle">${task.delay_impact} downstream</span>` : '—'}</td>
              <td><button class="icon-button" data-trash="${task.id}" title="Move to trash">⌫</button></td>
            </tr>
          `).join('') ||
            '<tr><td colspan="6" class="empty-state">No tasks here yet. Add your first next step.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function boardView(tasks) {
  const columns = [
    ['todo', 'To do'],
    ['in_progress', 'In progress'],
    ['done', 'Done']
  ];

  return `
    <div class="board">
      ${columns.map(([status, label]) => `
        <div class="board-column">
          <div class="board-column-head">
            ${label}<span>${tasks.filter(task => task.status === status).length}</span>
          </div>
          ${tasks.filter(task => task.status === status).map(task => `
            <div class="board-card">
              <b>${esc(task.title)}</b>
              <div class="board-card-foot">
                <span class="priority ${esc(task.priority)}">${esc(task.priority)}</span>
                <select class="select-small" data-status="${task.id}">
                  <option value="todo" ${status === 'todo' ? 'selected' : ''}>To do</option>
                  <option value="in_progress" ${status === 'in_progress' ? 'selected' : ''}>In progress</option>
                  <option value="done" ${status === 'done' ? 'selected' : ''}>Done</option>
                </select>
              </div>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function myTasks() {
  const tasks = state.data.tasks.filter(task => task.status !== 'done');

  return `
    ${heading(
      'YOUR FOCUS',
      'My tasks',
      'The open work across your spaces.',
      '<button class="button button-primary" data-action="new-task">＋ New task</button>'
    )}
    <div class="panel">
      ${tasks.map(taskRow).join('') ||
        '<div class="empty-state"><strong>All caught up.</strong>There are no open tasks right now.</div>'}
    </div>
  `;
}

/* This loads saved events from the server and displays them beside task due dates. */
async function calendarPage() {
  const calendarData = await api('/api/calendar');
  state.calendar = calendarData.events || [];

  const start = new Date();
  start.setDate(1);

  const offset = (start.getDay() + 6) % 7;
  const numberOfDays = new Date(
    start.getFullYear(),
    start.getMonth() + 1,
    0
  ).getDate();

  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

  const calendarCells = Array.from({ length: numberOfDays }, (_, index) => {
    const day = index + 1;
    const dateKey =
      `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const tasks = state.data.tasks.filter(task => task.due_date === dateKey);

    const events = state.calendar.filter(event => {
      const date = new Date(event.starts_at);
      return date.getFullYear() === start.getFullYear()
        && date.getMonth() === start.getMonth()
        && date.getDate() === day;
    });

    return `
      <div class="calendar-cell">
        <b>${day}</b>
        ${tasks.map(task => `<div class="calendar-event">${esc(task.title)}</div>`).join('')}
        ${events.map(event => `<div class="calendar-event">${esc(event.title)}</div>`).join('')}
      </div>
    `;
  }).join('');

  return `
    ${heading(
      'YOUR TIME',
      'Calendar',
      `${start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} · tasks and events at a glance.`,
      '<button class="button button-quiet button-small" data-action="new-event">＋ Add event</button>'
    )}
    <div class="panel">
      <div class="calendar-grid">
        ${days.map(day => `<div class="calendar-cell head">${day}</div>`).join('')}
        ${Array.from({ length: offset }, () => '<div class="calendar-cell"></div>').join('')}
        ${calendarCells}
      </div>
    </div>
    <p class="subtle" style="margin-top:13px">
      Google Calendar connection is available after OAuth credentials are configured.
    </p>
  `;
}

async function messagesPage() {
  const workspace = state.data.workspaces.find(
    item => item.id === state.workspaceId
  );

  if (!workspace) {
    return '<div class="empty-state">Create a workspace to start a conversation.</div>';
  }

  try {
    const data = await api(`/api/messages/${workspace.id}`);

    return `
      ${heading('TEAM SPACE', 'Messages', 'Short updates, shared context and a little momentum.')}
      <div class="panel">
        <div id="message-list" class="message-list">
          ${data.messages.map(messageHtml).join('') ||
            '<div class="empty-state" id="message-empty">Say hello to your team.</div>'}
        </div>
        <form class="message-form" id="message-form">
          <input name="body" required maxlength="4000" placeholder="Write a message…">
          <button class="button button-primary button-small" type="submit">Send</button>
        </form>
      </div>
    `;
  } catch (error) {
    return `<div class="panel empty-state">${esc(error.message)}</div>`;
  }
}

function messageHtml(message) {
  return `
    <div class="message" data-message-id="${message.id}">
      <div class="profile-avatar">${esc((message.name || '?')[0].toUpperCase())}</div>
      <div>
        <b>${esc(message.name)}</b>
        <time>${new Date(message.created_at).toLocaleString()}</time>
        <p>${esc(message.body)}</p>
      </div>
    </div>
  `;
}

function appendMessage(message) {
  const list = $('#message-list');
  if (!list || list.querySelector(`[data-message-id="${message.id}"]`)) return;

  $('#message-empty')?.remove();
  list.insertAdjacentHTML('beforeend', messageHtml(message));
  list.scrollTop = list.scrollHeight;
}

async function automationsPage() {
  const data = await api('/api/automations');

  return `
    ${heading('GENTLE ROUTINES', 'Automations', 'Small helpful rules that take care of repeated nudges.')}
    <div class="panel">
      ${data.templates.map(item => `
        <div class="setting-row">
          <div>
            <b>${esc(item.name)}</b>
            <small>When ${esc(item.trigger.replaceAll('_', ' '))} → ${esc(item.action.replaceAll('_', ' '))}</small>
          </div>
          <input class="switch" type="checkbox" data-automation="${item.id}" ${item.enabled ? 'checked' : ''} aria-label="Enable ${esc(item.name)}">
        </div>
      `).join('') ||
        '<div class="empty-state">Create a workspace to get starter templates.</div>'}
      <p class="subtle">Templates are configurable. Scheduled background execution requires a worker and production scheduler configuration.</p>
    </div>
  `;
}

function analyticsPage() {
  const stats = state.data.stats;
  const total = Math.max(1, stats.open + stats.done);
  const completedPercent = Math.round(stats.done / total * 100);

  return `
    ${heading('A WIDER VIEW', 'Insights', 'A simple pulse on the work happening in your spaces.')}
    <div class="stats-grid">
      <div class="stat-card"><span>PROJECTS</span><strong>${stats.projects}</strong><div class="stat-note">Active spaces for your work</div></div>
      <div class="stat-card"><span>OPEN TASKS</span><strong>${stats.open}</strong><div class="stat-note">Things still in motion</div></div>
      <div class="stat-card"><span>COMPLETED</span><strong>${stats.done}</strong><div class="stat-note">Steps taken to the finish</div></div>
      <div class="stat-card"><span>OVERDUE</span><strong>${stats.overdue}</strong><div class="stat-note">May need a new plan</div></div>
    </div>
    <div class="panel" style="margin-top:15px">
      <div class="section-heading">
        <h3>Work completed</h3>
        <span class="subtle">Current task set</span>
      </div>
      <div style="height:12px;background:var(--surface-2);border-radius:7px;overflow:hidden">
        <div style="height:100%;width:${completedPercent}%;background:var(--sage);border-radius:7px"></div>
      </div>
      <p class="subtle">${completedPercent}% of tracked tasks are complete.</p>
    </div>
  `;
}

async function trashPage() {
  const data = await api('/api/trash');

  return `
    ${heading('PERSONAL', 'Recently deleted', 'Tasks can be restored from here.')}
    <div class="panel">
      ${data.tasks.map(task => `
        <div class="task-row">
          <div class="task-main">
            <b>${esc(task.title)}</b>
            <small>Deleted ${new Date(task.deleted_at).toLocaleDateString()}</small>
          </div>
          <button class="button button-quiet button-small" data-restore="${task.id}">Restore</button>
        </div>
      `).join('') ||
        '<div class="empty-state"><strong>Nothing in the bin.</strong>Deleted tasks will show up here.</div>'}
    </div>
  `;
}

function settingsPage() {
  return `
    ${heading('PERSONAL', 'Settings', 'Make HORIZON feel like your own.')}
    <div class="settings-layout">
      <div class="panel">
        <div class="section-heading"><h3>Your profile</h3></div>
        <div class="setting-row">
          <div><b>${esc(state.user.name)}</b><small>${esc(state.user.email)}</small></div>
        </div>
        <form id="profile-form" class="message-form">
          <input name="name" value="${esc(state.user.name)}" maxlength="100" aria-label="Your name">
          <button class="button button-primary button-small">Save</button>
        </form>
      </div>

      <div class="panel">
        <div class="section-heading"><h3>Appearance</h3></div>
        <div class="setting-row">
          <div><b>Theme</b><small>Choose a comfortable palette.</small></div>
          <select id="theme-select" class="select-small">
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="scheduled">Scheduled</option>
          </select>
        </div>
      </div>

      <div class="panel">
        <div class="section-heading"><h3>Connected services</h3></div>
        <div class="feature-card">
          <span class="feature-icon">▧</span>
          <div><b>Google Calendar</b><p>Connect calendars after setting up OAuth credentials in your environment.</p></div>
          <span class="integration-badge">SETUP NEEDED</span>
        </div>
      </div>

      <div class="panel">
        <div class="section-heading"><h3>Security</h3></div>
        <div class="feature-card">
          <span class="feature-icon">✓</span>
          <div><b>Protected sign in</b><p>Passwords are stored as one-way hashes. Sessions use HTTP-only cookies.</p></div>
        </div>
      </div>
    </div>
  `;
}

async function render() {
  if (!state.data) return;

  const content = $('#content');
  $('#crumb-page').textContent =
    state.page === 'project'
      ? state.data.projects.find(project => project.id === state.projectId)?.name || 'Project'
      : state.page.replaceAll('-', ' ').replace(/\b\w/g, character => character.toUpperCase());

  content.innerHTML = '<div class="empty-state">Gathering your space…</div>';

  const pages = {
    overview,
    projects: projectsPage,
    'my-tasks': myTasks,
    project: projectView,
    calendar: calendarPage,
    analytics: analyticsPage,
    settings: settingsPage,
    trash: trashPage,
    automations: automationsPage,
    messages: messagesPage
  };

  try {
    const html = await (pages[state.page]?.() || '<div class="empty-state">This view is not available yet.</div>');
    content.innerHTML = html;
    wireContent();
  } catch (error) {
    content.innerHTML = `<div class="panel empty-state">${esc(error.message)}</div>`;
  }
}

function showAuth(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';

  $('#auth-title').textContent = isRegister
    ? 'A little more room to focus.'
    : 'Welcome back.';
  $('#auth-submit').textContent = isRegister
    ? 'Create my workspace'
    : 'Sign in';
  $('#name-field').hidden = !isRegister;
  $('#auth-name').required = isRegister;
  $('#auth-password').autocomplete = isRegister
    ? 'new-password'
    : 'current-password';
  $('#auth-switch-text').textContent = isRegister
    ? 'Already have a space?'
    : 'New to HORIZON?';
  $('#auth-switch').textContent = isRegister
    ? 'Sign in'
    : 'Create an account';

  openDialog($('#auth-dialog'));
}

function showCreate(kind) {
  $('#create-kind').value = kind;
  const isProject = kind === 'project';
  $('#create-title').textContent = isProject
    ? 'New project'
    : 'New team workspace';
  $('#create-name').placeholder = isProject
    ? 'What are we working on?'
    : 'Give your team a name';
  $('#description-wrap').hidden = !isProject;
  openDialog($('#create-dialog'));
}

function showTask() {
  if (!state.data.projects.length) {
    toast('Create a project before adding tasks.');
    showCreate('project');
    return;
  }

  $('#task-project').value = state.projectId || state.data.projects[0].id;
  openDialog($('#task-dialog'));
}

function wireContent() {
  $$('[data-action]').forEach(button => {
    const actions = {
      'new-task': showTask,
      'new-project': () => showCreate('project'),
      'new-event': createEvent
    };
    button.onclick = actions[button.dataset.action] || (() => {});
  });

  $$('[data-open-project]').forEach(button => {
    button.onclick = () => {
      state.projectId = Number(button.dataset.openProject);
      setPage('project');
    };
  });

  $$('[data-complete]').forEach(button => {
    button.onclick = async () => {
      try {
        await api(`/api/tasks/${button.dataset.complete}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'done' })
        });
        await refresh();
        await render();
      } catch (error) {
        toast(error.message);
      }
    };
  });

  $$('[data-status]').forEach(select => {
    select.onchange = async () => {
      try {
        await api(`/api/tasks/${select.dataset.status}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: select.value })
        });
        await refresh();
        await render();
      } catch (error) {
        toast(error.message);
      }
    };
  });

  $$('[data-trash]').forEach(button => {
    button.onclick = async () => {
      try {
        await api(`/api/tasks/${button.dataset.trash}`, { method: 'DELETE' });
        await refresh();
        await render();
        toast('Task moved to recently deleted.');
      } catch (error) {
        toast(error.message);
      }
    };
  });

  $$('[data-restore]').forEach(button => {
    button.onclick = async () => {
      try {
        await api(`/api/tasks/${button.dataset.restore}/restore`, { method: 'POST' });
        await refresh();
        await render();
      } catch (error) {
        toast(error.message);
      }
    };
  });

  $$('[data-view]').forEach(button => {
    button.onclick = () => {
      $('#project-view').innerHTML =
        button.dataset.view === 'board'
          ? boardView(projectTasks())
          : taskTable(projectTasks());
      wireContent();
    };
  });

  const csvInput = $('#csv-import');
  if (csvInput) {
    csvInput.onchange = async () => {
      if (!csvInput.files.length) return;

      const formData = new FormData();
      formData.set('file', csvInput.files[0]);
      formData.set('project_id', state.projectId);

      try {
        const result = await api('/api/tasks/import', {
          method: 'POST',
          body: formData
        });
        await refresh();
        await render();
        toast(`${result.imported} tasks imported.`);
      } catch (error) {
        toast(error.message);
      }
    };
  }

  $$('[data-automation]').forEach(checkbox => {
    checkbox.onchange = async () => {
      try {
        await api(`/api/automations/${checkbox.dataset.automation}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: checkbox.checked })
        });
      } catch (error) {
        toast(error.message);
        checkbox.checked = !checkbox.checked;
      }
    };
  });

  const messageForm = $('#message-form');
  if (messageForm) {
    messageForm.onsubmit = async event => {
      event.preventDefault();

      const input = messageForm.elements.body;
      const sendButton = messageForm.querySelector('button[type="submit"]');
      const body = input.value.trim();

      if (!body || sendButton.disabled) return;

      sendButton.disabled = true;

      try {
        const message = await api(`/api/messages/${state.workspaceId}`, {
          method: 'POST',
          body: JSON.stringify({ body })
        });

        input.value = '';
        appendMessage(message);
        toast('Message sent.');
      } catch (error) {
        toast(error.message);
      } finally {
        sendButton.disabled = false;
        input.focus();
      }
    };

    if (window.io) {
      if (state.socket) state.socket.disconnect();

      state.socket = io();
      state.socket.emit('join_workspace', {
        workspace_id: state.workspaceId
      });
      state.socket.on('message', appendMessage);
      state.socket.on('presence', presence => {
        if (presence.state === 'online') {
          toast(`${presence.name} is here.`);
        }
      });
    }
  }

  const profileForm = $('#profile-form');
  if (profileForm) {
    profileForm.onsubmit = async event => {
      event.preventDefault();

      try {
        const name = new FormData(profileForm).get('name');
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ name })
        });

        state.user.name = name;
        $('#profile-name').textContent = name;
        toast('Profile updated.');
      } catch (error) {
        toast(error.message);
      }
    };
  }

  const themeSelect = $('#theme-select');
  if (themeSelect) {
    themeSelect.value = state.user.theme;

    themeSelect.onchange = async () => {
      try {
        await api('/api/settings', {
          method: 'PATCH',
          body: JSON.stringify({ theme: themeSelect.value })
        });

        state.user.theme = themeSelect.value;
        document.documentElement.dataset.theme =
          themeSelect.value === 'dark' ? 'dark' : 'light';
      } catch (error) {
        toast(error.message);
      }
    };
  }
}

async function createEvent() {
  const title = prompt('Event name');
  if (!title?.trim()) return;

  const when = prompt('Start date and time (YYYY-MM-DDTHH:MM)', '');
  if (!when) return;

  const startDate = new Date(when);
  if (Number.isNaN(startDate.getTime())) {
    toast('Enter a valid date and time.');
    return;
  }

  try {
    const workspace = state.data.workspaces.find(
      item => item.id === state.workspaceId
    );

    if (!workspace) {
      toast('Choose a workspace first.');
      return;
    }

    await api(`/api/workspaces/${workspace.id}/events`, {
      method: 'POST',
      body: JSON.stringify({
        title: title.trim(),
        starts_at: startDate.toISOString()
      })
    });

    await render();
    toast('Event added to your calendar.');
  } catch (error) {
    toast(error.message);
  }
}

$('#auth-switch').onclick = () =>
  showAuth(state.authMode === 'login' ? 'register' : 'login');

$$('[data-open-auth]').forEach(button => {
  button.onclick = () => showAuth(button.dataset.openAuth);
});

$$('[data-close]').forEach(button => {
  button.onclick = closeDialogs;
});

$$('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
});

$('#auth-form').onsubmit = async event => {
  event.preventDefault();

  const isRegister = state.authMode === 'register';
  const body = {
    email: $('#auth-email').value,
    password: $('#auth-password').value
  };

  if (isRegister) body.name = $('#auth-name').value;

  try {
    const result = await api(
      isRegister ? '/api/register' : '/api/login',
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    );

    closeDialogs();

    if (result.verification_required) {
      toast('Check your email for a verification link.');
      return;
    }

    toast(isRegister ? 'Your space is ready.' : 'Welcome back.');
    await boot();
  } catch (error) {
    toast(error.message);
  }
};

$('#create-form').onsubmit = async event => {
  event.preventDefault();

  const kind = $('#create-kind').value;
  const name = $('#create-name').value.trim();

  try {
    if (kind === 'workspace') {
      const workspace = await api('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      state.workspaceId = workspace.id;
      state.projectId = null;
    } else {
      const workspace = state.data.workspaces.find(
        item => item.id === state.workspaceId
      );
      const project = await api(`/api/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: $('#create-description').value
        })
      });
      state.projectId = project.id;
    }

    closeDialogs();
    event.target.reset();
    await refresh();
    setPage(kind === 'project' ? 'project' : 'projects');
    toast(kind === 'project' ? 'Project created.' : 'Workspace created.');
  } catch (error) {
    toast(error.message);
  }
};

$('#task-form').onsubmit = async event => {
  event.preventDefault();

  const form = event.target;
  const submitButton = form.querySelector('button[type="submit"]');
  const body = {
    title: $('#task-title').value.trim(),
    priority: $('#task-priority').value
  };

  if ($('#task-due').value) {
    body.due_date = $('#task-due').value;
  }

  if (submitButton.disabled) return;
  submitButton.disabled = true;

  try {
    await api(`/api/projects/${$('#task-project').value}/tasks`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    closeDialogs();
    form.reset();

    try {
      await refresh();
      await render();
      toast('Task added.');
    } catch {
      toast('Task was saved, but the page could not refresh. Reload HORIZON to see it.');
    }
  } catch (error) {
    toast(error.message);
  } finally {
    submitButton.disabled = false;
  }
};

$('#workspace-select').onchange = async event => {
  state.workspaceId = Number(event.target.value);
  state.projectId = null;

  try {
    await refresh();
    setPage('overview');
  } catch (error) {
    toast(error.message);
  }
};

$$('.nav-item[data-page]').forEach(button => {
  button.onclick = () => setPage(button.dataset.page);
});

$('#project-nav').onclick = event => {
  const link = event.target.closest('[data-project]');
  if (!link) return;

  event.preventDefault();
  state.projectId = Number(link.dataset.project);
  setPage('project');
};

$('#add-project-nav').onclick = () => showCreate('project');
$('#add-workspace-nav').onclick = () => showCreate('workspace');
$('#new-task-top').onclick = showTask;

$('#logout-button').onclick = async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } finally {
    state.user = null;
    state.data = null;
    $('#app').hidden = true;
    $('#welcome').hidden = false;
  }
};

$('#theme-toggle').onclick = async () => {
  const nextTheme =
    document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';

  document.documentElement.dataset.theme = nextTheme;

  if (state.user) {
    try {
      await api('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ theme: nextTheme })
      });
      state.user.theme = nextTheme;
    } catch (error) {
      toast(error.message);
    }
  }
};

$('#notifications').onclick = () =>
  toast(`${state.data?.notifications || 0} unread notifications.`);

$('#mobile-menu').onclick = () =>
  $('#sidebar').classList.toggle('open');

boot();