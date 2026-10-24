const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { defaultLogger, sanitize } = require('./logger');

class SftpTransport {
  constructor(options = {}) {
    // No built-in defaults: the server, user and key come from the project config or SYNC2_SFTP_* environment variables.
    this.host = options.host || process.env.SYNC2_SFTP_HOST || '';
    this.port = options.port || Number(process.env.SYNC2_SFTP_PORT) || 22;
    this.username = options.username || process.env.SYNC2_SFTP_USER || '';
    this.privateKeyPath = options.privateKeyPath || process.env.SYNC2_SFTP_KEY || '';
    this.privateKeyContent = options.privateKeyContent || null;
    this.logger = options.logger || defaultLogger;
  }

  getPrivateKey() {
    if (this.privateKeyContent) {
      return this.privateKeyContent;
    }
    if (this.privateKeyPath && fs.existsSync(this.privateKeyPath)) {
      return fs.readFileSync(this.privateKeyPath, 'utf8');
    }
    return null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.host || !this.username) {
        return reject(new Error('SFTP chưa được cấu hình: đặt host và username trong .sync2/config.json hoặc biến SYNC2_SFTP_HOST / SYNC2_SFTP_USER.'));
      }
      const privateKey = this.getPrivateKey();
      if (!privateKey) {
        return reject(new Error(`Không tìm thấy SSH private key tại: ${this.privateKeyPath}. Vui lòng chỉ định đường dẫn khoá hợp lệ!`));
      }

      const conn = new Client();
      let isDone = false;

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(new Error(`Lỗi khởi tạo phiên SFTP: ${err.message}`));
          }
          isDone = true;
          resolve({ conn, sftp });
        });
      });

      conn.on('error', (err) => {
        if (!isDone) {
          isDone = true;
          reject(new Error(`Lỗi kết nối tới Trạm SFTP (${this.host}): ${sanitize(err.message)}`));
        }
      });

      try {
        conn.connect({
          host: this.host,
          port: this.port,
          username: this.username,
          privateKey,
          readyTimeout: 20000
        });
      } catch (err) {
        reject(new Error(`Không thể khởi tạo SSH: ${err.message}`));
      }
    });
  }

  async ensureRemoteDir(sftp, remoteDir) {
    return new Promise((resolve, reject) => {
      const parts = remoteDir.split('/').filter(Boolean);
      let current = '';

      const mkdirNext = (index) => {
        if (index >= parts.length) return resolve();
        current += '/' + parts[index];
        sftp.stat(current, (statErr) => {
          if (statErr) {
            sftp.mkdir(current, (mkdirErr) => {
              if (mkdirErr && mkdirErr.code !== 4) { // 4: failure / already exists
                return reject(mkdirErr);
              }
              mkdirNext(index + 1);
            });
          } else {
            mkdirNext(index + 1);
          }
        });
      };

      mkdirNext(0);
    });
  }

  async uploadPack(localPackPath, projectId, fromMachine) {
    const { conn, sftp } = await this.connect();
    try {
      const remoteDir = `/srv/sync2/${projectId}`;
      await this.ensureRemoteDir(sftp, remoteDir);

      const remoteFilename = `pack_${fromMachine}_${Date.now()}.sync2pack`;
      const remoteFilePath = `${remoteDir}/${remoteFilename}`;
      const latestPointerPath = `${remoteDir}/latest_${fromMachine}.sync2pack`;

      this.logger.info(`Đang đẩy gói lên trạm SFTP: ${remoteFilePath}`);

      await new Promise((resolve, reject) => {
        sftp.fastPut(localPackPath, remoteFilePath, (err) => {
          if (err) return reject(err);
          // Cập nhật file latest pointer
          sftp.fastPut(localPackPath, latestPointerPath, (err2) => {
            if (err2) return reject(err2);
            resolve();
          });
        });
      });

      return {
        success: true,
        remoteFilePath,
        remoteFilename
      };
    } finally {
      conn.end();
    }
  }

  async downloadLatestPack(projectId, otherMachine, localSavePath) {
    const { conn, sftp } = await this.connect();
    try {
      const remoteDir = `/srv/sync2/${projectId}`;
      const latestPointerPath = `${remoteDir}/latest_${otherMachine}.sync2pack`;

      this.logger.info(`Đang tải gói từ trạm SFTP: ${latestPointerPath}`);

      await new Promise((resolve, reject) => {
        sftp.fastGet(latestPointerPath, localSavePath, (err) => {
          if (err) {
            return reject(new Error(`Không tìm thấy gói của máy "${otherMachine}" trên trạm (${err.message})`));
          }
          resolve();
        });
      });

      return {
        success: true,
        localSavePath
      };
    } finally {
      conn.end();
    }
  }
}

module.exports = {
  SftpTransport
};
