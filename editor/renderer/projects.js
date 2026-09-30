// Projects and their chats: the sidebar tree, switching between projects and chats, settling, and the chat
// title. Loaded after renderer.js and uses its helpers (clearChat, handleEvent, notice, refreshState, …).

const projectsPanel = document.getElementById("projects-panel");
const projectList = document.getElementById("project-list");
const projectSearch = document.getElementById("projects-search");
const chatTitleEl = document.getElementById("chat-title");
const toggleProjectsButton = document.getElementById("toggle-projects");
const settleButton = document.getElementById("settle");
const settledBar = document.getElementById("settled-bar");

let appInfo = null;
let tree = { currentProjectId: null, currentThreadId: null, projects: [] }; // from the main process
let currentThread = null; // summary of the open chat, null for a new one
let chatTitle = "New chat";
let editingSidebar = false; // a name is being typed; the tree isn't re-rendered meanwhile
const collapsedProjects = new Set(JSON.parse(localStorage.getItem("collapsedProjects") ?? "[]"));
const openSettledGroups = new Set();

function currentProject() {
  return tree.projects.find((p) => p.id === tree.currentProjectId) ?? null;
}

// For notifications: which project something happened in.
function currentProjectName() {
  return currentProject()?.name ?? "";
}

function showChatTitle(title) {
  chatTitle = title;
  if (chatView === "chat") chatTitleEl.textContent = title;
  chatTitleEl.title = title;
}

// The composer, or the read-only bar for a settled chat. visible: the chat (not the settings) is shown.
function showComposer(visible = chatView === "chat") {
  const settled = !!currentThread?.settled;
  form.hidden = !visible || settled;
  settledBar.hidden = !visible || !settled;
  settleButton.hidden = !visible || !currentThread || settled;
}

// ---------- tree ----------

async function refreshProjects() {
  try {
    tree = await window.editor.listProjects();
  } catch (err) {
    toast("error", "Couldn't load projects", errorMessage(err));
    return;
  }
  const thread = currentProject()?.threads.find((t) => t.id === tree.currentThreadId);
  if (thread) {
    currentThread = thread;
    showChatTitle(thread.title);
    showComposer();
  }
  if (!editingSidebar) renderProjects();
}

const DAY = 24 * 60 * 60 * 1000;

function shortTime(time) {
  const date = new Date(time);
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (time >= startOfToday) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (time >= startOfToday - 6 * DAY) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

function saveCollapsed() {
  localStorage.setItem("collapsedProjects", JSON.stringify([...collapsedProjects]));
}


function renderProjects() {
  const query = projectSearch.value.trim().toLowerCase();
  projectList.replaceChildren();

  let shown = 0;
  for (const project of tree.projects) {
    const nameMatches = !query || project.name.toLowerCase().includes(query);
    const threads = query && !nameMatches ? project.threads.filter((t) => t.title.toLowerCase().includes(query)) : project.threads;
    if (query && !nameMatches && !threads.length) continue;
    shown++;
    const expanded = query ? true : !collapsedProjects.has(project.id);
    projectList.appendChild(projectRow(project, expanded));
    if (!expanded) continue;

    const open = threads.filter((t) => !t.settled);
    const settled = threads.filter((t) => t.settled);
    for (const thread of open) projectList.appendChild(threadRow(project, thread));
    if (!threads.length && !query) {
      const empty = document.createElement("li");
      empty.className = "thread-empty";
      const start = document.createElement("button");
      start.type = "button";
      start.className = "link-btn";
      start.append(icon("compose"), "Start a chat");
      start.addEventListener("click", (e) => {
        e.stopPropagation();
        startNewChat(project.id);
      });
      empty.append("No chats yet · ", start);
      projectList.appendChild(empty);
    }
    if (settled.length) {
      const showSettled = query || openSettledGroups.has(project.id) || settled.some((t) => t.id === tree.currentThreadId);
      const toggle = document.createElement("li");
      toggle.className = "settled-toggle";
      toggle.append(icon("archive"), `Settled · ${settled.length}`, icon(showSettled ? "chevron-down" : "chevron-right"));
      toggle.addEventListener("click", () => {
        if (openSettledGroups.has(project.id)) openSettledGroups.delete(project.id);
        else openSettledGroups.add(project.id);
        renderProjects();
      });
      projectList.appendChild(toggle);
      if (showSettled) for (const thread of settled) projectList.appendChild(threadRow(project, thread));
    }
  }

  if (!shown) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = query ? "Nothing matches." : "No projects yet.";
    projectList.appendChild(empty);
  }
}

function projectRow(project, expanded) {
  const li = document.createElement("li");
  li.className = "project";
  li.classList.toggle("active", project.id === tree.currentProjectId);
  li.title = `${project.name}\nFolder: maps/${project.slug}`;

  const twisty = icon(expanded ? "chevron-down" : "chevron-right", "twisty");
  twisty.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCollapsed(project.id);
  });
  const name = document.createElement("span");
  name.className = "project-name";
  name.textContent = project.name;
  const count = document.createElement("span");
  count.className = "project-count";
  count.textContent = project.threads.length ? String(project.threads.length) : "";
  li.append(
    twisty,
    icon(expanded ? "folder-open" : "folder"),
    name,
    count,
    rowActions(
      iconButton("compose", "New chat in this project", () => startNewChat(project.id)),
      iconButton("pencil", "Rename project", () => startInlineEdit(li, project.name, (value) => window.editor.renameProject(project.id, value))),
      iconButton("folder-open", "Show the project folder", () => window.editor.showProjectFolder(project.id)),
      iconButton("trash", "Delete project", () => deleteProject(project), "danger"),
    ),
  );

  // A click only folds or unfolds: opening another project swaps the whole scene, so that takes a chat click,
  // "New chat" or a double-click.
  li.title = project.id === tree.currentProjectId ? `${project.name} (open)` : `${project.name}\nDouble-click to open`;
  li.addEventListener("click", () => toggleCollapsed(project.id));
  li.addEventListener("dblclick", () => openProject(project.id));
  return li;
}

function toggleCollapsed(id) {
  if (collapsedProjects.has(id)) collapsedProjects.delete(id);
  else collapsedProjects.add(id);
  saveCollapsed();
  renderProjects();
}

function threadRow(project, thread) {
  const li = document.createElement("li");
  li.className = "thread";
  li.classList.toggle("active", thread.id === tree.currentThreadId);
  li.classList.toggle("settled", thread.settled);
  li.classList.toggle("running", thread.id === tree.currentThreadId && busy);
  li.title = thread.title;

  const title = document.createElement("span");
  title.className = "thread-title";
  title.textContent = thread.title;
  const meta = document.createElement("span");
  meta.className = "thread-meta";
  meta.textContent = thread.id === tree.currentThreadId && busy ? "working…" : shortTime(thread.updatedAt);

  li.append(
    title,
    ...(thread.pinned ? [icon("pin", "pin-mark")] : []),
    meta,
    rowActions(
      iconButton("pin", thread.pinned ? "Unpin" : "Pin to the top", async () => {
        await window.editor.pinThread(project.id, thread.id, !thread.pinned);
        refreshProjects();
      }, thread.pinned ? "pinned" : ""),
      iconButton(thread.settled ? "rotate-left" : "settle", thread.settled ? "Unsettle: make it writable again" : "Settle: mark as done, read-only", () =>
        setSettled(project.id, thread.id, !thread.settled),
      ),
      iconButton("pencil", "Rename", () => startInlineEdit(li, thread.title, (value) => window.editor.renameThread(thread.id, value))),
      iconButton("trash", "Delete", () => deleteThread(project, thread), "danger"),
    ),
  );
  li.addEventListener("click", () => openThread(project.id, thread.id));
  title.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startInlineEdit(li, thread.title, (value) => window.editor.renameThread(thread.id, value));
  });
  return li;
}

// Replaces a row with a text field; Enter saves, Escape cancels. replaceRow null: a new row at the top.
function startInlineEdit(replaceRow, initial, commit, placeholder = "") {
  editingSidebar = true;
  const row = document.createElement("li");
  row.className = "inline-edit";
  const field = document.createElement("input");
  field.value = initial;
  field.placeholder = placeholder;
  row.appendChild(field);
  if (replaceRow) replaceRow.replaceWith(row);
  else projectList.prepend(row);
  field.focus();
  field.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    editingSidebar = false;
    const value = field.value.trim();
    if (save && value && value !== initial) {
      try {
        await commit(value);
      } catch (err) {
        toast("error", "Couldn't rename", errorMessage(err));
      }
    }
    refreshProjects();
  };
  field.addEventListener("click", (e) => e.stopPropagation());
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  field.addEventListener("blur", () => finish(true));
}

projectSearch.addEventListener("input", renderProjects);
projectSearch.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    projectSearch.value = "";
    renderProjects();
  }
});

// ---------- opening projects and chats ----------

// The scene is shared, so the agent has to finish (or be stopped) before anything else opens.
function blockedWhileBusy() {
  if (!busy) return false;
  toast("warning", "The agent is still working", "Wait for it to finish or press Stop, then try again.");
  return true;
}

// Shows what the main process opened: the project's map comes with it, the chat's history is replayed.
function showOpened(opened) {
  tree.currentProjectId = opened.project.id;
  tree.currentThreadId = opened.thread?.id ?? null;
  currentThread = opened.thread;
  collapsedProjects.delete(opened.project.id);
  clearChat();
  for (const event of opened.events) handleEvent(event, true);
  finishPendingTools(); // steps of an interrupted turn
  if (!opened.events.length) showWelcome();
  showChatTitle(opened.thread?.title ?? "New chat");
  setSettingsOpen(false);
  showComposer();
  refreshProjects();
  refreshState();
  scrollToEnd();
  if (!currentThread?.settled) input.focus();
}

let opening = false; // one switch at a time

// switchTo: the project being opened when it isn't the current one (shows the transition), else undefined.
async function run(action, failure, switchTo) {
  if (blockedWhileBusy() || opening) return;
  opening = true;
  const switching = switchTo !== undefined;
  if (switching) beginSwitch(switchTo);
  try {
    const opened = await action();
    if (opened) {
      const changed = opened.project.id !== tree.currentProjectId;
      showOpened(opened);
      if (changed) {
        const p = tree.projects.find((x) => x.id === opened.project.id);
        const chats = p?.threads.length ?? 0;
        const detail = [opened.project.propCount != null && `${opened.project.propCount} props`, `${chats} chat${chats === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
        toast("success", `Opened ${opened.project.name}`, detail);
      }
    }
  } catch (err) {
    toast("error", failure, errorMessage(err));
    refreshProjects();
  } finally {
    opening = false;
    if (switching) endSwitch();
  }
}

const projectName = (id) => tree.projects.find((p) => p.id === id)?.name ?? "";
const switchName = (projectId) => (projectId !== tree.currentProjectId ? projectName(projectId) : undefined);

function openProject(id) {
  if (id === tree.currentProjectId) return;
  return run(() => window.editor.openProject(id), "Couldn't open the project", projectName(id));
}

function openThread(projectId, id) {
  if (projectId === tree.currentProjectId && id === tree.currentThreadId) return;
  return run(() => window.editor.openThread(projectId, id), "Couldn't open the chat", switchName(projectId));
}

function startNewChat(projectId = tree.currentProjectId) {
  return run(() => window.editor.newThread(projectId), "Couldn't start a chat", switchName(projectId));
}

function createProject() {
  if (blockedWhileBusy()) return;
  setProjectsOpen(true);
  startInlineEdit(null, "", (name) => run(() => window.editor.createProject(name), "Couldn't create the project", name), "New project name");
}

// The file picker comes first, so the transition only shows the generic loading screen behind the view.
function importProject() {
  return run(() => window.editor.importProject(), "Couldn't import the map");
}

async function deleteProject(project) {
  if (project.id === tree.currentProjectId && blockedWhileBusy()) return;
  try {
    if (!(await window.editor.deleteProject(project.id))) return;
  } catch (err) {
    toast("error", "That didn't work", errorMessage(err));
    return;
  }
  if (project.id === tree.currentProjectId) showOpened(await window.editor.currentProject());
  else refreshProjects();
}

async function deleteThread(project, thread) {
  try {
    if (!(await window.editor.deleteThread(project.id, thread.id, thread.title))) return;
  } catch (err) {
    toast("error", "That didn't work", errorMessage(err));
    return;
  }
  if (thread.id === tree.currentThreadId) showOpened(await window.editor.currentProject());
  else refreshProjects();
}

async function setSettled(projectId, id, settled) {
  try {
    await window.editor.settleThread(projectId, id, settled);
  } catch (err) {
    toast("error", "That didn't work", errorMessage(err));
    return;
  }
  if (id === tree.currentThreadId && currentThread) {
    currentThread.settled = settled;
    showComposer();
    if (!settled) input.focus();
  }
  refreshProjects();
}

settleButton.addEventListener("click", () => currentThread && setSettled(tree.currentProjectId, currentThread.id, true));
document.getElementById("unsettle").addEventListener("click", () => currentThread && setSettled(tree.currentProjectId, currentThread.id, false));

// Called by renderer.js when a new chat gets its id with the first reply.
function onThreadStarted(id) {
  tree.currentThreadId = id;
  currentThread = { id, title: "New chat", settled: false, pinned: false };
  showComposer();
  refreshProjects();
}

// The SDK writes a chat's title shortly after the first reply, so look again a little later.
function onTurnDone() {
  refreshProjects();
  setTimeout(refreshProjects, 5000);
}

window.editor.onMapChanged(() => refreshState());

// ---------- sidebar ----------

function setProjectsOpen(open) {
  projectsPanel.hidden = !open;
  toggleProjectsButton.classList.toggle("active", open);
  toggleProjectsButton.title = open ? "Hide projects (Ctrl+B)" : "Show projects (Ctrl+B)";
  localStorage.setItem("projectsOpen", open ? "1" : "0");
  if (open) refreshProjects();
}

toggleProjectsButton.addEventListener("click", () => setProjectsOpen(projectsPanel.hidden));
document.getElementById("project-new").addEventListener("click", createProject);
document.getElementById("project-import").addEventListener("click", importProject);
document.getElementById("new-chat").addEventListener("click", () => startNewChat());

document.addEventListener("keydown", (e) => {
  if (!e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "n" && !e.shiftKey) {
    e.preventDefault();
    startNewChat();
  } else if (key === "b" && !e.shiftKey) {
    e.preventDefault();
    setProjectsOpen(projectsPanel.hidden);
  } else if (key === "k") {
    e.preventDefault();
    setProjectsOpen(true);
    projectSearch.focus();
    projectSearch.select();
  }
});

// Mark the running chat in the tree while the agent works.
new MutationObserver(() => {
  if (!editingSidebar) renderProjects();
}).observe(stopButton, { attributes: true, attributeFilter: ["disabled"] });

// ---------- start-up: the project and chat that were open last time ----------

(async () => {
  appInfo = await window.editor.appInfo();
  setProjectsOpen(localStorage.getItem("projectsOpen") !== "0");
  showOpened(await window.editor.currentProject());
})();
