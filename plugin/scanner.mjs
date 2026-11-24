// 包内只读扫描脚本：仅在用户明确批准 folder_index_scan_agents 工具后，经天枢 host.shell.run 执行。
// 严格只读：扫描本机各 AI Agent / 编辑器的会话记录与工作区记录，以及调用方给出的 Folder Index 索引目录；绝不写入、删除或联网。
// 会话记录文件只读开头一段（最多 256 KiB）用来找出工作目录；对每个项目再列一次根目录文件名识别技术栈、读 .git/HEAD 得到分支。
// 输出里只有项目路径、名称、Agent 名、会话数、最近活跃时间、技术栈标签和分支名，不含对话内容和文件内容。
import { lstat, open, readdir, readFile, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeSnapshot } from './catalog.mjs';

export const BEGIN_MARKER = '<<<FOLDER_INDEX_SNAPSHOT_BEGIN>>>';
export const END_MARKER = '<<<FOLDER_INDEX_SNAPSHOT_END>>>';

const FIRST_BYTES = 64 * 1024;
const HEAD_BYTES = 256 * 1024;
const CONCURRENCY = 4;
const MAX_CATEGORY_DEPTH = 2;
const META_FILE = '.folder-index.json';
const META_TEMP_PREFIX = `${META_FILE}.tmp-`;
const MAX_PROJECTS = 500;

function defaultSources() {
  const home = homedir();
  const appData = process.platform === 'win32'
    ? (process.env.APPDATA || join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || join(home, '.config'));

  return {
    home,
    claudeDesktopDir: join(appData, 'Claude', 'claude-code-sessions'),
    jsonlDirs: [
      { agent: 'Claude', dir: join(home, '.claude', 'projects'), depth: 1 },
      { agent: 'WorkBuddy', dir: join(home, '.workbuddy', 'projects'), depth: 1 },
      { agent: 'Codex', dir: join(home, '.codex', 'sessions'), depth: 4 },
    ],
    vscodeStorages: [
      { agent: 'VS Code', dir: join(appData, 'Code', 'User', 'workspaceStorage') },
      { agent: 'Cursor', dir: join(appData, 'Cursor', 'User', 'workspaceStorage') },
      { agent: 'Qoder', dir: join(appData, 'Qoder', 'User', 'workspaceStorage') },
      { agent: 'Trae', dir: join(appData, 'Trae', 'User', 'workspaceStorage') },
      { agent: 'Windsurf', dir: join(appData, 'Windsurf', 'User', 'workspaceStorage') },
      { agent: 'Kiro', dir: join(appData, 'Kiro', 'User', 'workspaceStorage') },
    ],
    orcaHistoryFile: join(appData, 'orca', 'orca-usage-worktree-history.json'),
    codexConfigFile: join(home, '.codex', 'config.toml'),
    opencodeDb: join(home, '.local', 'share', 'opencode', 'opencode.db'),
    antigravityDbs: [
      { agent: 'Antigravity', file: join(home, '.gemini', 'antigravity', 'conversation_summaries.db') },
      { agent: 'Antigravity CLI', file: join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db') },
    ],
  };
}

async function openSqlite(file) {
  try {
    await stat(file);
  } catch {
    return null;
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

async function mapPool(items, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

// 项目根目录里出现这些文件名，就记一个技术栈标签（只看文件名，不读内容）。
const STACK_MARKERS = [
  ['package.json', 'Node'], ['tsconfig.json', 'TypeScript'], ['deno.json', 'Deno'], ['bun.lockb', 'Bun'],
  ['cargo.toml', 'Rust'], ['go.mod', 'Go'],
  ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['setup.py', 'Python'], ['environment.yml', 'Python'],
  ['pom.xml', 'Java'], ['build.gradle', 'Java'], ['build.gradle.kts', 'Kotlin'],
  ['cmakelists.txt', 'C/C++'], ['makefile', 'Make'], ['gemfile', 'Ruby'], ['composer.json', 'PHP'],
  ['pubspec.yaml', 'Flutter'], ['package.swift', 'Swift'], ['dockerfile', 'Docker'],
  ['tianshu.plugin.json', '天枢插件'], ['.obsidian', 'Obsidian'],
];
const STACK_EXTENSIONS = [['.sln', '.NET'], ['.csproj', '.NET'], ['.ipynb', 'Jupyter']];
const MAX_STACK = 8;

/** 读取 .git/HEAD 得到当前分支；.git 是文件（worktree / submodule）时跟着 gitdir 找。不执行 git 命令。 */
async function readGitBranch(dir) {
  let gitDir = join(dir, '.git');
  try {
    const st = await lstat(gitDir);
    if (st.isFile()) {
      const pointer = (await readHead(gitDir, 4096)).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!pointer) return '';
      gitDir = cleanPath(resolve(dir, pointer));
      if (!gitDir) return '';
    } else if (!st.isDirectory()) {
      return '';
    }
  } catch {
    return '';
  }
  const head = (await readHead(join(gitDir, 'HEAD'), 4096)).trim();
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1];
  if (ref) return ref.slice(0, 120);
  return /^[0-9a-f]{40,64}$/i.test(head) ? `detached@${head.slice(0, 7)}` : '';
}

/** 只读识别项目画像：技术栈标签和 Git 分支。目录读不到时返回空。 */
export async function profileProject(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return {};
  }
  const lower = new Set(names.map((name) => name.toLowerCase()));
  const stack = [];
  const add = (tag) => { if (!stack.includes(tag) && stack.length < MAX_STACK) stack.push(tag); };
  for (const [marker, tag] of STACK_MARKERS) if (lower.has(marker)) add(tag);
  for (const [ext, tag] of STACK_EXTENSIONS) if ([...lower].some((name) => name.endsWith(ext))) add(tag);
  const profile = {};
  if (stack.length) profile.stack = stack;
  if (lower.has('.git')) {
    const branch = await readGitBranch(dir);
    if (branch) profile.branch = branch;
  }
  return profile;
}

async function collectFiles(dir, ext, maxDepth) {
  const out = [];
  async function walk(d, depth) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory() && depth < maxDepth) await walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(ext)) out.push(full);
    }
  }
  await walk(dir, 0);
  return out;
}

async function readHead(file, bytes) {
  let fh;
  try {
    fh = await open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => {});
  }
}

export function cleanPath(raw) {
  if (typeof raw !== 'string') return '';
  let p = raw.trim();
  if (!p) return '';
  if (p.startsWith('file://')) {
    try {
      p = fileURLToPath(p);
    } catch {
      return '';
    }
  }
  // 普通盘符的长路径前缀（\\?\E:\…）归到同一个本机路径；\\?\UNC\… 等其余设备前缀保持原样，下面会被拒绝。
  if (/^\\\\\?\\[a-z]:[\\/]/i.test(p)) p = p.slice(4);
  // 只接受本机绝对路径：相对路径会被错误地解析到扫描进程的当前目录；
  // UNC 共享与 Windows 设备路径一旦 stat/readlink 就会访问网络主机或设备，一律丢弃。
  if (!isAbsolute(p) || isNetworkOrDevicePath(p)) return '';
  if (/^[a-z]:/i.test(p)) p = p[0].toUpperCase() + p.slice(1);
  if (p.length > 3 && (p.endsWith('\\') || p.endsWith('/'))) p = p.slice(0, -1);
  const full = resolve(p);
  return isNetworkOrDevicePath(full) ? '' : full;
}

/** `\\server\share`、`//server/share`、`\\?\UNC\…`、`\\.\…` 等。 */
export function isNetworkOrDevicePath(p) {
  return /^[\\/]{2}/.test(p);
}

const SKIP_EXACT = new Set(['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin']);
// 与桌面端 Folder Index（lib/discover.mjs 的 INTERNAL_SEGMENTS）保持一致：构建产物、虚拟环境、工具内部数据目录
const SKIP_SEGMENTS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', '__pycache__', '.data', '.cache', '.venv', 'venv', '.next',
]);
// Agent 自动创建、按日期命名的临时会话目录，例如 Documents\Codex\2026-11-24\new-chat，整棵子树都不算项目。
const SCRATCH_PATTERNS = [
  /[\\/]documents[\\/](codex|qoder|claude)[\\/]\d{4}-\d{2}-\d{2}([\\/]|$)/i,
  /[\\/]workbuddy[\\/]\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}([\\/]|$)/i,
];

export function shouldSkip(p, home, hubDir = '') {
  if (!p) return true;
  const lower = p.toLowerCase();
  const root = parse(p).root.toLowerCase();
  if (lower === root || lower + sep === root) return true;

  const h = resolve(home).toLowerCase();
  if (lower === h) return true;
  if (lower.startsWith(join(h, 'appdata').toLowerCase())) return true;
  if (lower.includes(`${sep}.claude${sep}worktrees`) || lower.includes(`${sep}worktrees${sep}`)) return true;
  if (SCRATCH_PATTERNS.some((re) => re.test(lower))) return true;
  // 通过索引目录里的联接打开的路径，真实项目已经按链接目标收录过了
  if (hubDir) {
    const hub = resolve(hubDir).toLowerCase();
    if (lower === hub || lower.startsWith(hub + sep)) return true;
  }

  const segs = p.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  if (segs.length <= 1) return true;
  if (SKIP_EXACT.has(segs[1])) return true;
  if (segs.some((s) => SKIP_SEGMENTS.has(s))) return true;
  if (/^\d{4}[-_]\d{2}[-_]\d{2}/.test(segs[segs.length - 1])) return true;
  return false;
}

function addRecord(map, rawPath, { agent, lastActive = 0, isSession = true }) {
  const p = cleanPath(rawPath);
  if (!p) return;
  const key = p.toLowerCase();
  let rec = map.get(key);
  if (!rec) {
    rec = { path: p, agents: new Set(), sessions: 0, lastActive: 0 };
    map.set(key, rec);
  }
  rec.agents.add(agent);
  if (isSession) rec.sessions += 1;
  if (lastActive > rec.lastActive) rec.lastActive = lastActive;
}

function extractCwd(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes('cwd')) continue;
    try {
      const obj = JSON.parse(line);
      const cwd = obj.cwd || obj.payload?.cwd;
      if (typeof cwd === 'string' && cwd.trim()) return cwd;
    } catch {
      // 跳过截断行
    }
  }
  return '';
}

async function scanClaudeDesktop(map, dir, seenCliSessions) {
  const files = await collectFiles(dir, '.json', 4);
  await mapPool(files, async (file) => {
    try {
      const obj = JSON.parse(await readFile(file, 'utf8'));
      if (typeof obj.cliSessionId === 'string') seenCliSessions.add(obj.cliSessionId);
      const cwd = obj.originCwd || obj.cwd || obj.projectPath;
      const last = Number(obj.lastActivityAt || obj.createdAt || obj.updatedAt || 0);
      if (typeof cwd === 'string' && cwd.trim()) {
        addRecord(map, cwd, { agent: 'Claude', lastActive: Number.isFinite(last) ? Math.floor(last) : 0, isSession: true });
      }
    } catch {
      // 忽略损坏文件
    }
  });
}

async function scanJsonlDirDedup(map, { agent, dir, depth }, seenCliSessions) {
  const files = await collectFiles(dir, '.jsonl', depth);
  const filtered = files.filter((file) => !seenCliSessions.has(basename(file, '.jsonl')));
  await mapPool(filtered, async (file) => {
    let mtime = 0;
    try {
      mtime = Math.floor((await stat(file)).mtimeMs);
    } catch {
      return;
    }
    let text = await readHead(file, FIRST_BYTES);
    let cwd = extractCwd(text);
    if (!cwd && text.length >= FIRST_BYTES - 16) {
      text = await readHead(file, HEAD_BYTES);
      cwd = extractCwd(text);
    }
    if (cwd) addRecord(map, cwd, { agent, lastActive: mtime, isSession: true });
  });
}

async function scanVsCode(map, { agent, dir }) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await mapPool(entries, async (e) => {
    if (!e.isDirectory()) return;
    const ws = join(dir, e.name, 'workspace.json');
    try {
      const [raw, st] = await Promise.all([readFile(ws, 'utf8'), stat(ws)]);
      const obj = JSON.parse(raw);
      if (typeof obj.folder === 'string') {
        addRecord(map, obj.folder, { agent, lastActive: Math.floor(st.mtimeMs), isSession: true });
      }
    } catch {
      // 忽略
    }
  });
}

async function scanOrca(map, file) {
  try {
    const history = JSON.parse(await readFile(file, 'utf8'));
    for (const entry of history.worktrees ?? []) {
      const key = Array.isArray(entry) ? entry[0] : null;
      if (typeof key !== 'string' || !key.includes('::')) continue;
      addRecord(map, key.slice(key.indexOf('::') + 2), { agent: 'Orca', isSession: false });
    }
  } catch {
    // 忽略
  }
}

async function scanCodexTrust(map, file) {
  try {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/^\[projects\.(?:'([^']+)'|"((?:[^"\\]|\\.)+)")\]\s*$/gm)) {
      const p = match[1] ?? JSON.parse(`"${match[2]}"`);
      addRecord(map, p, { agent: 'Codex', isSession: false });
    }
  } catch {
    // 忽略
  }
}

async function scanOpencode(map, file) {
  const db = await openSqlite(file);
  if (!db) return;
  try {
    const rows = db.prepare(`
      select p.worktree as dir, count(s.id) as n, max(coalesce(s.time_updated, p.time_updated)) as t
      from project p left join session s on s.project_id = p.id
      group by p.id`).all();
    for (const row of rows) {
      const ts = Number(row.t || 0);
      const count = Math.max(1, Number(row.n || 0));
      for (let i = 0; i < count; i += 1) {
        addRecord(map, row.dir, { agent: 'opencode', lastActive: ts > 1e12 ? Math.floor(ts) : Math.floor(ts * 1000), isSession: true });
      }
    }
    for (const row of db.prepare('select directory as dir, max(time_updated) as t from session group by directory').all()) {
      const ts = Number(row.t || 0);
      addRecord(map, row.dir, { agent: 'opencode', lastActive: ts > 1e12 ? Math.floor(ts) : Math.floor(ts * 1000), isSession: false });
    }
  } catch {
    // 忽略
  } finally {
    db.close();
  }
}

async function scanAntigravity(map, { agent, file }) {
  const db = await openSqlite(file);
  if (!db) return;
  try {
    const rows = db.prepare('select workspace_uris as w, last_modified_time as t from conversation_summaries where workspace_uris is not null').all();
    for (const row of rows) {
      let uris = [];
      try {
        const parsed = JSON.parse(row.w);
        if (Array.isArray(parsed)) uris = parsed;
      } catch {
        continue;
      }
      const rawT = row.t;
      let ms = 0;
      if (typeof rawT === 'number' && Number.isFinite(rawT)) {
        ms = rawT > 1e12 ? Math.floor(rawT) : (rawT > 1e9 ? Math.floor(rawT * 1000) : 0);
      } else if (typeof rawT === 'string') {
        const parsedMs = Date.parse(rawT);
        if (Number.isFinite(parsedMs)) ms = Math.floor(parsedMs);
      }
      const seenInRow = new Set();
      for (const u of uris) {
        let raw = String(u).trim();
        if (!raw) continue;
        for (let k = 0; k < 2; k += 1) {
          if (raw.includes('%25')) {
            try { raw = decodeURIComponent(raw); } catch { break; }
          }
        }
        const cleaned = cleanPath(raw);
        if (!cleaned) continue;
        const k = cleaned.toLowerCase();
        if (seenInRow.has(k)) continue;
        seenInRow.add(k);
        addRecord(map, cleaned, { agent, lastActive: ms, isSession: true });
      }
    }
  } catch {
    // 忽略
  } finally {
    db.close();
  }
}

async function readHubLinks(hubDir) {
  const root = cleanPath(hubDir);
  if (!root) return []; // 不接受网络共享或相对路径作为索引目录
  let rootSt;
  try {
    rootSt = await lstat(root);
  } catch {
    return [];
  }
  if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) return [];

  const links = [];
  async function walk(dir, segments) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const entry of entries) {
      if (segments.length === 0 && (entry.name === META_FILE || (entry.isFile() && entry.name.startsWith(META_TEMP_PREFIX)))) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          const target = cleanPath(await readlink(full));
          if (!target) continue;
          const st = await stat(full);
          if (!st.isDirectory()) continue;
          links.push({ name: entry.name, category: segments, path: target });
        } catch {
          // 跳过失效链接
        }
      } else if (entry.isDirectory() && segments.length < MAX_CATEGORY_DEPTH) {
        await walk(full, [...segments, entry.name]);
      }
    }
  }
  await walk(root, []);
  return links;
}

export async function scanAllProjects(options = {}) {
  const sources = defaultSources();
  const discoveredMap = new Map();
  const seenCliSessions = new Set();

  await scanClaudeDesktop(discoveredMap, sources.claudeDesktopDir, seenCliSessions);
  await Promise.all([
    ...sources.jsonlDirs.map((d) => scanJsonlDirDedup(discoveredMap, d, seenCliSessions)),
    ...sources.vscodeStorages.map((v) => scanVsCode(discoveredMap, v)),
    scanOrca(discoveredMap, sources.orcaHistoryFile),
    scanCodexTrust(discoveredMap, sources.codexConfigFile),
    scanOpencode(discoveredMap, sources.opencodeDb),
    ...sources.antigravityDbs.map((db) => scanAntigravity(discoveredMap, db)),
  ]);

  const onlyWithSessions = options.onlyWithSessions !== false;
  const includeUnindexed = options.includeUnindexed !== false;
  // 只读调用方明确给出的索引目录，不猜默认位置。
  const hubDir = typeof options.hubDir === 'string' ? options.hubDir.trim() : '';

  const indexedLinks = await readHubLinks(hubDir);
  const indexedPaths = new Set();
  const projects = [];

  for (const link of indexedLinks) {
    const key = link.path.toLowerCase();
    indexedPaths.add(key);
    const meta = discoveredMap.get(key);
    const item = { name: link.name, category: link.category, path: link.path };
    if (meta?.agents?.size) item.agents = [...meta.agents];
    if (meta?.sessions > 0) item.sessions = meta.sessions;
    if (meta?.lastActive > 0) item.lastActive = meta.lastActive;
    projects.push(item);
  }

  if (includeUnindexed) {
    const candidates = [];
    for (const [key, rec] of discoveredMap.entries()) {
      if (indexedPaths.has(key)) continue;
      if (onlyWithSessions && rec.sessions <= 0) continue;
      if (shouldSkip(rec.path, sources.home, hubDir)) continue;
      candidates.push(rec);
    }

    const existing = [];
    await mapPool(candidates, async (rec) => {
      try {
        if ((await stat(rec.path)).isDirectory()) existing.push(rec);
      } catch {
        // 目录已删除则跳过
      }
    });

    existing.sort((a, b) => (b.lastActive - a.lastActive) || (b.sessions - a.sessions));
    for (const rec of existing) {
      const item = {
        name: basename(rec.path) || rec.path,
        category: [],
        path: rec.path,
        agents: [...rec.agents],
        indexed: false,
      };
      if (rec.sessions > 0) item.sessions = rec.sessions;
      if (rec.lastActive > 0) item.lastActive = rec.lastActive;
      projects.push(item);
    }
  }

  // 控制数量与 96 KiB 快照大小上限：保留已收录项优先，其余按最近活跃截断
  let trimmed = projects.slice(0, MAX_PROJECTS);
  await mapPool(trimmed, async (item) => Object.assign(item, await profileProject(item.path)));
  while (trimmed.length > 0) {
    try {
      const snapshotText = serializeSnapshot(trimmed);
      return {
        snapshotText,
        total: trimmed.length,
        indexedCount: trimmed.filter((p) => p.indexed !== false).length,
        unindexedCount: trimmed.filter((p) => p.indexed === false).length,
      };
    } catch {
      trimmed = trimmed.slice(0, Math.max(1, Math.floor(trimmed.length * 0.85)));
      if (trimmed.length === 1) break;
    }
  }
  throw new Error('未在本机扫描到任何有效的项目文件夹');
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  let req = {};
  const idx = process.argv.indexOf('--req-b64');
  if (idx >= 0 && process.argv[idx + 1]) {
    const raw = Buffer.from(process.argv[idx + 1], 'base64url').toString('utf8');
    req = JSON.parse(raw);
  }
  const result = await scanAllProjects(req);
  process.stdout.write(`${BEGIN_MARKER}\n${result.snapshotText}\n${END_MARKER}\n`);
}
