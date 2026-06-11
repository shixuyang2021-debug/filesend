const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// 基础配置
// =========================

// 文件最大上传限制：建议 Railway 上先别太大
const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

// 普通文件保存时间：10分钟
const MAX_FILE_AGE = 10 * 60 * 1000;

// 私密文件保存时间：10分钟，下载一次后立即删除
const MAX_PRIVATE_FILE_AGE = 10 * 60 * 1000;

// 上传中断的 .uploading 半成品文件保留时间：3分钟
const MAX_UPLOADING_AGE = 3 * 60 * 1000;

// 清理任务执行间隔：1分钟
const CLEANUP_INTERVAL = 60 * 1000;

// 存储目录
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 内存房间存储
// 注意：Railway 重启后 Map 会清空，uploads 里的文件会变成孤儿文件，由定时任务清理
const rooms = new Map();

// =========================
// 工具函数
// =========================

function safeDeleteFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch (err) {
    console.error('[删除文件失败]', filePath, err);
  }
  return false;
}

function encodeRFC5987ValueChars(str) {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
}

function getSafeFileName(fileName) {
  const baseName = path.basename(fileName || 'download');
  const ext = path.extname(baseName);

  return {
    originalName: baseName,
    fallbackName: 'download' + (ext || '')
  };
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

// 取件码生成，5位
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  let id;

  do {
    id = '';
    for (let i = 0; i < 5; i++) {
      id += CHARS[Math.floor(Math.random() * CHARS.length)];
    }
  } while (rooms.has(id));

  return id;
}

// 设置下载响应头
function setDownloadHeaders(res, room, fileSize, contentLength, isPartial, start, end) {
  const { originalName, fallbackName } = getSafeFileName(room.fileName);
  const encodedName = encodeRFC5987ValueChars(originalName);

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
  );
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', contentLength);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (isPartial) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  } else {
    res.status(200);
  }
}

function removeRoomAndFile(code, reason) {
  const room = rooms.get(code);

  if (!room) return;

  safeDeleteFile(room.filePath);
  rooms.delete(code);

  console.log(`[删除] ${code} - ${room.fileName} - ${reason}`);
}

// =========================
// Multer 配置
// =========================

// 上传中的文件先用 .uploading 后缀
// 上传成功后再 rename 成正式文件
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, crypto.randomUUID() + ext + '.uploading');
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_SIZE
  }
});

// =========================
// 静态文件
// =========================

app.use(express.static(path.join(__dirname, 'public')));

// =========================
// API：上传文件
// =========================

app.post('/api/upload', (req, res) => {
  let aborted = false;

  req.on('aborted', () => {
    aborted = true;
    console.log('[上传中断] 客户端断开连接');
  });

  upload.single('file')(req, res, (err) => {
    // multer 出错，比如文件过大、网络中断
    if (err) {
      if (req.file && req.file.path) {
        safeDeleteFile(req.file.path);
      }

      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: '文件太大，超过服务器限制'
        });
      }

      console.error('[上传失败]', err);
      return res.status(500).json({
        error: '上传失败'
      });
    }

    // 请求已经中断，删除半成品文件
    if (aborted) {
      if (req.file && req.file.path) {
        safeDeleteFile(req.file.path);
      }
      return;
    }

    if (!req.file) {
      return res.status(400).json({
        error: '未选择文件'
      });
    }

    const tempPath = req.file.path;
    const finalPath = tempPath.replace(/\.uploading$/, '');

    // 前端传 mode=private 表示私密传输
    const modeFromClient = (req.body.mode || 'normal').toLowerCase();
    const mode = modeFromClient === 'private' ? 'private' : 'normal';

    try {
      fs.renameSync(tempPath, finalPath);
    } catch (renameErr) {
      console.error('[文件改名失败]', renameErr);
      safeDeleteFile(tempPath);

      return res.status(500).json({
        error: '文件保存失败'
      });
    }

    const code = generateCode();

    rooms.set(code, {
      code,
      mode,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      filePath: finalPath,
      createdAt: Date.now(),
      downloading: false,
      downloaded: false
    });

    console.log(
      `[上传完成] ${code} - ${mode} - ${req.file.originalname} (${fmtMB(req.file.size)} MB)`
    );

    res.json({
      code,
      mode,
      name: req.file.originalname,
      size: req.file.size
    });
  });
});

// =========================
// API：查询取件码
// =========================

app.get('/api/room/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room || !fs.existsSync(room.filePath)) {
    if (room) {
      rooms.delete(code);
    }

    return res.status(404).json({
      error: '取件码无效或已过期'
    });
  }

  // 私密传输已经被锁定/下载过，则不可再查询
  if (room.mode === 'private' && (room.downloading || room.downloaded)) {
    return res.status(410).json({
      error: '私密文件已被读取或正在读取'
    });
  }

  res.json({
    name: room.fileName,
    size: room.fileSize,
    mode: room.mode,
    createdAt: room.createdAt
  });
});

// =========================
// API：下载文件
// 普通模式：可多次下载，直到过期
// 私密模式：阅后即焚，只允许下载一次，下载完成后立即删除
// =========================

app.get('/api/download/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room || !fs.existsSync(room.filePath)) {
    if (room) {
      rooms.delete(code);
    }

    return res.status(404).send('取件码无效或已过期');
  }

  // 私密模式：一旦开始下载，就锁定，防止多端重复下载
  if (room.mode === 'private') {
    if (room.downloading || room.downloaded) {
      return res.status(410).send('私密文件已被读取或正在读取');
    }

    room.downloading = true;
    rooms.set(code, room);
  }

  const filePath = room.filePath;
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  console.log(
    `[下载请求] ${code} - ${room.mode} - ${room.fileName} - Range: ${range || 'none'}`
  );

  let stream;
  let finished = false;

  function afterDownloadComplete() {
    if (finished) return;
    finished = true;

    if (room.mode === 'private') {
      room.downloaded = true;
      removeRoomAndFile(code, '私密传输下载完成，阅后即焚');
    } else {
      console.log(`[下载响应完成] ${code} - ${room.fileName}`);
    }
  }

  function afterDownloadAbort() {
    if (finished) return;
    finished = true;

    // 私密传输如果下载中断，保守处理：直接删除
    // 这样保密性更强，避免同一个私密码反复尝试
    if (room.mode === 'private') {
      room.downloaded = true;
      removeRoomAndFile(code, '私密传输下载中断，已销毁');
    } else {
      console.log(`[下载中断] ${code} - ${room.fileName}`);
    }
  }

  res.on('finish', afterDownloadComplete);
  res.on('close', () => {
    // close 可能在 finish 后触发，所以用 finished 防重复
    if (!res.writableEnded) {
      afterDownloadAbort();
    }
  });

  // Range 分段下载
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (Number.isNaN(start) || start < 0) {
      start = 0;
    }

    if (Number.isNaN(end) || end >= fileSize) {
      end = fileSize - 1;
    }

    if (start > end || start >= fileSize) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    const contentLength = end - start + 1;

    setDownloadHeaders(res, room, fileSize, contentLength, true, start, end);

    stream = fs.createReadStream(filePath, { start, end });

    stream.on('error', (err) => {
      console.error('[下载失败]', err);
      if (!res.headersSent) {
        res.status(500).send('下载失败');
      } else {
        res.destroy(err);
      }
    });

    stream.pipe(res);
    return;
  }

  // 普通整文件下载
  setDownloadHeaders(res, room, fileSize, fileSize, false, 0, fileSize - 1);

  stream = fs.createReadStream(filePath);

  stream.on('error', (err) => {
    console.error('[下载失败]', err);
    if (!res.headersSent) {
      res.status(500).send('下载失败');
    } else {
      res.destroy(err);
    }
  });

  stream.pipe(res);
});

// =========================
// API：管理员查看当前文件，可选
// 需要 Railway Variables 里配置 ADMIN_TOKEN
// 访问：/api/admin/files?token=你的token
// =========================

app.get('/api/admin/files', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    return res.status(403).json({
      error: '未配置 ADMIN_TOKEN'
    });
  }

  if (req.query.token !== adminToken) {
    return res.status(403).json({
      error: '无权限'
    });
  }

  const list = [];

  for (const [code, room] of rooms) {
    list.push({
      code,
      mode: room.mode,
      fileName: room.fileName,
      fileSize: room.fileSize,
      filePath: room.filePath,
      createdAt: new Date(room.createdAt).toLocaleString(),
      downloading: room.downloading,
      downloaded: room.downloaded
    });
  }

  res.json(list);
});

// =========================
// 定时清理
// =========================

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  // 1. 清理 rooms 中的过期文件
  for (const [code, room] of rooms) {
    const maxAge = room.mode === 'private' ? MAX_PRIVATE_FILE_AGE : MAX_FILE_AGE;

    if (now - room.createdAt > maxAge) {
      if (fs.existsSync(room.filePath)) {
        safeDeleteFile(room.filePath);
      }

      rooms.delete(code);
      cleaned++;

      console.log(`[清理过期文件] ${code} - ${room.mode} - ${room.fileName}`);
    }
  }

  // 2. 扫描 uploads，清理上传中断文件和孤儿文件
  if (fs.existsSync(UPLOAD_DIR)) {
    const uploadFiles = fs.readdirSync(UPLOAD_DIR);

    for (const file of uploadFiles) {
      const filePath = path.join(UPLOAD_DIR, file);

      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;

        const isUploadingFile = file.endsWith('.uploading');
        const isReferenced = Array.from(rooms.values()).some(
          room => room.filePath === filePath
        );

        // 上传中断的半成品文件：3分钟后删除
        if (isUploadingFile && now - stat.mtimeMs > MAX_UPLOADING_AGE) {
          fs.unlinkSync(filePath);
          cleaned++;
          console.log(`[清理上传中断文件] ${file}`);
          continue;
        }

        // 孤儿文件：不在 rooms 记录里，且超过普通文件保存时间，删除
        if (!isReferenced && now - stat.mtimeMs > MAX_FILE_AGE) {
          fs.unlinkSync(filePath);
          cleaned++;
          console.log(`[清理孤儿文件] ${file}`);
        }
      } catch (err) {
        console.error('[清理文件失败]', filePath, err);
      }
    }
  }

  if (cleaned > 0) {
    console.log(`[清理] 已清理 ${cleaned} 个文件`);
  }
}, CLEANUP_INTERVAL);

// =========================
// 全局错误处理
// =========================

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: '文件太大，超过服务器限制'
    });
  }

  console.error('[服务器错误]', err);
  res.status(500).json({
    error: '服务器错误'
  });
});

// =========================
// 启动服务
// =========================

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n  文件快传服务已启动');
  console.log(`  端口: ${PORT}`);
  console.log(`  文件保存时间: ${MAX_FILE_AGE / 60 / 1000} 分钟`);
  console.log(`  私密文件保存时间: ${MAX_PRIVATE_FILE_AGE / 60 / 1000} 分钟`);
  console.log(`  上传中断文件清理时间: ${MAX_UPLOADING_AGE / 60 / 1000} 分钟`);
  console.log(`  地址: http://localhost:${PORT}\n`);
});
