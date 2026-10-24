const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Sync2 Tester',
      GIT_AUTHOR_EMAIL: 'tester@sync2.local',
      GIT_COMMITTER_NAME: 'Sync2 Tester',
      GIT_COMMITTER_EMAIL: 'tester@sync2.local'
    }
  });
}

function calculateFileHash(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function setupTestEnvironment() {
  const testRoot = path.join(os.tmpdir(), `sync2-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  fs.mkdirSync(testRoot, { recursive: true });

  const remoteRepoDir = path.join(testRoot, 'remote.git');
  const machineADir = path.join(testRoot, 'machine-a');
  const machineBDir = path.join(testRoot, 'machine-b');

  // 1. Tạo bare remote repo
  fs.mkdirSync(remoteRepoDir, { recursive: true });
  runGit(['init', '--bare', remoteRepoDir], testRoot);

  // 2. Clone về machine-a để tạo commit ban đầu
  runGit(['clone', remoteRepoDir, machineADir], testRoot);
  runGit(['config', 'user.name', 'Machine A'], machineADir);
  runGit(['config', 'user.email', 'machine-a@sync2.local'], machineADir);

  // Tạo file ban đầu
  fs.writeFileSync(path.join(machineADir, 'README.md'), '# Sync2 Test Project\nInitial content\n', 'utf8');

  // Tạo .gitignore trước khi tạo files protected
  fs.writeFileSync(path.join(machineADir, '.gitignore'), 'data/crawl/\nstorage/\n.sync-backups/\n', 'utf8');

  // Tạo dữ liệu crawl và storage (protected paths)
  const crawlDir = path.join(machineADir, 'data', 'crawl');
  fs.mkdirSync(crawlDir, { recursive: true });
  fs.writeFileSync(path.join(crawlDir, 'matches.json'), JSON.stringify({ matches: [1, 2, 3] }, null, 2), 'utf8');

  const storageDir = path.join(machineADir, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'user-cache.dat'), 'user sensitive crawl cache data', 'utf8');

  runGit(['checkout', '-B', 'main'], machineADir);
  runGit(['add', 'README.md', '.gitignore'], machineADir);
  runGit(['commit', '-m', 'Initial commit on main'], machineADir);
  runGit(['push', '-u', 'origin', 'main'], machineADir);

  // Đặt HEAD của remote trỏ tới refs/heads/main
  runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], remoteRepoDir);

  // 3. Clone về machine-b
  runGit(['clone', remoteRepoDir, machineBDir], testRoot);
  runGit(['config', 'user.name', 'Machine B'], machineBDir);
  runGit(['config', 'user.email', 'machine-b@sync2.local'], machineBDir);

  // Tạo protected files trên machine-b độc lập
  const crawlDirB = path.join(machineBDir, 'data', 'crawl');
  fs.mkdirSync(crawlDirB, { recursive: true });
  fs.writeFileSync(path.join(crawlDirB, 'matches.json'), JSON.stringify({ matches: [1, 2, 3] }, null, 2), 'utf8');

  const storageDirB = path.join(machineBDir, 'storage');
  fs.mkdirSync(storageDirB, { recursive: true });
  fs.writeFileSync(path.join(storageDirB, 'user-cache.dat'), 'user sensitive crawl cache data', 'utf8');

  return {
    testRoot,
    remoteRepoDir,
    machineADir,
    machineBDir,
    cleanup: () => {
      try {
        fs.rmSync(testRoot, { recursive: true, force: true });
      } catch {
        // bỏ qua nếu bị lock tạm thời
      }
    }
  };
}

module.exports = {
  setupTestEnvironment,
  calculateFileHash,
  runGit
};
