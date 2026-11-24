import { parseSnapshot, pathKey, searchProjects } from '../catalog.mjs';
import { agentColor, formatAgo, renderGraph } from './graph.js';

const $ = (id) => document.getElementById(id);
const drawersEl = $('drawers');
const agentBarEl = $('agent-bar');
const contentEl = $('content');
const queryEl = $('query');
const sortSelectEl = $('sort-select');
const themeToggleBtn = $('theme-toggle');
const importDialogEl = $('import-dialog');
const snapshotEl = $('snapshot');
const dialogErrorEl = $('dialog-error');
const importSubmitBtn = $('import-submit');
const drawerDialogEl = $('drawer-dialog');
const drawerParentEl = $('drawer-parent');
const drawerNameEl = $('drawer-name');
const drawerErrorEl = $('drawer-error');
const assignDialogEl = $('assign-dialog');
const assignSelectEl = $('assign-select');
const assignNewEl = $('assign-new');
const assignErrorEl = $('assign-error');
const toastEl = $('toast');

const THEME_CYCLE = ['auto', 'light', 'dark'];
const THEME_LABELS = { auto: '◐ 跟随', light: '☀ 纸白', dark: '☾ 暗木' };

const requests = new Map();
let nextId = 1;
let connected = false;
let mutating = false;
let toastTimer = null;
let cardIndex = 0;
let assignTargetProject = null;

const state = {
  projects: [],
  customDrawers: [],
  prefs: { theme: 'auto', sort: 'default' },
  view: { kind: 'all', path: [] }, // 'all' | 'pinned' | 'tree' | 'discovered' | 'unsorted' | 'category'
  query: '',
  agentFilter: null,
  draggingPath: null,
};

// ---------- TPI 2.0 通信 ----------

function ask(message) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error('天枢没有及时响应，请重试'));
    }, 10_000);
    requests.set(id, { resolve, reject, timer });
    parent.postMessage({ tpi: 'view', type: 'post', id, message }, '*');
  });
}

function setStatus(text, isError = false) {
  const node = $('cabinet-status');
  node.textContent = text;
  node.classList.toggle('error', isError);
}

function toast(text, isError = false) {
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.className = isError ? 'toast error' : 'toast';
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 4200 : 2400);
}

async function copyPath(path, name) {
  try {
    await navigator.clipboard.writeText(path);
    toast(`已复制路径：${name || path}`);
    return;
  } catch {
    // 回退复制
  }
  try {
    const temp = document.createElement('textarea');
    temp.value = path;
    temp.setAttribute('readonly', '');
    temp.style.position = 'fixed';
    temp.style.opacity = '0';
    document.body.append(temp);
    temp.select();
    const ok = document.execCommand('copy');
    temp.remove();
    if (ok) {
      toast(`已复制路径：${name || path}`);
      return;
    }
  } catch {
    // 忽略
  }
  toast(`路径：${path}`);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'onClick') node.addEventListener('click', v);
    else if (k.startsWith('aria')) node.setAttribute(`aria-${k.slice(4).toLowerCase()}`, String(v));
    else node[k] = v;
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function samePath(a, b) {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

function applyPrefs(prefs) {
  state.prefs = {
    theme: THEME_CYCLE.includes(prefs?.theme) ? prefs.theme : 'auto',
    sort: ['default', 'recent', 'sessions'].includes(prefs?.sort) ? prefs.sort : 'default',
  };
  if (state.prefs.theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', state.prefs.theme);
  }
  themeToggleBtn.textContent = THEME_LABELS[state.prefs.theme];
  sortSelectEl.value = state.prefs.sort;
}

function sortItems(items) {
  const list = [...items];
  const mode = state.prefs.sort;
  return list.sort((a, b) => {
    const pinDiff = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinDiff !== 0) return pinDiff;
    if (mode === 'recent') {
      const timeDiff = (b.lastActive || 0) - (a.lastActive || 0);
      if (timeDiff !== 0) return timeDiff;
    } else if (mode === 'sessions') {
      const sessDiff = (b.sessions || 0) - (a.sessions || 0);
      if (sessDiff !== 0) return sessDiff;
    }
    return a.name.localeCompare(b.name, 'zh-Hans-CN') || a.path.localeCompare(b.path);
  });
}

function buildCategoryTree(projects, customDrawers) {
  const topMap = new Map();
  let unsortedCount = 0;
  let discoveredCount = 0;

  function ensureTop(name) {
    if (!topMap.has(name)) {
      topMap.set(name, { name, path: [name], direct: [], children: new Map(), total: 0 });
    }
    return topMap.get(name);
  }

  for (const cat of customDrawers ?? []) {
    if (cat.length >= 1) {
      const c1 = ensureTop(cat[0]);
      if (cat.length === 2 && !c1.children.has(cat[1])) {
        c1.children.set(cat[1], { name: cat[1], path: [cat[0], cat[1]], items: [] });
      }
    }
  }

  for (const p of projects) {
    if (p.indexed === false) {
      discoveredCount += 1;
      continue;
    }
    if (p.category.length === 0) {
      unsortedCount += 1;
      continue;
    }
    const [c1Name, c2Name] = p.category;
    const c1 = ensureTop(c1Name);
    c1.total += 1;
    if (c2Name) {
      if (!c1.children.has(c2Name)) {
        c1.children.set(c2Name, { name: c2Name, path: [c1Name, c2Name], items: [] });
      }
      c1.children.get(c2Name).items.push(p);
    } else {
      c1.direct.push(p);
    }
  }

  const categories = [...topMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .map((c1) => ({
      ...c1,
      subCategories: [...c1.children.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    }));

  return { categories, unsortedCount, discoveredCount };
}

function filterByAgent(items) {
  if (!state.agentFilter) return items;
  return items.filter((p) => (p.agents ?? []).includes(state.agentFilter));
}

// ---------- 抽屉柜渲染（支持拖放归类） ----------

async function assignProjectToCategory(projectPath, category, label) {
  if (!connected || mutating) return;
  mutating = true;
  try {
    const result = await ask({ action: 'assign', path: projectPath, category });
    state.projects = result.projects;
    if (Array.isArray(result.drawers)) state.customDrawers = result.drawers;
    toast(`已放进抽屉「${label}」`);
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    mutating = false;
  }
}

function drawerButton({ label, count, active, sub = false, dropCategory = null, onSelect }) {
  const btn = el('button', {
    type: 'button',
    className: `drawer${sub ? ' sub' : ''}${active ? ' active' : ''}`,
    onClick: onSelect,
  }, [
    el('span', { className: 'plate' }, [el('span', { className: 'plate-card', text: label, title: label })]),
    el('span', { className: 'knob', text: String(count) }),
  ]);

  if (dropCategory !== null) {
    btn.addEventListener('dragover', (e) => {
      if (!state.draggingPath) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      btn.classList.add('drop');
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('drop'));
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      btn.classList.remove('drop');
      const dragged = state.draggingPath;
      state.draggingPath = null;
      if (dragged) {
        const display = dropCategory.length ? dropCategory.join(' / ') : '未分类';
        assignProjectToCategory(dragged, dropCategory, display);
      }
    });
  }
  return btn;
}

function setView(view) {
  state.view = view;
  render({ deal: true });
}

function renderDrawers() {
  const { categories, unsortedCount, discoveredCount } = buildCategoryTree(state.projects, state.customDrawers);
  const pinnedCount = state.projects.filter((p) => p.pinned).length;
  const v = state.view;

  const nodes = [
    drawerButton({
      label: '全部卡片',
      count: state.projects.length,
      active: v.kind === 'all',
      onSelect: () => setView({ kind: 'all', path: [] }),
    }),
  ];

  if (pinnedCount > 0 || v.kind === 'pinned') {
    nodes.push(drawerButton({
      label: '已置顶 ★',
      count: pinnedCount,
      active: v.kind === 'pinned',
      onSelect: () => setView({ kind: 'pinned', path: [] }),
    }));
  }

  nodes.push(
    drawerButton({
      label: 'Agent 项目树',
      count: state.projects.length,
      active: v.kind === 'tree',
      onSelect: () => setView({ kind: 'tree', path: [] }),
    }),
  );

  if (discoveredCount > 0 || v.kind === 'discovered') {
    nodes.push(drawerButton({
      label: 'Agent 新发现',
      count: discoveredCount,
      active: v.kind === 'discovered',
      onSelect: () => setView({ kind: 'discovered', path: [] }),
    }));
  }

  nodes.push(
    drawerButton({
      label: '未分类',
      count: unsortedCount,
      active: v.kind === 'unsorted',
      dropCategory: [],
      onSelect: () => setView({ kind: 'unsorted', path: [] }),
    }),
  );

  if (categories.length > 0) {
    nodes.push(el('div', { className: 'drawer-group-label', text: '抽 屉' }));
    for (const c1 of categories) {
      nodes.push(drawerButton({
        label: c1.name,
        count: c1.total,
        active: v.kind === 'category' && samePath(v.path, c1.path),
        dropCategory: c1.path,
        onSelect: () => setView({ kind: 'category', path: c1.path }),
      }));
      for (const c2 of c1.subCategories) {
        nodes.push(drawerButton({
          label: c2.name,
          count: c2.items.length,
          sub: true,
          active: v.kind === 'category' && samePath(v.path, c2.path),
          dropCategory: c2.path,
          onSelect: () => setView({ kind: 'category', path: c2.path }),
        }));
      }
    }
  }

  drawersEl.replaceChildren(...nodes);
}

// ---------- 卡片视图 Agent 彩点筛选条 ----------

function renderAgentBar() {
  if (state.view.kind === 'tree' || state.projects.length === 0) {
    agentBarEl.hidden = true;
    return;
  }
  const counts = new Map();
  for (const p of state.projects) {
    for (const a of p.agents ?? []) counts.set(a, (counts.get(a) || 0) + 1);
  }
  if (counts.size === 0) {
    agentBarEl.hidden = true;
    return;
  }
  const sortedAgents = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const chips = sortedAgents.map(([name, count]) => el('button', {
    type: 'button',
    className: `chip${state.agentFilter === name ? ' active' : ''}${state.agentFilter && state.agentFilter !== name ? ' off' : ''}`,
    style: `--c:${agentColor(name)}`,
    title: state.agentFilter === name ? '再点一次显示全部' : `只看 ${name} 用过的项目`,
    onClick: () => {
      state.agentFilter = state.agentFilter === name ? null : name;
      render();
    },
  }, [
    el('span', { className: 'dot' }),
    el('span', { text: name }),
    el('span', { className: 'chip-count', text: String(count) }),
  ]));

  if (state.agentFilter) {
    chips.push(el('button', {
      type: 'button',
      className: 'chip plain',
      text: '清除筛选',
      onClick: () => {
        state.agentFilter = null;
        render();
      },
    }));
  }

  agentBarEl.replaceChildren(...chips);
  agentBarEl.hidden = false;
}

// ---------- 复古目录卡渲染 ----------

/** 卡片上的 Agent 一行放不下时，从末尾往前收起，收起的个数显示成 +N。 */
function fitAgentRows() {
  for (const row of contentEl.querySelectorAll('.card-agents')) {
    const items = [...row.querySelectorAll('.card-agent:not(.more):not(.none)')];
    const more = row.querySelector('.card-agent.more');
    if (!more) continue;
    for (const item of items) item.hidden = false;
    more.hidden = true;
    let hiddenCount = 0;
    while (row.scrollWidth > row.clientWidth && hiddenCount < items.length - 1) {
      hiddenCount += 1;
      items[items.length - hiddenCount].hidden = true;
      more.textContent = `+${hiddenCount}`;
      more.hidden = false;
    }
  }
}

let fitScheduled = false;
function scheduleFitAgentRows() {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    fitAgentRows();
  });
}

async function togglePin(project) {
  if (!connected || mutating) return;
  mutating = true;
  try {
    const result = await ask({ action: 'pin', path: project.path, pinned: !project.pinned });
    const key = pathKey(result.path);
    for (const item of state.projects) {
      if (pathKey(item.path) === key) item.pinned = result.pinned;
    }
    toast(result.pinned ? `已置顶「${project.name}」` : `已取消置顶「${project.name}」`);
    render();
  } catch (error) {
    toast(error.message, true);
  } finally {
    mutating = false;
  }
}

function projectCard(project, number, showLocation = false) {
  const art = el('article', { className: `card${project.pinned ? ' pinned' : ''}`, draggable: true });
  art.style.setProperty('--i', String(Math.min(cardIndex, 28)));
  cardIndex += 1;

  art.addEventListener('dragstart', (e) => {
    state.draggingPath = project.path;
    art.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', project.path);
  });
  art.addEventListener('dragend', () => {
    state.draggingPath = null;
    art.classList.remove('dragging');
    for (const d of drawersEl.querySelectorAll('.drawer.drop')) d.classList.remove('drop');
  });

  // 第一行：用过它的 Agent（彩色圆点 + 名字），放不下的由 fitAgentRows 收进末尾的 +N；第二行：抽屉标签、会话数、最近活跃。
  const agents = project.agents ?? [];
  const agentLine = el('span', {
    className: 'card-agents',
    title: agents.length ? `用过它的 Agent：${agents.join('、')}` : '',
  });
  for (const name of agents) {
    agentLine.append(el('span', { className: 'card-agent', style: `--c:${agentColor(name)}` }, [
      el('span', { className: 'dot' }),
      el('span', { text: name }),
    ]));
  }
  if (agents.length) agentLine.append(el('span', { className: 'card-agent more', hidden: true }));
  else agentLine.append(el('span', { className: 'card-agent none', text: '没有 Agent 记录' }));

  const statLine = el('span', { className: 'card-meta' });
  if (project.indexed === false) {
    statLine.append(el('span', { className: 'card-loc discovered', text: 'Agent 发现' }));
  } else if (showLocation) {
    statLine.append(el('span', { className: 'card-loc', text: project.category.join(' / ') || '未分类' }));
  }
  const stats = [];
  if (project.sessions) stats.push(`${project.sessions} 次会话`);
  if (project.lastActive) stats.push(formatAgo(project.lastActive));
  statLine.append(el('span', { className: 'card-stats', text: stats.join(' · ') || '点击复制路径' }));

  const openBtn = el('button', {
    type: 'button',
    className: 'card-open',
    title: `点击复制路径：${project.path}`,
    onClick: () => copyPath(project.path, project.name),
  }, [
    el('span', { className: 'card-head' }, [
      el('span', { className: 'card-no', text: `No.${String(number).padStart(2, '0')}` }),
      el('span', { className: 'card-name', text: project.name }),
    ]),
    el('span', { className: 'card-path', text: project.path }),
    agentLine,
    statLine,
  ]);

  const moveBtn = el('button', {
    type: 'button',
    className: 'card-act',
    text: '▤',
    title: '归类到抽屉',
    ariaLabel: `归类「${project.name}」到抽屉`,
    onClick: (e) => {
      e.stopPropagation();
      openAssignDialog(project);
    },
  });

  const pinBtn = el('button', {
    type: 'button',
    className: 'card-act card-pin',
    text: project.pinned ? '★' : '☆',
    title: project.pinned ? '取消置顶' : '置顶此项目',
    ariaLabel: `置顶「${project.name}」`,
    ariaPressed: String(Boolean(project.pinned)),
    onClick: (e) => {
      e.stopPropagation();
      togglePin(project);
    },
  });

  art.append(openBtn, el('div', { className: 'card-actions' }, [moveBtn, pinBtn]));
  return art;
}

function renderGroup(title, items, { sub = false, showLocation = false } = {}) {
  const ordered = sortItems(items);
  const grid = el('div', { className: 'cards' });
  ordered.forEach((p, idx) => grid.append(projectCard(p, idx + 1, showLocation)));
  return el('section', { className: sub ? 'group sub' : 'group' }, [
    el('div', { className: 'group-head' }, [
      el('h2', { text: title }),
      el('span', { className: 'count', text: `${ordered.length} 项` }),
    ]),
    grid,
  ]);
}

function renderEmptyCard(title, body, showImportBtn = false) {
  return el('div', { className: 'empty' }, [
    el('h2', { text: title }),
    el('p', { text: body }),
    showImportBtn
      ? el('div', { className: 'row' }, [
          el('button', { type: 'button', className: 'btn primary', text: '导入索引', onClick: openImportDialog }),
        ])
      : null,
  ]);
}

function renderContent({ deal = false } = {}) {
  const v = state.view;

  if (state.projects.length === 0) {
    contentEl.classList.remove('graph-mode', 'dealing');
    $('crumb').textContent = '文 件 夹 索 引';
    $('view-title').textContent = '等待导入索引';
    contentEl.replaceChildren(renderEmptyCard(
      '目录柜还是空的',
      '在天枢聊天框说「帮我扫描本机全部 Agent 项目」（确认授权后自动同步），或点下方手动导入 Folder Index 快照。',
      true,
    ));
    return;
  }

  if (v.kind === 'tree') {
    contentEl.classList.add('graph-mode');
    contentEl.classList.remove('dealing');
    $('crumb').textContent = state.query ? `AGENT 项 目 树 · 搜索“${state.query}”` : 'A G E N T 项 目 树';
    $('view-title').textContent = 'Agent 项目树';
    const visible = state.query ? searchProjects(state.projects, state.query) : state.projects;
    const wrap = el('div', { className: 'graph-wrap' });
    contentEl.replaceChildren(wrap);
    renderGraph(wrap, visible, {
      onCopyPath: (path, name) => copyPath(path, name),
      onTogglePin: (project) => togglePin(project),
    });
    return;
  }

  contentEl.classList.remove('graph-mode');
  contentEl.classList.toggle('dealing', deal);
  cardIndex = 0;

  if (state.query || state.agentFilter) {
    const category = v.kind === 'unsorted' ? [] : v.kind === 'category' ? v.path : null;
    let pool = state.projects;
    if (v.kind === 'pinned') pool = state.projects.filter((p) => p.pinned);
    else if (v.kind === 'discovered') pool = state.projects.filter((p) => p.indexed === false);
    else if (v.kind === 'unsorted') pool = state.projects.filter((p) => p.indexed !== false);
    const byAgent = filterByAgent(pool);
    const matched = state.query ? searchProjects(byAgent, state.query, category) : (
      category === null ? byAgent : searchProjects(byAgent, '', category)
    );
    const filterLabel = [state.agentFilter ? `Agent: ${state.agentFilter}` : '', state.query ? `“${state.query}”` : ''].filter(Boolean).join(' · ');
    $('crumb').textContent = `检 索 结 果 · ${matched.length} / ${pool.length}`;
    $('view-title').textContent = filterLabel || '筛选结果';
    if (matched.length === 0) {
      contentEl.replaceChildren(renderEmptyCard('没有找到匹配的卡片', '换个关键词或点「清除筛选」查看全部项目。'));
      return;
    }
    contentEl.replaceChildren(renderGroup('匹配项目', matched, { showLocation: true }));
    return;
  }

  if (v.kind === 'pinned') {
    const pinned = state.projects.filter((p) => p.pinned);
    $('crumb').textContent = '置 顶 收 藏';
    $('view-title').textContent = '已置顶 ★';
    if (pinned.length === 0) {
      contentEl.replaceChildren(renderEmptyCard('还没有置顶卡片', '点击任意卡片右上角的 ☆，它就会固定在这里并在搜索结果里优先展示。'));
      return;
    }
    contentEl.replaceChildren(renderGroup('已置顶项目', pinned, { showLocation: true }));
    return;
  }

  if (v.kind === 'discovered') {
    const discovered = state.projects.filter((p) => p.indexed === false);
    $('crumb').textContent = '自 动 扫 描 · 可 拖 入 抽 屉 归 类';
    $('view-title').textContent = 'Agent 新发现';
    if (discovered.length === 0) {
      contentEl.replaceChildren(renderEmptyCard('没有未归类的新发现', '全部扫描到的本机 Agent 项目都已归类在抽屉里。'));
      return;
    }
    contentEl.replaceChildren(renderGroup('Agent 新发现', discovered));
    return;
  }

  if (v.kind === 'unsorted') {
    const unsorted = state.projects.filter((p) => p.indexed !== false && p.category.length === 0);
    $('crumb').textContent = '抽 屉 · 根 目 录';
    $('view-title').textContent = '未分类';
    if (unsorted.length === 0) {
      contentEl.replaceChildren(renderEmptyCard('这里空空的', '所有已归类项目都已放进抽屉里啦。'));
      return;
    }
    contentEl.replaceChildren(renderGroup('未分类', unsorted));
    return;
  }

  if (v.kind === 'category') {
    $('crumb').textContent = v.path.length === 2 ? `抽 屉 · ${v.path[0]}` : '抽 屉';
    $('view-title').textContent = v.path[v.path.length - 1];
    if (v.path.length === 1) {
      const { categories } = buildCategoryTree(state.projects, state.customDrawers);
      const c1 = categories.find((c) => c.name === v.path[0]);
      const sections = [];
      if (c1?.direct?.length) sections.push(renderGroup(c1.name, c1.direct));
      for (const c2 of c1?.subCategories ?? []) {
        if (c2.items.length) sections.push(renderGroup(c2.name, c2.items, { sub: true }));
      }
      contentEl.replaceChildren(...(sections.length ? sections : [renderEmptyCard('这个抽屉还是空的', '可以把任意卡片拖进左侧这个抽屉，或点卡片右上角 ▤ 放进来。')]));
      return;
    }
    const items = state.projects.filter((p) => p.indexed !== false && samePath(p.category, v.path));
    contentEl.replaceChildren(items.length
      ? renderGroup(v.path.join(' / '), items)
      : renderEmptyCard('这个隔板还是空的', '可以把任意卡片拖进这个子抽屉，或点卡片右上角 ▤ 放进来。'));
    return;
  }

  // 全部卡片
  $('crumb').textContent = `全 部 索 引 · ${state.projects.length} 个项目`;
  $('view-title').textContent = '全部卡片';
  const sections = [];
  const pinned = state.projects.filter((p) => p.pinned);
  if (pinned.length > 0) {
    sections.push(renderGroup('已置顶 ★', pinned, { showLocation: true }));
  }
  const { categories } = buildCategoryTree(state.projects, state.customDrawers);
  for (const c1 of categories) {
    if (c1.direct.length > 0) sections.push(renderGroup(c1.name, c1.direct));
    for (const c2 of c1.subCategories) {
      if (c2.items.length > 0) sections.push(renderGroup(c2.name, c2.items, { sub: true }));
    }
  }
  const unsorted = state.projects.filter((p) => p.indexed !== false && p.category.length === 0);
  if (unsorted.length > 0) {
    sections.push(renderGroup('未分类', unsorted));
  }
  const discovered = state.projects.filter((p) => p.indexed === false);
  if (discovered.length > 0) {
    sections.push(renderGroup('Agent 新发现', discovered));
  }
  contentEl.replaceChildren(...sections);
}

function render(opts = {}) {
  const pinnedCount = state.projects.filter((p) => p.pinned).length;
  if (connected) {
    setStatus(pinnedCount > 0 ? `${state.projects.length} 项 · ★ ${pinnedCount}` : `${state.projects.length} 个项目`);
  }
  renderDrawers();
  renderAgentBar();
  renderContent(opts);
  scheduleFitAgentRows();
}

// ---------- 弹窗：导入、新建抽屉、快捷归类 ----------

function openImportDialog() {
  dialogErrorEl.hidden = true;
  snapshotEl.value = '';
  importDialogEl.showModal();
  snapshotEl.focus();
}

async function submitImport() {
  if (!connected || mutating) return;
  dialogErrorEl.hidden = true;
  const text = snapshotEl.value;
  try {
    parseSnapshot(text);
  } catch (error) {
    dialogErrorEl.textContent = error.message;
    dialogErrorEl.hidden = false;
    return;
  }
  mutating = true;
  importSubmitBtn.disabled = true;
  try {
    const result = await ask({ action: 'import', text });
    state.projects = result.projects;
    state.query = '';
    state.agentFilter = null;
    queryEl.value = '';
    state.view = { kind: 'all', path: [] };
    importDialogEl.close();
    render({ deal: true });
    toast(`已导入 ${result.projects.length} 个项目`);
  } catch (error) {
    dialogErrorEl.textContent = error.message;
    dialogErrorEl.hidden = false;
  } finally {
    mutating = false;
    importSubmitBtn.disabled = !connected;
  }
}

function openDrawerDialog() {
  const { categories } = buildCategoryTree(state.projects, state.customDrawers);
  drawerParentEl.replaceChildren(new Option('新建一级抽屉（顶层）', '[]'));
  for (const c1 of categories) {
    drawerParentEl.append(new Option(`放在「${c1.name}」下作为二级隔板`, JSON.stringify(c1.path)));
  }
  drawerNameEl.value = '';
  drawerErrorEl.hidden = true;
  drawerDialogEl.showModal();
  drawerNameEl.focus();
}

async function submitCreateDrawer() {
  if (!connected || mutating) return;
  drawerErrorEl.hidden = true;
  const parent = JSON.parse(drawerParentEl.value || '[]');
  const name = drawerNameEl.value.trim();
  if (!name) {
    drawerErrorEl.textContent = '请输入抽屉名称';
    drawerErrorEl.hidden = false;
    return;
  }
  mutating = true;
  try {
    const res = await ask({ action: 'createDrawer', parent, name });
    state.customDrawers = res.drawers;
    drawerDialogEl.close();
    state.view = { kind: 'category', path: res.category };
    render({ deal: true });
    toast(`已新建抽屉「${res.category.join(' / ')}」`);
  } catch (error) {
    drawerErrorEl.textContent = error.message;
    drawerErrorEl.hidden = false;
  } finally {
    mutating = false;
  }
}

function openAssignDialog(project) {
  assignTargetProject = project;
  $('assign-title').textContent = `归类「${project.name}」`;
  $('assign-path').textContent = project.path;
  const { categories } = buildCategoryTree(state.projects, state.customDrawers);
  assignSelectEl.replaceChildren(new Option('未分类（根目录）', '[]'));
  for (const c1 of categories) {
    assignSelectEl.append(new Option(c1.name, JSON.stringify(c1.path)));
    for (const c2 of c1.subCategories) {
      assignSelectEl.append(new Option(`${c1.name} / ${c2.name}`, JSON.stringify(c2.path)));
    }
  }
  const currentVal = JSON.stringify(project.indexed === false ? [] : project.category);
  if ([...assignSelectEl.options].some((o) => o.value === currentVal)) {
    assignSelectEl.value = currentVal;
  }
  assignNewEl.value = '';
  assignErrorEl.hidden = true;
  assignDialogEl.showModal();
}

async function submitAssign() {
  if (!connected || mutating || !assignTargetProject) return;
  assignErrorEl.hidden = true;
  const newName = assignNewEl.value.trim();
  const category = newName ? [newName] : JSON.parse(assignSelectEl.value || '[]');
  const label = category.length ? category.join(' / ') : '未分类';
  assignDialogEl.close();
  await assignProjectToCategory(assignTargetProject.path, category, label);
  assignTargetProject = null;
}

// ---------- 主题与排序持久化 ----------

async function savePrefs(patch) {
  applyPrefs({ ...state.prefs, ...patch });
  if (!connected) return;
  try {
    const res = await ask({ action: 'setPrefs', ...patch });
    if (res?.prefs) applyPrefs(res.prefs);
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------- 事件绑定 ----------

$('import-btn').addEventListener('click', openImportDialog);
$('import-cancel').addEventListener('click', () => importDialogEl.close());
importSubmitBtn.addEventListener('click', submitImport);

$('add-drawer-open').addEventListener('click', openDrawerDialog);
$('drawer-cancel').addEventListener('click', () => drawerDialogEl.close());
$('drawer-submit').addEventListener('click', submitCreateDrawer);
drawerNameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCreateDrawer(); });

$('assign-cancel').addEventListener('click', () => assignDialogEl.close());
$('assign-submit').addEventListener('click', submitAssign);
assignNewEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAssign(); });

themeToggleBtn.addEventListener('click', () => {
  const idx = THEME_CYCLE.indexOf(state.prefs.theme);
  const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
  savePrefs({ theme: next });
});

sortSelectEl.addEventListener('change', () => {
  savePrefs({ sort: sortSelectEl.value }).then(() => render());
});

queryEl.addEventListener('input', () => {
  state.query = queryEl.value.trim();
  if (connected) render();
});

document.addEventListener('keydown', (e) => {
  const anyDialogOpen = importDialogEl.open || drawerDialogEl.open || assignDialogEl.open;
  const typing = e.target.closest('input, textarea, select') || anyDialogOpen;
  if (e.key === 'Escape' && document.activeElement === queryEl && queryEl.value) {
    queryEl.value = '';
    state.query = '';
    render();
    return;
  }
  if (typing) return;
  if (e.key === '/' || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    queryEl.focus();
    queryEl.select();
  }
});

// ---------- TPI 2.0 宿主消息 ----------

window.addEventListener('message', (event) => {
  if (event.source !== parent || event.data?.tpi !== 'host') return;
  const data = event.data;
  if (data.type === 'hello' && !connected) {
    connected = true;
    importSubmitBtn.disabled = false;
    ask({ action: 'state' })
      .then((result) => {
        state.projects = result.projects ?? [];
        state.customDrawers = result.drawers ?? [];
        if (result.prefs) applyPrefs(result.prefs);
        render({ deal: true });
      })
      .catch((error) => {
        setStatus(error.message, true);
        contentEl.replaceChildren(renderEmptyCard('暂时无法加载索引', error.message));
      });
    return;
  }
  if (data.type === 'push') {
    if (data.message?.action === 'updated' && Array.isArray(data.message.projects)) {
      state.projects = data.message.projects;
      if (Array.isArray(data.message.drawers)) state.customDrawers = data.message.drawers;
      render({ deal: true });
      toast(`已自动扫描并同步 ${state.projects.length} 个项目`);
    }
    return;
  }
  if (data.type !== 'reply') return;
  const request = requests.get(data.id);
  if (!request) return;
  requests.delete(data.id);
  clearTimeout(request.timer);
  if (data.ok) request.resolve(data.value);
  else request.reject(new Error(data.error || '文件夹索引操作失败'));
});

function reportHeight() {
  const isNarrow = window.innerWidth <= 720;
  const height = isNarrow
    ? Math.min(4000, Math.max(460, Math.ceil($('panel').getBoundingClientRect().height)))
    : Math.min(4000, Math.max(640, Math.ceil($('panel').getBoundingClientRect().height)));
  parent.postMessage({ tpi: 'view', type: 'resize', height }, '*');
}

new ResizeObserver(reportHeight).observe($('panel'));
new ResizeObserver(scheduleFitAgentRows).observe(contentEl);
parent.postMessage({ tpi: 'view', type: 'ready' }, '*');
