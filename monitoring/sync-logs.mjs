import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SRC_DIR = path.join(REPO_ROOT, 'monitoring', 'data', 'logs');
const WORKTREE_DIR = path.join(REPO_ROOT, '.worktrees', 'logs');
const DEST_ROOT = path.join(WORKTREE_DIR, 'logs', 'monitoring');

function run(cmd, args, { cwd = REPO_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${err || out}`));
    });
  });
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorktree() {
  await fs.mkdir(path.dirname(WORKTREE_DIR), { recursive: true });

  if (await exists(WORKTREE_DIR)) {
    // Ensure it's on logs branch.
    await run('git', ['-C', WORKTREE_DIR, 'checkout', 'logs']);
    return;
  }

  // Create the worktree. If logs branch doesn't exist, create it.
  let hasRemote = true;
  try {
    await run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/logs']);
  } catch {
    hasRemote = false;
  }

  if (hasRemote) {
    await run('git', ['worktree', 'add', WORKTREE_DIR, 'logs']);
  } else {
    // Create orphan logs branch in a new worktree.
    await run('git', ['worktree', 'add', WORKTREE_DIR, 'main']);
    await run('git', ['-C', WORKTREE_DIR, 'checkout', '--orphan', 'logs']);
    // Start with empty tree.
    await run('git', ['-C', WORKTREE_DIR, 'rm', '-rf', '.'], { cwd: REPO_ROOT }).catch(() => {});
    await run('git', ['-C', WORKTREE_DIR, 'commit', '--allow-empty', '-m', 'Initialize logs branch']);
    await run('git', ['-C', WORKTREE_DIR, 'push', '-u', 'origin', 'logs']);
  }
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const sp = path.join(src, e.name);
    const dp = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(sp, dp);
    else if (e.isFile()) await fs.copyFile(sp, dp);
  }
}

async function main() {
  if (!(await exists(SRC_DIR))) {
    console.log('No local logs dir yet, nothing to sync:', SRC_DIR);
    return;
  }

  await ensureWorktree();

  // Copy local ndjson logs into logs branch under logs/monitoring/...
  await copyDir(SRC_DIR, DEST_ROOT);

  await run('git', ['-C', WORKTREE_DIR, 'add', 'logs/monitoring']);

  // If nothing to commit, exit.
  const { out: status } = await run('git', ['-C', WORKTREE_DIR, 'status', '--porcelain']);
  if (!status.trim()) {
    console.log('No changes to sync');
    return;
  }

  const ts = new Date().toISOString();
  await run('git', ['-C', WORKTREE_DIR, 'commit', '-m', `logs: ${ts}`]);
  await run('git', ['-C', WORKTREE_DIR, 'push', 'origin', 'logs']);
  console.log('Synced logs to origin/logs at', ts);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exitCode = 1;
});
