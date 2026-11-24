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

// ---------- 拼音首字母 ----------
// 不带字典：中文排序规则（CLDR 拼音序）里，每个声母都有排在最前面的一个字。
// 一个汉字落在哪两个起点字之间，就是哪个首字母。多音字取排序规则采用的读音。
const PINYIN_STARTS = [
  ['a', '吖'], ['b', '八'], ['c', '嚓'], ['d', '哒'], ['e', '妸'], ['f', '发'], ['g', '旮'], ['h', '哈'],
  ['j', '丌'], ['k', '咔'], ['l', '垃'], ['m', '妈'], ['n', '拏'], ['o', '噢'], ['p', '妑'], ['q', '七'],
  ['r', '呥'], ['s', '仨'], ['t', '他'], ['w', '屲'], ['x', '夕'], ['y', '丫'], ['z', '帀'],
];
const CJK = /[㐀-䶿一-鿿]/;
const initialsCache = new Map();
let pinyinCollator;

function getPinyinCollator() {
  if (pinyinCollator !== undefined) return pinyinCollator;
  try {
    const collator = new Intl.Collator('zh-Hans-CN');
    // 运行环境没有中文排序数据时，汉字会按码位排，结果不可信，干脆不提供拼音匹配
    const sane = collator.compare('阿', '八') < 0 && collator.compare('八', '嚓') < 0 && collator.compare('夕', '帀') < 0;
    pinyinCollator = sane ? collator : null;
  } catch {
    pinyinCollator = null;
  }
  return pinyinCollator;
}

function pinyinInitial(ch, collator) {
  let letter = '';
  for (const [l, start] of PINYIN_STARTS) {
    if (collator.compare(ch, start) >= 0) letter = l;
    else break;
  }
  return letter;
}

/** 「考研」→「ky」、「A_我的」→「awd」：汉字取首字母，字母数字保留，其他符号去掉。不支持时返回空串。 */
export function pinyinInitials(text) {
  if (typeof text !== 'string' || !CJK.test(text)) return '';
  const cached = initialsCache.get(text);
  if (cached !== undefined) return cached;
  const collator = getPinyinCollator();
  let out = '';
  if (collator) {
    for (const ch of text) {
      if (CJK.test(ch)) out += pinyinInitial(ch, collator);
      else if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
    }
  }
  if (initialsCache.size > 2000) initialsCache.clear();
  initialsCache.set(text, out);
  return out;
}

/** 查询每个词（名称、路径、抽屉、Agent、技术栈、分支、备注，以及名称和抽屉的拼音首字母），名称命中优先。同等匹配时置顶项目排在前面。 */
export function searchProjects(projects, query = '', category = null) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = [];
  for (const project of projects) {
    if (category && (category.length === 0
      ? project.category.length !== 0
      : !category.every((part, i) => part === project.category[i]))) continue;

    const name = project.name.toLowerCase();
    const nameInitials = pinyinInitials(project.name);
    const searchable = [
      name,
      nameInitials,
      pathKey(project.path),
      ...project.category.map((part) => part.toLowerCase()),
      ...project.category.map(pinyinInitials),
      ...(project.agents ?? []).map((agent) => agent.toLowerCase()),
      ...(project.stack ?? []).map((tech) => tech.toLowerCase()),
      (project.branch ?? '').toLowerCase(),
      (project.note?.text ?? '').toLowerCase(),
    ].join('\n');
    if (!words.every((word) => searchable.includes(word))) continue;
    const score = words.reduce((sum, word) => sum + (
      name.startsWith(word) || (nameInitials && nameInitials.startsWith(word)) ? 3
        : name.includes(word) || (nameInitials && nameInitials.includes(word)) ? 2 : 0
    ), 0);
    matches.push({ project, score });
  }
  return matches.sort((a, b) => b.score - a.score
    || Number(Boolean(b.project.pinned)) - Number(Boolean(a.project.pinned))
    || a.project.name.localeCompare(b.project.name, 'zh-Hans-CN')
    || a.project.path.localeCompare(b.project.path)
  ).map(({ project }) => project);
}

/** 把项目列成 Markdown，方便贴给别的 Agent 或写进 CLAUDE.md 之类的上下文文件。 */
export function projectsToMarkdown(projects, title, formatTime = (ms) => new Date(ms).toISOString().slice(0, 10)) {
  const seen = new Set();
  const unique = projects.filter((p) => {
    const key = pathKey(p.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const lines = [`## ${title}（${unique.length} 个项目）`, ''];
  for (const p of unique) {
    const facts = [];
    if (p.stack?.length) facts.push(p.stack.join(' / '));
    if (p.branch) facts.push(`分支 ${p.branch}`);
    if (p.category?.length) facts.push(`抽屉 ${p.category.join(' / ')}`);
    if (p.lastActive) facts.push(`最近 ${formatTime(p.lastActive)}`);
    if (p.agents?.length) facts.push(p.agents.join('、'));
    lines.push(`- **${p.name}** \`${p.path}\`${facts.length ? ` — ${facts.join(' · ')}` : ''}`);
    if (p.note?.text) lines.push(`  - 备注：${p.note.text.replace(/\s*\n\s*/g, ' ')}`);
  }
  return `${lines.join('\n')}\n`;
}
