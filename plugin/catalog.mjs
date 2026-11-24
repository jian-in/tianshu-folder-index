const SNAPSHOT_SCHEMA = 'folder-index.projects/1';
const MAX_PROJECTS = 500;
const MAX_AGENTS = 16;
const MAX_STACK = 8;
// 快照作为字符串传送，给 TPI 的 256 KiB 页面消息留出 JSON 转义空间。
const MAX_SNAPSHOT_BYTES = 96 * 1024;

function checkSize(text) {
  if (typeof text !== 'string' || text.length > MAX_SNAPSHOT_BYTES
    || new TextEncoder().encode(text).length > MAX_SNAPSHOT_BYTES) {
    throw new Error('索引需为 96 KiB 以内的 JSON 文本');
  }
}

function checkText(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`索引中的${label}格式错误`);
  }
  return value.trim();
}

function normalizeOptionalMeta(project) {
  const meta = {};
  if (Array.isArray(project.agents) && project.agents.length > 0) {
    const seen = new Set();
    const agents = [];
    for (const raw of project.agents) {
      if (agents.length >= MAX_AGENTS) break;
      const name = checkText(raw, 40, 'Agent 名称');
      if (!seen.has(name)) {
        seen.add(name);
        agents.push(name);
      }
    }
    if (agents.length > 0) meta.agents = agents;
  }
  if (project.sessions !== undefined) {
    if (!Number.isInteger(project.sessions) || project.sessions < 0 || project.sessions > 1_000_000) {
      throw new Error('索引中的会话数格式错误');
    }
    meta.sessions = project.sessions;
  }
  if (project.lastActive !== undefined && project.lastActive !== null && project.lastActive !== 0) {
    if (!Number.isInteger(project.lastActive) || project.lastActive < 0 || project.lastActive > 8_640_000_000_000_000) {
      throw new Error('索引中的活跃时间格式错误');
    }
    meta.lastActive = project.lastActive;
  }
  if (project.indexed === false) {
    meta.indexed = false;
  }
  if (Array.isArray(project.stack) && project.stack.length > 0) {
    const stack = [...new Set(project.stack.slice(0, MAX_STACK).map((raw) => checkText(raw, 24, '技术栈')))];
    if (stack.length > 0) meta.stack = stack;
  }
  if (project.branch !== undefined && project.branch !== null && project.branch !== '') {
    meta.branch = checkText(project.branch, 120, 'Git 分支');
  }
  return meta;
}

function normalizeSnapshot(snapshot) {
  if (snapshot?.schema !== SNAPSHOT_SCHEMA || !Array.isArray(snapshot.projects)
    || snapshot.projects.length === 0 || snapshot.projects.length > MAX_PROJECTS) {
    throw new Error('请选择含 1 至 500 个项目的 Folder Index 索引');
  }
  const projects = snapshot.projects.map((project) => {
    if (!Array.isArray(project?.category) || project.category.length > 2) {
      throw new Error('索引中的抽屉格式错误');
    }
    return {
      name: checkText(project.name, 120, '项目名'),
      category: project.category.map((part) => checkText(part, 120, '抽屉名')),
      path: checkText(project.path, 1024, '项目路径'),
      ...normalizeOptionalMeta(project),
    };
  });
  return { schema: SNAPSHOT_SCHEMA, projects };
}

export function serializeSnapshot(projects) {
  const text = JSON.stringify(normalizeSnapshot({ schema: SNAPSHOT_SCHEMA, projects }));
  checkSize(text);
  return text;
}

export function parseSnapshot(text) {
  checkSize(text);
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new Error('索引内容不是有效的 JSON');
  }
  return normalizeSnapshot(snapshot);
}

export function pathKey(path) {
  return path.toLowerCase();
}

/** 查询每个词（名称、路径、抽屉、Agent、技术栈、分支、备注），名称命中优先。同等匹配时置顶项目排在前面。 */
export function searchProjects(projects, query = '', category = null) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = [];
  for (const project of projects) {
    if (category && (category.length === 0
      ? project.category.length !== 0
      : !category.every((part, i) => part === project.category[i]))) continue;

    const name = project.name.toLowerCase();
    const searchable = [
      name,
      pathKey(project.path),
      ...project.category.map((part) => part.toLowerCase()),
      ...(project.agents ?? []).map((agent) => agent.toLowerCase()),
      ...(project.stack ?? []).map((tech) => tech.toLowerCase()),
      (project.branch ?? '').toLowerCase(),
      (project.note?.text ?? '').toLowerCase(),
    ].join('\n');
    if (!words.every((word) => searchable.includes(word))) continue;
    const score = words.reduce((sum, word) => sum + (name.startsWith(word) ? 3 : name.includes(word) ? 2 : 0), 0);
    matches.push({ project, score });
  }
  return matches.sort((a, b) => b.score - a.score
    || Number(Boolean(b.project.pinned)) - Number(Boolean(a.project.pinned))
    || a.project.name.localeCompare(b.project.name, 'zh-Hans-CN')
    || a.project.path.localeCompare(b.project.path)
  ).map(({ project }) => project);
}
