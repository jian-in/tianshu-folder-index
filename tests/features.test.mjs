// 项目画像（技术栈、Git 分支）、项目备注、最近项目与上次扫描时间。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSnapshot, searchProjects, serializeSnapshot } from '../plugin/catalog.mjs';
import { profileProject } from '../plugin/scanner.mjs';

globalThis.__tianshuTPI = { version: '2.0', defineTianshuPlugin: (spec) => spec };
const { default: plugin } = await import('../plugin/index.mjs');
delete globalThis.__tianshuTPI;

const DAY = 86_400_000;

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t, projects) {
  const dataDir = await tempDir(t, 'folder-index-features-');
  const pushes = [];
  const runtime = await plugin.activate({
    storage: { dataDir: async () => dataDir },
    ui: { async post(view, message) { pushes.push({ view, message }); return null; } },
  });
  const message = (body) => runtime.ui.onMessage('projects', body);
  await message({ action: 'import', text: serializeSnapshot(projects) });
  const tool = (name) => async (args) => {
    const res = await runtime.tools.find((x) => x.name === name).execute({ args });
    return { ...res, data: res.isError ? null : JSON.parse(res.content) };
  };
  return { runtime, message, pushes, tool, dataDir };
}

test('项目画像：按根目录文件名识别技术栈，读 .git/HEAD 得到分支，worktree 跟着 gitdir 找', async (t) => {
  const root = await tempDir(t, 'folder-index-profile-');
  const app = join(root, 'app');
  await mkdir(join(app, '.git'), { recursive: true });
  await writeFile(join(app, 'package.json'), '{}');
  await writeFile(join(app, 'tsconfig.json'), '{}');
  await writeFile(join(app, 'Cargo.toml'), '');
  await writeFile(join(app, 'Tool.csproj'), '');
  await writeFile(join(app, '.git', 'HEAD'), 'ref: refs/heads/feat/profile\n');
  assert.deepEqual(await profileProject(app), { stack: ['Node', 'TypeScript', 'Rust', '.NET'], branch: 'feat/profile' });

  // worktree：.git 是指向别处的文件
  const wt = join(root, 'wt');
  const wtGit = join(root, 'app', '.git', 'worktrees', 'wt');
  await mkdir(wt);
  await mkdir(wtGit, { recursive: true });
  await writeFile(join(wtGit, 'HEAD'), 'ref: refs/heads/hotfix\n');
  await writeFile(join(wt, '.git'), `gitdir: ${wtGit}\n`);
  assert.deepEqual(await profileProject(wt), { branch: 'hotfix' });

  // 分离 HEAD、gitdir 指向网络共享、目录不存在
  const detached = join(root, 'detached');
  await mkdir(join(detached, '.git'), { recursive: true });
  await writeFile(join(detached, '.git', 'HEAD'), `${'a1b2c3d4e5'.repeat(4)}\n`);
  assert.deepEqual(await profileProject(detached), { branch: 'detached@a1b2c3d' });
  const unc = join(root, 'unc');
  await mkdir(unc);
  await writeFile(join(unc, '.git'), 'gitdir: \\\\server.invalid\\share\\repo.git\n');
  assert.deepEqual(await profileProject(unc), {});
  assert.deepEqual(await profileProject(join(root, 'missing')), {});
});

test('快照保留技术栈和分支，搜索能按技术栈、分支和备注命中', () => {
  const [project] = parseSnapshot(serializeSnapshot([
    { name: 'Atlas', category: [], path: 'E:/atlas', stack: ['Rust', 'Rust', 'Node'], branch: 'feat/x' },
  ])).projects;
  assert.deepEqual(project.stack, ['Rust', 'Node']);
  assert.equal(project.branch, 'feat/x');
  assert.throws(() => serializeSnapshot([{ name: 'A', category: [], path: 'E:/a', branch: 'x\ny' }]), /Git 分支/);

  const withNote = { ...project, note: { text: '发布前跑 npm test', by: 'user', updatedAt: 1 } };
  assert.equal(searchProjects([withNote], 'rust').length, 1);
  assert.equal(searchProjects([withNote], 'feat/x').length, 1);
  assert.equal(searchProjects([withNote], 'npm test').length, 1);
  assert.equal(searchProjects([withNote], 'python').length, 0);
});

test('备注：面板和 Agent 都能写，重新导入后保留，同名项目要求用路径，空字符串删除', async (t) => {
  const { message, tool, pushes } = await fixture(t, [
    { name: 'Atlas', category: [], path: 'E:/a/atlas' },
    { name: 'Atlas', category: [], path: 'E:/b/atlas' },
    { name: 'Notes', category: [], path: 'E:/notes' },
  ]);
  const note = tool('folder_index_note');

  const saved = await message({ action: 'setNote', path: 'E:/notes', text: '  周五前整理完  ' });
  assert.equal(saved.note.text, '周五前整理完');
  assert.equal(saved.note.by, 'user');

  const byName = await note({ project: 'notes', note: '下一步：补索引' });
  assert.equal(byName.data.path, 'E:/notes');
  assert.equal(pushes.at(-1).message.projects.find((p) => p.path === 'E:/notes').note.by, 'agent');

  const ambiguous = await note({ project: 'Atlas', note: 'x' });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content, /2 个同名项目.*E:\/a\/atlas/);
  assert.equal((await note({ project: 'E:/b/atlas', note: '用这个' })).data.note, '用这个');
  assert.equal((await note({ project: 'missing', note: 'x' })).isError, true);
  assert.equal((await note({ project: 'Notes', note: 'x'.repeat(501) })).isError, true);

  // 重新导入（扫描结果覆盖 projects.json）后备注仍在，搜索能带出来
  await message({ action: 'import', text: serializeSnapshot([{ name: 'Notes', category: [], path: 'E:/notes' }]) });
  const search = await tool('folder_index_search')({ query: '补索引' });
  assert.equal(search.data.projects[0].note.text, '下一步：补索引');

  assert.equal((await note({ project: 'Notes', note: '' })).data.note, null);
  const { projects } = await message({ action: 'state' });
  assert.equal(projects[0].note, undefined);
});

test('最近项目按活跃时间倒序，可按天数过滤，并报告上次扫描时间', async (t) => {
  const now = Date.now();
  const { tool, message, dataDir } = await fixture(t, [
    { name: 'Old', category: [], path: 'E:/old', lastActive: now - 40 * DAY },
    { name: 'Fresh', category: [], path: 'E:/fresh', lastActive: now - DAY, stack: ['Go'], branch: 'main' },
    { name: 'Never', category: [], path: 'E:/never' },
    { name: 'Mid', category: [], path: 'E:/mid', lastActive: now - 5 * DAY },
  ]);
  const recent = tool('folder_index_recent');

  const all = await recent({});
  assert.deepEqual(all.data.projects.map((p) => p.name), ['Fresh', 'Mid', 'Old']);
  assert.equal(all.data.projects[0].branch, 'main');
  assert.match(all.data.projects[0].lastActive, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(all.data.lastScan.source, 'paste');
  assert.equal(all.data.lastScan.stale, false);
  assert.equal(all.data.hint, undefined);

  assert.deepEqual((await recent({ days: 7, limit: 1 })).data.projects.map((p) => p.name), ['Fresh']);
  assert.equal((await recent({ limit: 0 })).isError, true);
  assert.equal((await recent({ days: 400 })).isError, true);

  // 上次导入超过 7 天：面板状态和工具都提示重新扫描
  await writeFile(join(dataDir, 'meta.json'), JSON.stringify({ lastImport: { at: now - 9 * DAY, source: 'scan' } }));
  const stale = await recent({});
  assert.equal(stale.data.lastScan.stale, true);
  assert.match(stale.data.hint, /重新扫描/);
  assert.equal((await message({ action: 'state' })).lastImport.stale, true);
});
