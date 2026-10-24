const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PRESETS = {
  'electron-node': {
    protect: [
      'data/crawl/**',
      'storage/**',
      'node_modules/**',
      'dist/**',
      'release/**',
      'legacy/**',
      '.sync-backups/**'
    ],
    neverCommit: [
      '.env*',
      '*.pem',
      '*.key',
      'storage/**',
      'data/crawl/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      '.sync-backups/**'
    ]
  },
  'python': {
    protect: [
      'data/**',
      'storage/**',
      'venv/**',
      '.venv/**',
      '__pycache__/**',
      '*.sqlite',
      '*.db'
    ],
    neverCommit: [
      '.env*',
      '*.pem',
      '*.key',
      'venv/**',
      '.venv/**',
      '__pycache__/**',
      '*.pyc',
      'storage/**',
      'data/**'
    ]
  },
  'general': {
    protect: [
      'storage/**',
      'backup/**',
      '.sync-backups/**'
    ],
    neverCommit: [
      '.env*',
      '*.pem',
      '*.key',
      'storage/**'
    ]
  }
};

class ConfigManager {
  constructor(customConfigPath = null) {
    if (customConfigPath) {
      this.configPath = customConfigPath;
    } else {
      // Ưu tiên sync2.config.json trong thư mục ứng dụng hoặc cwd
      const appRootConfig = path.join(__dirname, '..', '..', 'sync2.config.json');
      this.configPath = appRootConfig;
    }
  }

  getDefaultMachineName() {
    return os.hostname() || 'May-A';
  }

  loadConfig() {
    if (!fs.existsSync(this.configPath)) {
      const initialConfig = {
        currentMachine: this.getDefaultMachineName(),
        dryRunDefault: true,
        theme: 'dark',
        projects: []
      };
      this.saveConfig(initialConfig);
      return initialConfig;
    }

    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed.currentMachine) parsed.currentMachine = this.getDefaultMachineName();
      if (!Array.isArray(parsed.projects)) parsed.projects = [];
      if (parsed.dryRunDefault === undefined) parsed.dryRunDefault = true;
      if (!parsed.theme) parsed.theme = 'dark';
      return parsed;
    } catch {
      return {
        currentMachine: this.getDefaultMachineName(),
        dryRunDefault: true,
        theme: 'dark',
        projects: []
      };
    }
  }

  saveConfig(config) {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  getProject(nameOrPath) {
    const config = this.loadConfig();
    return config.projects.find(p => p.name === nameOrPath || path.resolve(p.path) === path.resolve(nameOrPath));
  }

  addProject(projectData) {
    const config = this.loadConfig();
    const existingIndex = config.projects.findIndex(p => p.name === projectData.name);

    const preset = DEFAULT_PRESETS[projectData.projectType || 'electron-node'] || DEFAULT_PRESETS['electron-node'];
    const project = {
      name: projectData.name,
      path: projectData.path,
      remote: projectData.remote || 'origin',
      branch: projectData.branch || 'main',
      projectType: projectData.projectType || 'electron-node',
      protect: Array.from(new Set([...(preset.protect || []), ...(projectData.protect || [])])),
      neverCommit: Array.from(new Set([...(preset.neverCommit || []), ...(projectData.neverCommit || [])]))
    };

    if (existingIndex >= 0) {
      config.projects[existingIndex] = project;
    } else {
      config.projects.push(project);
    }

    this.saveConfig(config);
    return project;
  }

  removeProject(name) {
    const config = this.loadConfig();
    config.projects = config.projects.filter(p => p.name !== name);
    this.saveConfig(config);
  }

  updateMachineName(machineName) {
    const config = this.loadConfig();
    config.currentMachine = machineName;
    this.saveConfig(config);
  }

  updateDryRunDefault(value) {
    const config = this.loadConfig();
    config.dryRunDefault = Boolean(value);
    this.saveConfig(config);
  }
}

module.exports = {
  ConfigManager,
  DEFAULT_PRESETS
};
