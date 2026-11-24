// 天枢 TPI 2.0 沙箱版 Agent 项目树：纯 SVG，零外部依赖，不使用 localStorage。
// 此电脑 → 盘符 → 目录 → 项目；同一目录下的项目互为兄弟。

const SVG_NS = 'http://www.w3.org/2000/svg';

export const AGENT_COLORS = {
  Claude: '#d97757',
  Codex: '#10a37f',
  Cursor: '#8b5cf6',
  'VS Code': '#2f7de1',
  Qoder: '#f2a516',
  Antigravity: '#e8457a',
  'Antigravity CLI': '#f07aa3',
  opencode: '#7b8794',
  Orca: '#14b8c8',
  WorkBuddy: '#8cc63f',
  Trae: '#ef4444',
  Windsurf: '#0d9488',
  Kiro: '#a855f7',
};

export const agentColor = (name) => AGENT_COLORS[name] || '#c99953';

const BRANCH_COLORS = [
  '#e4572e', '#f3a712', '#3bb273', '#2e86ab', '#a23b72', '#6a4c93',
  '#ff8c42', '#1b998b', '#d1495b', '#5d76cb', '#c08b2c', '#4f9d69',
];

const ROW = 30;
const LEVEL = 100;
const LEAF_GAP = 30;
const FONT_PROJECT = '15px "LXGW WenKai", "霞鹜文楷", KaiTi, serif';
const FONT_DIR = '12px "Cascadia Mono", Consolas, monospace';
const FONT_ROOT = '600 15px "Noto Serif SC", "SimSun", serif';

// 仅存内存（TPI 2.0 沙箱禁用 localStorage）
const memory = {
  k: 1,
  x: 0,
  y: 0,
  key: null,
  collapsed: new Set(),
  agent: null,
  onlyPinned: false,
  onlyIndexed: false,
  orient: 'h',
};

function setOrient(orient) {
  memory.orient = orient;
  memory.key = null;
}

function s(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'onClick') node.addEventListener('click', v);
    else node[k] = v;
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

let measureCtx = null;
function textWidth(text, font) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

export function formatAgo(ms) {
  if (!ms) return '';
  const sec = (Date.now() - ms) / 1000;
  if (sec < 3600) return '刚刚用过';
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildHierarchy(projects) {
  const root = { id: 'root', name: '此电脑', path: '', kind: 'root', project: null, map: new Map() };
  for (const p of projects) {
    const parts = p.path.split(/[\\/]+/).filter(Boolean);
    if (!parts.length) continue;
    parts[0] = parts[0].toUpperCase();
    let node = root;
    let full = '';
    parts.forEach((seg, i) => {
      full = i === 0 ? `${seg}\\` : i === 1 ? `${full}${seg}` : `${full}\\${seg}`;
      const key = seg.toLowerCase();
      if (!node.map.has(key)) {
        node.map.set(key, {
          id: full.toLowerCase(),
          name: seg,
          path: full,
          kind: i === 0 ? 'drive' : 'dir',
          project: null,
          map: new Map(),
        });
      }
      node = node.map.get(key);
    });
    node.project = p;
    if (node.kind === 'dir') node.kind = 'project';
  }
  return finalize(root);
}

function finalize(node) {
  let cur = node;
  let label = node.name;
  if (node.kind === 'dir') {
    while (!cur.project && cur.map.size === 1) {
      const only = [...cur.map.values()][0];
      if (only.kind !== 'dir') break;
      cur = only;
      label += `\\${only.name}`;
    }
  }
  const children = [...cur.map.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    .map(finalize);
  const displayLabel = cur.project?.name || label;
  return { id: cur.id, label: displayLabel, path: cur.path, kind: cur.kind, project: cur.project, children };
}

function paintBranches(root) {
  let i = 0;
  for (const drive of root.children) {
    drive.color = null;
    for (const child of drive.children) {
      const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
      i += 1;
      (function paint(n) {
        n.color = color;
        n.children.forEach(paint);
      })(child);
    }
  }
}

function countProjects(n) {
  return (n.project ? 1 : 0) + n.children.reduce((sum, c) => sum + countProjects(c), 0);
}

function radius(n) {
  if (n.kind === 'root') return 13;
  if (n.kind === 'drive') return 17;
  if (n.kind === 'dir') return 5;
  const sessions = n.project?.sessions ?? 0;
  return 7 + Math.min(7, Math.log2(1 + sessions) * 1.6);
}

function labelOf(n) {
  if (n.kind === 'drive') return '';
  if (n.collapsed) return `${n.label}  +${countProjects(n) - (n.project ? 1 : 0)}`;
  return n.project?.pinned ? `★ ${n.label}` : n.label;
}

function fontOf(n) {
  if (n.kind === 'project') return FONT_PROJECT;
  if (n.kind === 'root') return FONT_ROOT;
  return FONT_DIR;
}

function prepare(root) {
  const nodes = [];
  const edges = [];
  (function visit(n, depth, parent) {
    n.depth = depth;
    n.parent = parent;
    n.collapsed = memory.collapsed.has(n.id) && n.children.length > 0;
    n.kids = n.collapsed ? [] : n.children;
    n.leaf = n.kids.length === 0;
    n.r = radius(n);
    n.kids.forEach((c) => visit(c, depth + 1, n));
    n.text = labelOf(n);
    n.labelW = n.text ? textWidth(n.text, fontOf(n)) : 0;
    nodes.push(n);
    if (parent) edges.push([parent, n]);
  })(root, 0, null);
  return { nodes, edges };
}

function layout(root) {
  return memory.orient === 'v' ? layoutV(root) : layoutH(root);
}

function layoutH(root) {
  const { nodes, edges } = prepare(root);
  let row = 0;
  (function place(n) {
    if (n.leaf) {
      n.y = row * ROW;
      row += 1;
    } else {
      n.kids.forEach(place);
      n.y = (n.kids[0].y + n.kids[n.kids.length - 1].y) / 2;
    }
  })(root);

  const maxDepth = Math.max(...nodes.map((n) => n.depth));
  const leftNeed = new Array(maxDepth + 1).fill(0);
  for (const n of nodes) if (!n.leaf && n.depth > 0) leftNeed[n.depth] = Math.max(leftNeed[n.depth], n.labelW + n.r + 14);
  const colX = [0];
  for (let d = 1; d <= maxDepth; d += 1) colX[d] = colX[d - 1] + Math.max(120, leftNeed[d] + 64);
  for (const n of nodes) n.x = colX[n.depth];

  let minX = Infinity;
  let maxX = -Infinity;
  for (const n of nodes) {
    const left = n.leaf || n.kind === 'drive' ? n.x - n.r : n.x - n.r - 10 - n.labelW;
    const right = n.leaf && n.kind !== 'drive' ? n.x + n.r + 10 + n.labelW : n.x + n.r;
    minX = Math.min(minX, left);
    maxX = Math.max(maxX, right);
  }
  return { nodes, edges, bbox: { minX, maxX, minY: -ROW / 2 - 6, maxY: (row - 1) * ROW + ROW / 2 + 6 } };
}

function layoutV(root) {
  const { nodes, edges } = prepare(root);
  (function measure(n) {
    if (n.leaf) {
      n.w = LEAF_GAP;
      return;
    }
    n.kids.forEach(measure);
    const sum = n.kids.reduce((acc, c) => acc + c.w, 0);
    const labelNeed = n.kind === 'drive' ? 0 : sum / 2 + n.r + 12 + n.labelW + 10;
    n.w = Math.max(sum, labelNeed);
  })(root);
  (function place(n, left) {
    n.y = n.depth * LEVEL;
    if (n.leaf) {
      n.x = left + LEAF_GAP / 2;
      return;
    }
    let cur = left;
    for (const c of n.kids) {
      place(c, cur);
      cur += c.w;
    }
    n.x = (n.kids[0].x + n.kids[n.kids.length - 1].x) / 2;
  })(root, 0);

  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r - 4);
    const rightLabel = !n.leaf && n.text && n.kind !== 'drive' ? n.r + 12 + n.labelW : n.r;
    maxX = Math.max(maxX, n.x + rightLabel + 4);
    const below = n.leaf && n.text && n.kind !== 'drive' ? n.r + 10 + n.labelW : n.r;
    maxY = Math.max(maxY, n.y + below + 6);
  }
  return { nodes, edges, bbox: { minX, maxX, minY: -root.r - 12, maxY } };
}

function arc(cx, cy, r, a0, a1) {
  const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
  const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p0[0].toFixed(2)},${p0[1].toFixed(2)} A${r},${r} 0 ${large} 1 ${p1[0].toFixed(2)},${p1[1].toFixed(2)}`;
}

function drawNode(n) {
  const g = s('g', {
    class: `n n-${n.kind}${n.project?.pinned ? ' pinned-node' : ''}${n.project?.indexed === false ? ' unindexed' : ''}`,
    transform: `translate(${n.x},${n.y})`,
  });
  g._node = n;
  if (n.kind === 'root') {
    g.append(
      s('circle', { r: n.r + 4, class: 'root-halo' }),
      s('circle', { r: n.r, class: 'root-dot' }),
      s('circle', { r: 4, class: 'root-core' }),
    );
  } else if (n.kind === 'drive') {
    g.append(
      s('circle', { r: n.r + 3, class: 'drive-ring' }),
      s('circle', { r: n.r, class: 'drive-face' }),
      s('text', { class: 't-drive', 'text-anchor': 'middle', dy: '0.35em' }, [document.createTextNode(n.label.replace(/\\$/, ''))]),
    );
  } else if (n.kind === 'dir') {
    g.append(s('circle', { r: n.r, class: `dir-dot${n.collapsed ? ' closed' : ''}`, style: `--c:${n.color}` }));
  } else {
    const agents = n.project.agents?.length ? n.project.agents : [];
    const ringR = n.r;
    if (agents.length === 0) {
      g.append(s('circle', { r: ringR, class: 'ring', style: `stroke:${n.color || '#c99953'}` }));
    } else if (agents.length === 1) {
      g.append(s('circle', { r: ringR, class: 'ring', style: `stroke:${agentColor(agents[0])}` }));
    } else {
      const gap = 0.18;
      const step = (Math.PI * 2) / agents.length;
      agents.forEach((a, i) => {
        const a0 = -Math.PI / 2 + i * step + gap / 2;
        const a1 = a0 + step - gap;
        g.append(s('path', { d: arc(0, 0, ringR, a0, a1), class: 'ring', style: `stroke:${agentColor(a)}` }));
      });
    }
    g.append(s('circle', { r: Math.max(2.5, ringR - 3.2), class: 'core' }));
    if (n.collapsed) g.append(s('circle', { r: ringR + 5, class: 'closed-halo', style: `--c:${n.color}` }));
  }
  if (n.text && n.kind !== 'drive') {
    if (memory.orient === 'v') {
      g.append(n.leaf
        ? s('text', { class: `t-${n.kind} vertical`, x: 0, y: n.r + 10 }, [document.createTextNode(n.text)])
        : s('text', { class: `t-${n.kind}`, x: n.r + 12, dy: '0.35em', 'text-anchor': 'start' }, [document.createTextNode(n.text)]));
    } else {
      const leftSide = !n.leaf;
      g.append(s('text', {
        class: `t-${n.kind}`,
        x: leftSide ? -(n.r + 10) : n.r + 10,
        dy: '0.35em',
        'text-anchor': leftSide ? 'end' : 'start',
      }, [document.createTextNode(n.text)]));
    }
  }
  return g;
}

function edgePath(a, b) {
  if (memory.orient === 'v') {
    const sy = a.y + a.r;
    const ty = b.y - b.r;
    const my = sy + (ty - sy) * 0.55;
    return `M${a.x},${sy} C${a.x},${my} ${b.x},${my} ${b.x},${ty}`;
  }
  const sx = a.x + a.r;
  const tx = b.x - b.r;
  const mx = sx + (tx - sx) * 0.55;
  return `M${sx},${a.y} C${mx},${a.y} ${mx},${b.y} ${tx},${b.y}`;
}

export function renderGraph(container, allProjects, opts = {}) {
  const projects = allProjects.filter((p) => (
    (!memory.agent || (p.agents ?? []).includes(memory.agent))
    && (!memory.onlyPinned || Boolean(p.pinned))
    && (!memory.onlyIndexed || p.indexed !== false)
  ));
  container.replaceChildren();
  container.classList.add('graph-wrap');

  const bar = buildBar(container, allProjects, opts);
  if (!projects.length) {
    container.append(bar, h('p', { className: 'graph-empty', text: '没有符合条件的项目。' }));
    return;
  }

  const root = buildHierarchy(projects);
  paintBranches(root);
  const { nodes, edges, bbox } = layout(root);

  const svg = s('svg', { class: 'graph', role: 'img', 'aria-label': `Agent 项目树，共 ${projects.length} 个项目` });
  const vp = s('g', { class: 'viewport' });
  const gEdges = s('g', { class: 'edges' });
  const gNodes = s('g', { class: 'nodes' });

  const edgeEls = [];
  for (const [a, b] of edges) {
    const width = Math.max(1.6, 5 - b.depth * 0.7);
    const path = s('path', {
      d: edgePath(a, b),
      class: `e${a.kind === 'root' ? ' e-root' : ''}`,
      style: b.color ? `stroke:${b.color};stroke-width:${width}` : `stroke-width:${width}`,
    });
    path._target = b;
    edgeEls.push(path);
    gEdges.append(path);
  }
  const nodeEls = nodes.map(drawNode);
  gNodes.append(...nodeEls);
  vp.append(gEdges, gNodes);
  svg.append(vp);

  const tip = h('div', { className: 'graph-tip', hidden: true });
  const zoomBar = buildZoom(svg, vp, container, bbox, () => renderGraph(container, allProjects, opts), root);
  container.append(svg, bar, zoomBar, tip);

  const dataKey = projects.map((p) => p.path).join('|');
  if (memory.key !== dataKey) {
    fit(svg, vp, container, bbox);
    svg.classList.add('intro');
    for (const el of edgeEls) {
      const len = el.getTotalLength();
      el.style.setProperty('--len', String(Math.ceil(len)));
      el.style.setProperty('--d', String(el._target.depth));
    }
    for (const el of nodeEls) el.style.setProperty('--d', String(el._node.depth));
    setTimeout(() => svg.classList.remove('intro'), 1600);
  } else {
    apply(vp);
  }
  memory.key = dataKey;

  const panState = { active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };

  function highlight(n) {
    const on = new Set();
    for (let p = n; p; p = p.parent) on.add(p);
    svg.classList.add('focus');
    for (const el of nodeEls) el.classList.toggle('on', on.has(el._node));
    for (const el of edgeEls) el.classList.toggle('on', on.has(el._target));
  }
  function clearHighlight() {
    svg.classList.remove('focus');
    tip.hidden = true;
  }

  function showTip(n, event) {
    tip.replaceChildren();
    if (n.kind === 'project') {
      const p = n.project;
      const agents = p.agents ?? [];
      tip.style.setProperty('--c', agents[0] ? agentColor(agents[0]) : (n.color || '#c99953'));
      tip.append(
        h('div', { className: 'tip-name', text: p.pinned ? `★ ${p.name}` : p.name }),
        h('div', { className: 'tip-path', text: p.path }),
        agents.length
          ? h('div', { className: 'tip-agents' }, agents.map((a) => h('span', { className: 'tip-agent', style: `--c:${agentColor(a)}`, text: a })))
          : null,
        (p.sessions || p.lastActive)
          ? h('div', {
              className: 'tip-meta',
              text: [p.sessions ? `${p.sessions} 个会话` : '', p.lastActive ? `最近 ${formatAgo(p.lastActive)}` : ''].filter(Boolean).join(' · '),
            })
          : null,
        h('div', {
          className: `tip-state${p.indexed === false ? ' off' : ''}`,
          text: p.indexed === false ? '来源：自动扫描本机 Agent（未收录进抽屉）' : `抽屉：${p.category.join(' / ') || '未分类'}`,
        }),
        h('div', { className: 'tip-hint', text: n.children.length ? '点击复制路径 · 右键置顶 · 双击折叠' : '点击复制路径 · 右键置顶 / 取消置顶' }),
      );
    } else {
      tip.style.setProperty('--c', n.color || 'var(--muted)');
      tip.append(
        h('div', { className: 'tip-name', text: n.kind === 'root' ? '此电脑' : n.kind === 'drive' ? `${n.label.replace(/\\$/, '')} 盘` : n.label }),
        n.path ? h('div', { className: 'tip-path', text: n.path }) : null,
        h('div', { className: 'tip-meta', text: `${countProjects(n)} 个项目` }),
        n.kind === 'root' ? null : h('div', { className: 'tip-hint', text: `${n.collapsed ? '点击展开' : '点击折叠'} · 右键复制目录路径` }),
      );
    }
    tip.hidden = false;
    moveTip(event);
  }

  function moveTip(event) {
    const rect = container.getBoundingClientRect();
    let x = event.clientX - rect.left + 16;
    let y = event.clientY - rect.top + 14;
    if (x + tip.offsetWidth > rect.width - 8) x = Math.max(8, event.clientX - rect.left - tip.offsetWidth - 16);
    if (y + tip.offsetHeight > rect.height - 8) y = Math.max(8, rect.height - tip.offsetHeight - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  for (const el of nodeEls) {
    const n = el._node;
    el.addEventListener('pointerenter', (e) => {
      if (panState.active) return;
      highlight(n);
      showTip(n, e);
    });
    el.addEventListener('pointermove', moveTip);
    el.addEventListener('pointerleave', clearHighlight);
    el.addEventListener('click', (e) => {
      if (panState.moved) return;
      e.stopPropagation();
      if (n.kind === 'project') opts.onCopyPath?.(n.project.path, n.project.name);
      else if (n.kind === 'dir' || n.kind === 'drive') toggle(n);
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (n.kind === 'project' && n.children.length) toggle(n);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearHighlight();
      if (n.kind === 'project') opts.onTogglePin?.(n.project);
      else if (n.path) opts.onCopyPath?.(n.path, n.label);
    });
  }

  function toggle(n) {
    if (memory.collapsed.has(n.id)) memory.collapsed.delete(n.id);
    else memory.collapsed.add(n.id);
    renderGraph(container, allProjects, opts);
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    panState.active = true;
    panState.moved = false;
    panState.sx = e.clientX;
    panState.sy = e.clientY;
    panState.ox = memory.x;
    panState.oy = memory.y;
  });
  svg.addEventListener('pointermove', (e) => {
    if (!panState.active) return;
    const dx = e.clientX - panState.sx;
    const dy = e.clientY - panState.sy;
    if (!panState.moved && Math.hypot(dx, dy) < 4) return;
    if (!panState.moved) {
      panState.moved = true;
      svg.setPointerCapture(e.pointerId);
      svg.classList.add('panning');
      clearHighlight();
    }
    memory.x = panState.ox + dx;
    memory.y = panState.oy + dy;
    apply(vp);
  });
  const endPan = () => {
    if (!panState.active) return;
    panState.active = false;
    svg.classList.remove('panning');
    setTimeout(() => { panState.moved = false; }, 0);
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    zoomAt(vp, e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
}

function apply(vp) {
  vp.setAttribute('transform', `translate(${memory.x.toFixed(1)},${memory.y.toFixed(1)}) scale(${memory.k.toFixed(4)})`);
}

function zoomAt(vp, px, py, factor) {
  const k = Math.min(2.5, Math.max(0.25, memory.k * factor));
  const real = k / memory.k;
  memory.x = px - (px - memory.x) * real;
  memory.y = py - (py - memory.y) * real;
  memory.k = k;
  apply(vp);
}

function fit(svg, vp, container, bbox) {
  const W = container.clientWidth || 860;
  const H = container.clientHeight || 540;
  const top = 74;
  const bw = Math.max(1, bbox.maxX - bbox.minX);
  const bh = Math.max(1, bbox.maxY - bbox.minY);
  let k = Math.min(1.1, (W - 72) / bw, (H - top - 36) / bh);
  k = Math.max(memory.orient === 'v' ? 0.6 : 0.7, k);
  memory.k = k;
  memory.x = bw * k <= W - 72 ? (W - bw * k) / 2 - bbox.minX * k : 36 - bbox.minX * k;
  memory.y = bh * k < H - top - 36 ? top + (H - top - 36 - bh * k) / 2 - bbox.minY * k : top - bbox.minY * k;
  apply(vp);
}

function buildBar(container, allProjects, opts) {
  const counts = new Map();
  for (const p of allProjects) {
    for (const a of p.agents ?? []) counts.set(a, (counts.get(a) || 0) + 1);
  }
  const agents = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const rerender = () => renderGraph(container, allProjects, opts);

  const chips = agents.map(([name, count]) => h('button', {
    type: 'button',
    className: `chip${memory.agent === name ? ' active' : ''}${memory.agent && memory.agent !== name ? ' off' : ''}`,
    style: `--c:${agentColor(name)}`,
    title: memory.agent === name ? '再点一次显示全部' : `只看 ${name} 用过的项目`,
    onClick: () => {
      memory.agent = memory.agent === name ? null : name;
      rerender();
    },
  }, [h('span', { className: 'dot' }), h('span', { text: name }), h('span', { className: 'chip-count', text: String(count) })]));

  const hasUnindexed = allProjects.some((p) => p.indexed === false);
  const indexedCount = allProjects.filter((p) => p.indexed !== false).length;
  const indexedChip = hasUnindexed && indexedCount > 0
    ? h('button', {
        type: 'button',
        className: `chip plain${memory.onlyIndexed ? ' active' : ''}`,
        title: '只看已收录进索引抽屉的项目',
        onClick: () => {
          memory.onlyIndexed = !memory.onlyIndexed;
          rerender();
        },
      }, [h('span', { text: memory.onlyIndexed ? '只看已收录 ✓' : '只看已收录' }), h('span', { className: 'chip-count', text: `${indexedCount}/${allProjects.length}` })])
    : null;

  const pinnedCount = allProjects.filter((p) => p.pinned).length;
  const pinnedChip = pinnedCount > 0 || memory.onlyPinned
    ? h('button', {
        type: 'button',
        className: `chip plain${memory.onlyPinned ? ' active' : ''}`,
        title: '只看已置顶的项目',
        onClick: () => {
          memory.onlyPinned = !memory.onlyPinned;
          rerender();
        },
      }, [h('span', { text: memory.onlyPinned ? '只看已置顶 ★' : '只看已置顶' }), h('span', { className: 'chip-count', text: `${pinnedCount}/${allProjects.length}` })])
    : null;

  const segBtn = (label, value, title) => h('button', {
    type: 'button',
    className: memory.orient === value ? 'on' : '',
    title,
    onClick: () => {
      if (memory.orient === value) return;
      setOrient(value);
      rerender();
    },
  }, [h('span', { text: label })]);

  const orient = h('div', { className: 'seg', role: 'group', ariaLabel: '树的方向' }, [
    segBtn('→ 横向', 'h', '从左往右长'),
    segBtn('↓ 竖向', 'v', '从上往下长，像二叉树那样'),
  ]);

  return h('div', { className: 'graph-bar' }, [...chips, indexedChip, pinnedChip, orient]);
}

function buildZoom(svg, vp, container, bbox, rerender, root) {
  const btn = (text, title, onClick) => h('button', { type: 'button', className: 'zoom-btn', text, title, onClick });
  const center = () => {
    const r = svg.getBoundingClientRect();
    return [r.width / 2, r.height / 2];
  };
  return h('div', { className: 'graph-zoom' }, [
    btn('＋', '放大', () => zoomAt(vp, ...center(), 1.25)),
    btn('－', '缩小', () => zoomAt(vp, ...center(), 0.8)),
    btn('⤢', '适应窗口', () => fit(svg, vp, container, bbox)),
    btn('⇲', '全部展开', () => {
      memory.collapsed.clear();
      rerender();
    }),
    btn('⇱', '收起到盘符下第一层', () => {
      memory.collapsed.clear();
      for (const drive of root.children) {
        for (const c of drive.children) if (c.children.length) memory.collapsed.add(c.id);
      }
      rerender();
    }),
  ]);
}
