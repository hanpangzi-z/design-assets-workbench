const path = require('node:path');

const releaseRoot = path.resolve(process.env.BENLAI_RELEASE_DIR || __dirname);

module.exports = {
  apps: [{
    name: process.env.BENLAI_PM2_NAME || 'benlai-design',
    cwd: path.join(releaseRoot, 'server'),
    script: path.join(releaseRoot, 'server', 'dist', 'app.js'),
    interpreter: process.env.BENLAI_NODE_BINARY || process.execPath,
    exec_mode: 'fork',
    instances: 1,
    kill_timeout: 10_000,
    max_memory_restart: '2G',
    time: true,
    env: {
      NODE_ENV: 'production',
      HOST: process.env.HOST || '127.0.0.1',
      PORT: process.env.PORT || '3088',
      PARSE_MAX_CONCURRENT: '1',
      DISABLE_BOOTSTRAP_PARSE: process.env.DISABLE_BOOTSTRAP_PARSE || '0',
      DISABLE_BOOTSTRAP_STALE_PARSE: process.env.DISABLE_BOOTSTRAP_STALE_PARSE || '1',
      DISABLE_BOOTSTRAP_TRANSFER_RECOVERY: process.env.DISABLE_BOOTSTRAP_TRANSFER_RECOVERY || '0',
    },
  }],
};
