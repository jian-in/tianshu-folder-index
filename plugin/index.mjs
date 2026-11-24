import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshot, pathKey, searchProjects } from './catalog.mjs';
import { BEGIN_MARKER, END_MARKER } from './scanner.mjs';

const sdk = globalThis.__tianshuTPI;
if (sdk?.version !== '2.0' || typeof sdk.defineTianshuPlugin !== 'function') {
  throw new Error('文件夹索引需要支持 TPI 2.0 的天枢宿主');
}

const VIEW = 'projects';
const SEARCH_TOOL = 'folder_index_search';
const SEARCH_DESC = '查找本机项目索引，支持按项目名、路径、抽屉或 Agent 名称搜索，返回匹配项目详情。';
const SCAN_TOOL = 'folder_index_scan_agents';
const SCAN_DESC = '只读扫描本机全部 AI Agent 与编辑器会话记录及可选索引目录，自动更新天枢中的项目索引（每次需用户确认）。';
const CATALOG = 'projects.json';
const DRAWERS_FILE = 'drawers.json';
const PREFS_FILE = 'prefs.json';
const MAX_DRAWERS = 64;
const UNSAFE_SHELL_PATH = /["'`$;&|\r\n<>]/;
const SHELL_SAFE_WORD = /^[\p{L}\p{N}_.:/-]+$/u;
const ALLOWED_THEMES = new Set(['auto', 'light', 'dark']);
const ALLOWED_SORTS = new Set(['default', 'recent', 'sessions']);

function pinId(path) {
  return createHash('sha256').update(pathKey(path)).digest('hex');
}

function ifMissing(fallback) {
  return (error) => {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  };
}

async function writeAtomicJson(dataDir, filename, payload) {
  await mkdir(dataDir, { recursive: true });
  const tempPath = join(dataDir, `.${filename}-${randomUUID()}.tmp`);
  const file = await open(tempPath, 'wx');
  try {
    try {
      await file.writeFile(JSON.stringify(payload), 'utf8');
    } finally {
      await file.close();
    }
    await rename(tempPath, join(dataDir, filename));
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function checkDrawerSegment(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f\\/]/.test(value)) {
    throw new Error('抽屉名需为 1 至 120 个字符，且不能包含斜杠或控制字符');
  }
  return value.trim();
}

function normalizeCategory(category) {
  if (!Array.isArray(category) || category.length > 2) {
    throw new Error('抽屉分类最多支持两级');
  }
  return category.map(checkDrawerSegment);
}

async function readOverrides(dataDir) {
  const dir = join(dataDir, 'overrides');
  const names = await readdir(dir).catch(ifMissing([]));
  const map = new Map();
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8'));
      const category = normalizeCategory(parsed?.category);
      map.set(name.slice(0, 64), category);
    } catch {
      // 忽略损坏单条覆写
    }
  }
  return map;
}

async function readDrawers(dataDir) {
  const raw = await readFile(join(dataDir, DRAWERS_FILE), 'utf8').catch(ifMissing(null));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const out = [];
    for (const item of parsed) {
      try {
        const cat = normalizeCategory(item);
        if (cat.length === 0) continue;
        const key = JSON.stringify(cat);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(cat);
        }
      } catch {
        // 忽略非法条目
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readPrefs(dataDir) {
  const raw = await readFile(join(dataDir, PREFS_FILE), 'utf8').catch(ifMissing(null));
  const defaults = { theme: 'auto', sort: 'default' };
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    const prefs = {
      theme: ALLOWED_THEMES.has(parsed?.theme) ? parsed.theme : 'auto',
      sort: ALLOWED_SORTS.has(parsed?.sort) ? parsed.sort : 'default',
    };
    if (isValidHubDir(parsed?.hubDir)) prefs.hubDir = parsed.hubDir;
    return prefs;
  } catch {
    return defaults;
  }
}

function isValidHubDir(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** 记住最近一次扫描用过的 Folder Index 索引目录，之后扫描省略 hubDir 时沿用；传空字符串表示不再读取。 */
async function rememberHubDir(dataDir, hubDir) {
  const current = await readPrefs(dataDir);
  const next = { ...current };
  if (hubDir) next.hubDir = hubDir;
  else delete next.hubDir;
  if (next.hubDir !== current.hubDir) await writeAtomicJson(dataDir, PREFS_FILE, next);
}

async function setPrefs(dataDir, patch) {
  const current = await readPrefs(dataDir);
  const next = { ...current };
  if (patch?.theme !== undefined) {
    if (!ALLOWED_THEMES.has(patch.theme)) throw new Error('不支持的主题选项');
    next.theme = patch.theme;
  }
  if (patch?.sort !== undefined) {
    if (!ALLOWED_SORTS.has(patch.sort)) throw new Error('不支持的排序选项');
    next.sort = patch.sort;
  }
  await writeAtomicJson(dataDir, PREFS_FILE, next);
  return next;
}

async function listProjects(dataDir) {
  const source = await readFile(join(dataDir, CATALOG), 'utf8').catch(ifMissing(null));
  if (source === null) return [];
  const { projects } = parseSnapshot(source);
  const [markers, overrides] = await Promise.all([
    readdir(join(dataDir, 'pinned')).catch(ifMissing([])),
    readOverrides(dataDir),
  ]);
  const pinSet = new Set(markers);
  return projects.map((project) => {
    const id = pinId(project.path);
    const out = { ...project, pinned: pinSet.has(id) };
    if (overrides.has(id)) {
      out.category = overrides.get(id);
      delete out.indexed;
    }
    return out;
  });
}

async function importSnapshot(dataDir, text) {
  const snapshot = parseSnapshot(text);
  await writeAtomicJson(dataDir, CATALOG, snapshot);
}

async function setPinned(dataDir, path, pinned) {
  if (typeof path !== 'string' || typeof pinned !== 'boolean'
    || !(await listProjects(dataDir)).some((project) => pathKey(project.path) === pathKey(path))) {
    throw new Error('所选项目已不在当前索引中');
  }
  const dir = join(dataDir, 'pinned');
  // 每个项目独立存储置顶状态，几个会话同时修改也无需重写整份名单。
  const marker = join(dir, pinId(path));
  if (pinned) {
    await mkdir(dir, { recursive: true });
    await writeFile(marker, '', { flag: 'a' });
  } else {
    await unlink(marker).catch(ifMissing(undefined));
  }
  return { path, pinned };
}

async function assignCategory(dataDir, path, rawCategory) {
  if (typeof path !== 'string'
    || !(await listProjects(dataDir)).some((project) => pathKey(project.path) === pathKey(path))) {
    throw new Error('所选项目已不在当前索引中');
  }
  const category = normalizeCategory(rawCategory);
  const dir = join(dataDir, 'overrides');
  await writeAtomicJson(dir, `${pinId(path)}.json`, { category });
  if (category.length > 0) {
    await ensureDrawer(dataDir, category);
  }
  return {
    projects: await listProjects(dataDir),
    drawers: await readDrawers(dataDir),
  };
}

async function ensureDrawer(dataDir, category) {
  const current = await readDrawers(dataDir);
  const keys = new Set(current.map((c) => JSON.stringify(c)));
  const toAdd = [];
  if (category.length === 2 && !keys.has(JSON.stringify([category[0]]))) {
    toAdd.push([category[0]]);
  }
  if (!keys.has(JSON.stringify(category))) {
    toAdd.push(category);
  }
  if (toAdd.length === 0) return current;
  if (current.length + toAdd.length > MAX_DRAWERS) {
    throw new Error(`虚拟抽屉最多支持 ${MAX_DRAWERS} 个`);
  }
  const next = [...current, ...toAdd];
  await writeAtomicJson(dataDir, DRAWERS_FILE, next);
  return next;
}

async function createDrawer(dataDir, parent, name) {
  const parentCat = normalizeCategory(parent ?? []);
  if (parentCat.length >= 2) throw new Error('抽屉最多支持两级');
  const segment = checkDrawerSegment(name);
  const target = [...parentCat, segment];
  const drawers = await ensureDrawer(dataDir, target);
  return { category: target, drawers };
}

/**
 * 天枢的命令工具在 Windows 上默认用 Git Bash，找不到 Git Bash 或设置了 RIVET_USE_POWERSHELL 时改用 PowerShell。
 * 路径只含字母、数字和 `_ . : / -` 时，换成正斜杠后不加引号，两种 shell 都能直接执行；
 * 否则按 bash 写法（"a" "b"）和 PowerShell 写法（& "a" "b"）依次尝试。
 * 返回值是按顺序尝试的候选命令。
 */
export function buildScanCommands(req, nodeBin = process.execPath, scannerFile = fileURLToPath(new URL('./scanner.mjs', import.meta.url))) {
  const encoded = Buffer.from(JSON.stringify(req), 'utf8').toString('base64url');
  const bare = [nodeBin, scannerFile].map((p) => p.replaceAll('\\', '/'));
  if (bare.every((p) => SHELL_SAFE_WORD.test(p))) {
    return [`${bare[0]} ${bare[1]} --req-b64 ${encoded}`];
  }
  if (UNSAFE_SHELL_PATH.test(nodeBin) || UNSAFE_SHELL_PATH.test(scannerFile)) {
    throw new Error('运行环境路径包含不支持的特殊字符，已中止扫描命令');
  }
  const quoted = `"${nodeBin}" "${scannerFile}" --req-b64 ${encoded}`;
  return [quoted, `& ${quoted}`];
}

function extractSnapshotFromOutput(output) {
  if (typeof output !== 'string') throw new Error('扫描命令未返回文本输出');
  const start = output.indexOf(BEGIN_MARKER);
  const end = output.indexOf(END_MARKER, start >= 0 ? start + BEGIN_MARKER.length : 0);
  if (start < 0 || end < 0) {
    throw new Error('扫描输出缺少有效的索引标记，请检查本机环境');
  }
  return output.slice(start + BEGIN_MARKER.length, end).trim();
}

export default sdk.defineTianshuPlugin({
  id: 'folder-index',
  async activate(host) {
    if (!host.storage) throw new Error('宿主未提供插件存储');
    const dataDir = await host.storage.dataDir();

    return {
      tools: [
        {
          name: SEARCH_TOOL,
          description: SEARCH_DESC,
          inputSchema: {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string', minLength: 1, maxLength: 200, description: '项目名、路径、抽屉名或 Agent 名' },
              limit: { type: 'integer', minimum: 1, maximum: 20 },
            },
            additionalProperties: false,
          },
          concurrencySafe: true,
          async execute({ args }) {
            const { query, limit = 12 } = args ?? {};
            if (typeof query !== 'string' || !query.trim() || query.length > 200
              || !Number.isInteger(limit) || limit < 1 || limit > 20) {
              return { content: '请输入 1 至 200 个字符的关键词，结果上限为 20。', isError: true };
            }
            const results = searchProjects(await listProjects(dataDir), query);
            return { content: JSON.stringify({ total: results.length, projects: results.slice(0, limit) }) };
          },
        },
        {
          name: SCAN_TOOL,
          description: SCAN_DESC,
          inputSchema: {
            type: 'object',
            properties: {
              hubDir: {
                type: 'string',
                maxLength: 512,
                description: '可选：本机 Folder Index 索引目录的绝对路径，用来保留其中的抽屉分类。省略时沿用上次扫描传过的目录，传空字符串表示不读取索引目录。',
              },
              includeUnindexed: {
                type: 'boolean',
                description: '是否一并收录未放进索引目录但被各 Agent 用过的项目，默认 true',
              },
              onlyWithSessions: {
                type: 'boolean',
                description: '是否仅保留有真实会话记录的项目（过滤仅有信任记录的项），默认 true',
              },
            },
            additionalProperties: false,
          },
          concurrencySafe: false,
          requiresApproval: true,
          timeoutMs: 30_000,
          async execute({ args }) {
            if (!host.shell) {
              return { content: '当前天枢宿主未向本插件开放 shell 能力，无法执行自动扫描。', isError: true };
            }
            const {
              hubDir,
              includeUnindexed = true,
              onlyWithSessions = true,
            } = args ?? {};

            if (hubDir !== undefined && (typeof hubDir !== 'string' || hubDir.length > 512 || /[\u0000-\u001f\u007f]/.test(hubDir)
              || (hubDir.trim() && !isAbsolute(hubDir.trim())))) {
              return { content: 'hubDir 必须是本机目录的绝对路径，或传空字符串表示不读取索引目录。', isError: true };
            }
            if (typeof includeUnindexed !== 'boolean' || typeof onlyWithSessions !== 'boolean') {
              return { content: 'includeUnindexed 与 onlyWithSessions 必须为布尔值。', isError: true };
            }

            try {
              const effectiveHubDir = hubDir === undefined ? (await readPrefs(dataDir)).hubDir : hubDir.trim();
              const commands = buildScanCommands({
                ...(effectiveHubDir ? { hubDir: effectiveHubDir } : {}),
                includeUnindexed,
                onlyWithSessions,
              });
              let res;
              for (const command of commands) {
                res = await host.shell.run(command, { timeoutMs: 25_000 });
                if (res.exitCode === 0 && typeof res.output === 'string' && res.output.includes(END_MARKER)) break;
              }
              if (res.exitCode !== 0) {
                const detail = (res.output || '').trim().slice(0, 300);
                return { content: `扫描命令退出码 ${res.exitCode}${detail ? `：${detail}` : ''}`, isError: true };
              }
              const snapshotText = extractSnapshotFromOutput(res.output);
              await importSnapshot(dataDir, snapshotText);
              if (hubDir !== undefined) await rememberHubDir(dataDir, hubDir.trim());
              const [projects, drawers] = await Promise.all([listProjects(dataDir), readDrawers(dataDir)]);
              await host.ui?.post(VIEW, { action: 'updated', projects, drawers }).catch(() => {});

              const agents = [...new Set(projects.flatMap((p) => p.agents ?? []))];
              const indexedCount = projects.filter((p) => p.indexed !== false).length;
              const unindexedCount = projects.filter((p) => p.indexed === false).length;
              const pinnedCount = projects.filter((p) => p.pinned).length;
              return {
                content: JSON.stringify({
                  scanned: true,
                  total: projects.length,
                  indexedCount,
                  unindexedCount,
                  pinnedCount,
                  agents,
                }),
              };
            } catch (error) {
              host.log?.warn(`folder_index_scan_agents 失败: ${error.message}`);
              return { content: error.message || '自动扫描本机 Agent 项目失败。', isError: true };
            }
          },
        },
      ],
      ui: {
        async onMessage(view, message) {
          if (view !== VIEW || !message || typeof message !== 'object') throw new Error('无效的项目速查消息');
          switch (message.action) {
            case 'list':
              return { projects: await listProjects(dataDir) };
            case 'state':
              return {
                projects: await listProjects(dataDir),
                drawers: await readDrawers(dataDir),
                prefs: await readPrefs(dataDir),
              };
            case 'import':
              await importSnapshot(dataDir, message.text);
              return { projects: await listProjects(dataDir) };
            case 'pin':
              return setPinned(dataDir, message.path, message.pinned);
            case 'assign':
              return assignCategory(dataDir, message.path, message.category);
            case 'createDrawer':
              return createDrawer(dataDir, message.parent, message.name);
            case 'setPrefs':
              return { prefs: await setPrefs(dataDir, message) };
            default:
              throw new Error('不支持的项目速查操作');
          }
        },
      },
    };
  },
});
