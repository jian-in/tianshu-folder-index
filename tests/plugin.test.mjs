import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseSnapshot, searchProjects, serializeSnapshot } from '../plugin/catalog.mjs';
import { BEGIN_MARKER, END_MARKER, cleanPath } from '../plugin/scanner.mjs';

globalThis.__tianshuTPI = { version: '2.0', defineTianshuPlugin: (spec) => spec };
const { default: plugin, buildScanCommands } = await import('../plugin/index.mjs');
delete globalThis.__tianshuTPI;

const projects = [
  { name: 'Atlas', category: ['开发', '插件'], path: 'E:\\demo\\atlas' },
  { name: 'Notes', category: ['学习'], path: 'E:\\demo\\notes' },
  { name: 'Inbox', category: [], path: 'D:\\inbox' },
];
const serialized = serializeSnapshot(projects);

async function fixture(t, extraHost = {}) {
  const tempRoot = resolve(tmpdir());
  const dataDir = await mkdtemp(join(tempRoot, 'folder-index-tpi2-test-'));
  assert.equal(dirname(resolve(dataDir)), tempRoot);
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const host = { storage: { dataDir: async () => dataDir }, ...extraHost };
  return { host, runtime: await plugin.activate(host) };
}

test('桌面导出的快照仅保留项目字段，可按名称和抽屉查询', () => {
  const snapshot = parseSnapshot(serializeSnapshot(projects.map((project) => ({ ...project, titles: ['会话标题'] }))));
  assert.deepEqual(snapshot.projects, projects);
  assert.deepEqual(searchProjects(snapshot.projects, '开发 atlas'), [projects[0]]);
  assert.deepEqual(searchProjects(snapshot.projects, '', ['开发']), [projects[0]]);
  assert.deepEqual(searchProjects(snapshot.projects, '', []), [projects[2]]);

  const pinned = snapshot.projects.map((project) => ({ ...project, pinned: project.name === 'Notes' }));
  assert.equal(searchProjects(pinned, '')[0].name, 'Notes');
  assert.equal(searchProjects(pinned, 'atlas')[0].name, 'Atlas');
});

test('模拟 TPI 宿主完成导入、Agent 查询、并行置顶与重开', async (t) => {
  const { host, runtime } = await fixture(t);
  const manifest = JSON.parse(await readFile(new URL('../plugin/tianshu.plugin.json', import.meta.url), 'utf8'));
  assert.equal(plugin.id, manifest.id);
  assert.deepEqual(runtime.tools.map(({ name }) => name), manifest.contributes.tools.map(({ name }) => name));
  const message = (body) => runtime.ui.onMessage('projects', body);
  assert.deepEqual(await message({ action: 'list' }), { projects: [] });

  const imported = await message({ action: 'import', text: serialized });
  assert.equal(imported.projects.length, 3);
  const [tool] = runtime.tools;
  const result = await tool.execute({ args: { query: 'demo', limit: 1 } });
  const found = JSON.parse(result.content);
  assert.equal(found.total, 2);
  assert.equal(found.projects.length, 1);

  const second = await plugin.activate(host);
  await Promise.all([
    message({ action: 'pin', path: 'e:\\DEMO\\atlas', pinned: true }),
    second.ui.onMessage('projects', { action: 'pin', path: projects[1].path, pinned: true }),
  ]);
  const reopened = await plugin.activate(host);
  const refresh = await reopened.ui.onMessage('projects', { action: 'import', text: serialized });
  assert.deepEqual(refresh.projects.filter((project) => project.pinned).map(({ name }) => name), ['Atlas', 'Notes']);
  await message({ action: 'pin', path: projects[0].path, pinned: false });
  const results = JSON.parse((await tool.execute({ args: { query: 'demo' } })).content).projects;
  assert.equal(results[0].name, 'Notes');
  assert.equal(results.find(({ name }) => name === 'Atlas').pinned, false);
});

test('无效导入和越过当前索引的置顶请求保留已有数据', async (t) => {
  const { runtime } = await fixture(t);
  const message = (body) => runtime.ui.onMessage('projects', body);
  const saved = await message({ action: 'import', text: serialized });
  await assert.rejects(message({ action: 'import', text: '{"schema":"unknown","projects":[]}' }), /Folder Index 索引/);
  await assert.rejects(message({ action: 'import', text: ' '.repeat(96 * 1024 + 1) }), /96 KiB/);
  await assert.rejects(message({ action: 'pin', path: 'E:\\demo\\unlisted', pinned: true }), /不在当前索引/);
  await assert.rejects(runtime.ui.onMessage('other', { action: 'list' }), /无效的项目速查消息/);
  assert.deepEqual(await message({ action: 'list' }), saved);
  assert.equal((await runtime.tools[0].execute({ args: { query: '', limit: 500 } })).isError, true);
});

test('folder_index_scan_agents 通过 shell.run 扫描、保留置顶并经 ui.post 实时推送', async (t) => {
  const scannedSnapshot = serializeSnapshot([
    { name: 'Atlas', category: ['开发', '插件'], path: 'E:\\demo\\atlas', agents: ['Claude', 'Antigravity'], sessions: 6 },
    { name: 'FreshRepo', category: [], path: 'E:\\demo\\fresh', agents: ['Codex'], sessions: 2, indexed: false },
  ]);
  const calls = [];
  const pushes = [];
  const { runtime } = await fixture(t, {
    shell: {
      async run(command) {
        calls.push(command);
        return { exitCode: 0, output: `shell motd\n${BEGIN_MARKER}\n${scannedSnapshot}\n${END_MARKER}\n` };
      },
    },
    ui: {
      async post(view, message) {
        pushes.push({ view, message });
        return null;
      },
    },
  });

  // 先导入并置顶 Atlas，再触发扫描确认置顶保留且通过 ui.post 推送新数据
  await runtime.ui.onMessage('projects', { action: 'import', text: serialized });
  await runtime.ui.onMessage('projects', { action: 'pin', path: 'E:\\demo\\atlas', pinned: true });

  const scanTool = runtime.tools.find(({ name }) => name === 'folder_index_scan_agents');
  const searchTool = runtime.tools.find(({ name }) => name === 'folder_index_search');
  assert.equal(scanTool.requiresApproval, true);

  const res = await scanTool.execute({ args: { hubDir: 'E:\\索引; rm -rf /', includeUnindexed: true } });
  assert.equal(Boolean(res.isError), false);
  const summary = JSON.parse(res.content);
  assert.equal(summary.scanned, true);
  assert.equal(summary.total, 2);
  assert.equal(summary.indexedCount, 1);
  assert.equal(summary.unindexedCount, 1);
  assert.equal(summary.pinnedCount, 1);
  assert.deepEqual(summary.agents.sort(), ['Antigravity', 'Claude', 'Codex']);

  // 命令中不得直接出现未编码的恶意参数片段（走 Base64URL）
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('rm -rf'), '用户输入不应直接拼接进 shell 命令');
  assert.match(calls[0], /--req-b64 [A-Za-z0-9_-]+/);

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].view, 'projects');
  assert.equal(pushes[0].message.action, 'updated');
  assert.equal(pushes[0].message.projects.find((p) => p.name === 'Atlas').pinned, true);
  assert.equal(pushes[0].message.projects.find((p) => p.name === 'FreshRepo').indexed, false);

  // 搜索支持按 Agent 名匹配
  const foundByAgent = JSON.parse((await searchTool.execute({ args: { query: 'Antigravity' } })).content);
  assert.equal(foundByAgent.total, 1);
  assert.equal(foundByAgent.projects[0].name, 'Atlas');

  // 非法 hubDir 控制字符应直接报错
  const bad = await scanTool.execute({ args: { hubDir: 'E:\\bad\npath' } });
  assert.equal(bad.isError, true);
});

test('虚拟抽屉、归类覆写（重扫后保留）与主题/排序偏好持久化', async (t) => {
  const { host, runtime } = await fixture(t);
  const msg = (body) => runtime.ui.onMessage('projects', body);

  const initial = serializeSnapshot([
    { name: 'FreshApp', category: [], path: 'E:\\demo\\fresh-app', agents: ['Antigravity'], indexed: false },
  ]);
  await msg({ action: 'import', text: initial });

  const created = await msg({ action: 'createDrawer', parent: [], name: '研究' });
  assert.deepEqual(created.category, ['研究']);
  const createdSub = await msg({ action: 'createDrawer', parent: ['研究'], name: '论文' });
  assert.deepEqual(createdSub.category, ['研究', '论文']);

  const assigned = await msg({ action: 'assign', path: 'E:\\demo\\fresh-app', category: ['研究', '论文'] });
  assert.deepEqual(assigned.projects[0].category, ['研究', '论文']);
  assert.equal(assigned.projects[0].indexed, undefined, '归类后应转为已归类状态');

  const prefsRes = await msg({ action: 'setPrefs', theme: 'dark', sort: 'recent' });
  assert.deepEqual(prefsRes.prefs, { theme: 'dark', sort: 'recent' });

  // 模拟重开会话 + 重新导入原始快照：归类覆写、自定义抽屉和偏好应全部保留
  const reopened = await plugin.activate(host);
  await reopened.ui.onMessage('projects', { action: 'import', text: initial });
  const stateRes = await reopened.ui.onMessage('projects', { action: 'state' });
  assert.deepEqual(stateRes.projects[0].category, ['研究', '论文']);
  assert.deepEqual(stateRes.prefs, { theme: 'dark', sort: 'recent' });
  assert.ok(stateRes.drawers.some((d) => d.join('/') === '研究/论文'));

  // 拒绝非法抽屉名和超深层级
  await assert.rejects(msg({ action: 'createDrawer', parent: ['研究', '论文'], name: '三级' }), /两级/);
  await assert.rejects(msg({ action: 'createDrawer', parent: [], name: 'a/b' }), /不能包含斜杠/);
  await assert.rejects(msg({ action: 'setPrefs', theme: 'neon' }), /不支持的主题/);
});

test('扫描器丢弃网络共享、设备路径和相对路径，长路径前缀归到本机路径', () => {
  assert.equal(cleanPath('\\\\server.invalid\\share\\project'), '');
  assert.equal(cleanPath('//server.invalid/share/project'), '');
  assert.equal(cleanPath('\\\\?\\UNC\\server.invalid\\share\\project'), '');
  assert.equal(cleanPath('\\\\.\\pipe\\demo'), '');
  assert.equal(cleanPath('file://server.invalid/share/project'), '');
  assert.equal(cleanPath('relative\\project'), '');
  if (process.platform === 'win32') {
    assert.equal(cleanPath('\\\\?\\e:\\project\\'), 'E:\\project');
    assert.equal(cleanPath('file:///E:/project'), 'E:\\project');
  }
});

test('扫描命令同时适配 Git Bash 与 PowerShell', () => {
  const req = { hubDir: 'E:/索引' };
  const encoded = Buffer.from(JSON.stringify(req), 'utf8').toString('base64url');

  // 常规路径：正斜杠、不加引号，一条命令两种 shell 都能执行
  const plain = buildScanCommands(req, 'C:/Users/me/AppData/Local/Tianshu/node-runtime/win-x64/tianshu-runtime.exe', 'C:/Users/me/插件/scanner.mjs');
  assert.deepEqual(plain, [`C:/Users/me/AppData/Local/Tianshu/node-runtime/win-x64/tianshu-runtime.exe C:/Users/me/插件/scanner.mjs --req-b64 ${encoded}`]);

  // 路径带空格：先按 bash 写法，再按 PowerShell 的调用运算符写法
  const spaced = buildScanCommands(req, 'C:/Program Files/node.exe', 'C:/Users/me/scanner.mjs');
  assert.equal(spaced.length, 2);
  assert.equal(spaced[0], `"C:/Program Files/node.exe" "C:/Users/me/scanner.mjs" --req-b64 ${encoded}`);
  assert.equal(spaced[1], `& ${spaced[0]}`);

  // 会被 shell 解释的字符一律拒绝
  assert.throws(() => buildScanCommands(req, 'C:/node.exe', 'C:/a b/$(whoami)/scanner.mjs'), /特殊字符/);
  assert.throws(() => buildScanCommands(req, 'C:/node.exe', 'C:/a b/x";calc;"/scanner.mjs'), /特殊字符/);
});

test('扫描记住上次的索引目录，空字符串清除，不接受相对路径', async (t) => {
  const snapshot = serializeSnapshot([{ name: 'Atlas', category: [], path: 'E:/demo/atlas' }]);
  const requests = [];
  const { runtime } = await fixture(t, {
    shell: {
      async run(command) {
        const encoded = command.match(/--req-b64 ([A-Za-z0-9_-]+)/)[1];
        requests.push(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
        return { exitCode: 0, output: `${BEGIN_MARKER}\n${snapshot}\n${END_MARKER}\n` };
      },
    },
  });
  const scan = runtime.tools.find(({ name }) => name === 'folder_index_scan_agents');
  const prefs = async () => (await runtime.ui.onMessage('projects', { action: 'state' })).prefs;

  await scan.execute({ args: {} });
  assert.equal(requests.at(-1).hubDir, undefined, '没给过目录时不应猜默认位置');

  const hub = resolve('/demo-hub');
  await scan.execute({ args: { hubDir: hub } });
  assert.equal((await prefs()).hubDir, hub);
  await scan.execute({ args: {} });
  assert.equal(requests.at(-1).hubDir, hub);

  await runtime.ui.onMessage('projects', { action: 'setPrefs', theme: 'dark' });
  assert.equal((await prefs()).hubDir, hub, '改主题不应丢掉索引目录');

  await scan.execute({ args: { hubDir: '' } });
  assert.equal(requests.at(-1).hubDir, undefined);
  assert.equal((await prefs()).hubDir, undefined);

  const bad = await scan.execute({ args: { hubDir: 'relative/hub' } });
  assert.equal(bad.isError, true);
  assert.equal(requests.length, 4);
});
