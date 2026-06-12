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

// 最大上传限制：2GB
const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024;

// 普通文件保存时间：10分钟
const MAX_FILE_AGE = 10 * 60 * 1000;

// 私密文件保存时间：10分钟；但被领取后会进入私密票据逻辑
const MAX_PRIVATE_FILE_AGE = 10 * 60 * 1000;

// 私密下载票据有效期：5分钟
const PRIVATE_TICKET_AGE = 5 * 60 * 1000;

// 上传中断的 .uploading 半成品文件保留时间：3分钟
const MAX_UPLOADING_AGE = 3 * 60 * 1000;

// 清理任务执行间隔：1分钟
const CLEANUP_INTERVAL = 60 * 1000;

// 存储目录
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 取件码记录
const rooms = new Map();

// 私密下载票据记录
const privateTickets = new Map();

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

function setDownloadHeaders(res, fileInfo, fileSize, contentLength, isPartial, start, end) {
  const { originalName, fallbackName } = getSafeFileName(fileInfo.fileName);
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

/**
 * 通用文件发送函数
 * 支持：
 * 1. GET 下载
 * 2. HEAD 探测
 * 3. Range 分段下载
 */
function sendFileWithRange(req, res, fileInfo, onFullDownloadComplete) {
  const filePath = fileInfo.filePath;

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('文件不存在或已过期');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  let start = 0;
  let end = fileSize - 1;
  let isPartial = false;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const rangeStart = parseInt(parts[0], 10);
    const rangeEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (!Number.isNaN(rangeStart) && rangeStart >= 0) {
      start = rangeStart;
    }

    if (!Number.isNaN(rangeEnd) && rangeEnd < fileSize) {
      end = rangeEnd;
    }

    if (start > end || start >= fileSize) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.end();
    }

    isPartial = true;
  }

  const contentLength = end - start + 1;

  setDownloadHeaders(
    res,
    fileInfo,
    fileSize,
    contentLength,
    isPartial,
    start,
    end
  );

  if (req.method === 'HEAD') {
    return res.end();
  }

  const stream = fs.createReadStream(filePath, { start, end });

  let streamEnded = false;

  stream.on('end', () => {
    streamEnded = true;
  });

  stream.on('error', (err) => {
    console.error('[下载失败]', err);

    if (!res.headersSent) {
      res.status(500).send('下载失败');
    } else {
      res.destroy(err);
    }
  });

  res.on('finish', () => {
    const isFullFileResponse = start === 0 && end === fileSize - 1;

    console.log(
      `[下载响应完成] ${fileInfo.code || fileInfo.ticket || '-'} - ${fileInfo.fileName} - ${start}-${end}/${fileSize}`
    );

    if (
      streamEnded &&
      isFullFileResponse &&
      typeof onFullDownloadComplete === 'function'
    ) {
      onFullDownloadComplete();
    }
  });

  res.on('close', () => {
    if (!streamEnded) {
      console.log(
        `[下载连接关闭] ${fileInfo.code || fileInfo.ticket || '-'} - ${fileInfo.fileName} - ${start}-${end}/${fileSize}`
      );
    }
  });

  stream.pipe(res);
}

// =========================
// Multer 配置
// =========================

// 上传中的文件先用 .uploading 后缀
// 上传成功后再改成正式文件名
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
// mode=normal 普通传输
// mode=private 私密传输
// =========================

app.post('/api/upload', (req, res) => {
  let aborted = false;

  req.on('aborted', () => {
    aborted = true;
    console.log('[上传中断] 客户端断开连接');
  });

  upload.single('file')(req, res, (err) => {
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

      // 私密传输状态
      claimed: false,
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

  if (room.mode === 'private' && (room.claimed || room.downloaded)) {
    return res.status(410).json({
      error: '私密文件已被领取或已读取'
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
// API：下载入口
// 普通传输：直接下载
// 私密传输：取件码只换一次私密下载票据
// =========================

app.head('/api/download/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room || !fs.existsSync(room.filePath)) {
    return res.status(404).end();
  }

  // HEAD 只是让浏览器探测文件大小，不触发阅后即焚
  return sendFileWithRange(req, res, room, null);
});

app.get('/api/download/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room || !fs.existsSync(room.filePath)) {
    if (room) {
      rooms.delete(code);
    }

    return res.status(404).send('取件码无效或已过期');
  }

  // 普通传输：直接下载，可重复下载，直到过期
  if (room.mode !== 'private') {
    return sendFileWithRange(req, res, room, null);
  }

  // 私密传输：取件码只允许领取一次下载票据
  if (room.claimed || room.downloaded) {
    return res.status(410).send('私密文件已被领取或已读取');
  }

  room.claimed = true;
  rooms.set(code, room);

  const ticket = crypto.randomUUID();

  privateTickets.set(ticket, {
    ticket,
    code,
    fileName: room.fileName,
    fileSize: room.fileSize,
    filePath: room.filePath,
    createdAt: Date.now(),
    expiresAt: Date.now() + PRIVATE_TICKET_AGE
  });

  console.log(`[私密票据生成] ${code} -> ${ticket}`);

  // 让手机系统下载器访问真正下载地址
  return res.redirect(302, `/api/private-file/${ticket}`);
});

// =========================
// API：私密票据真实下载地址
// 允许 HEAD / Range / 多次连接
// 完整下载完成后删除文件和取件码
// =========================

app.head('/api/private-file/:ticket', (req, res) => {
  const ticket = req.params.ticket;
  const fileInfo = privateTickets.get(ticket);

  if (
    !fileInfo ||
    Date.now() > fileInfo.expiresAt ||
    !fs.existsSync(fileInfo.filePath)
  ) {
    return res.status(404).end();
  }

  return sendFileWithRange(req, res, fileInfo, null);
});

app.get('/api/private-file/:ticket', (req, res) => {
  const ticket = req.params.ticket;
  const fileInfo = privateTickets.get(ticket);

  if (
    !fileInfo ||
    Date.now() > fileInfo.expiresAt ||
    !fs.existsSync(fileInfo.filePath)
  ) {
    return res.status(404).send('私密下载链接无效或已过期');
  }

  return sendFileWithRange(req, res, fileInfo, () => {
    const latest = privateTickets.get(ticket);

    if (!latest) return;

    safeDeleteFile(latest.filePath);
    privateTickets.delete(ticket);
    rooms.delete(latest.code);

    console.log(`[阅后即焚] ${latest.code} - ${latest.fileName}`);
  });
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

  const roomList = [];
  const ticketList = [];

  for (const [code, room] of rooms) {
    roomList.push({
      code,
      mode: room.mode,
      fileName: room.fileName,
      fileSize: room.fileSize,
      filePath: room.filePath,
      createdAt: new Date(room.createdAt).toLocaleString(),
      claimed: room.claimed,
      downloaded: room.downloaded
    });
  }

  for (const [ticket, fileInfo] of privateTickets) {
    ticketList.push({
      ticket,
      code: fileInfo.code,
      fileName: fileInfo.fileName,
      fileSize: fileInfo.fileSize,
      filePath: fileInfo.filePath,
      createdAt: new Date(fileInfo.createdAt).toLocaleString(),
      expiresAt: new Date(fileInfo.expiresAt).toLocaleString()
    });
  }

  res.json({
    rooms: roomList,
    privateTickets: ticketList
  });
});

// =========================
// 定时清理
// =========================

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  // 1. 清理 rooms 中的过期文件
  for (const [code, room] of rooms) {
    const maxAge = room.mode === 'private'
      ? MAX_PRIVATE_FILE_AGE
      : MAX_FILE_AGE;

    if (now - room.createdAt > maxAge) {
      if (fs.existsSync(room.filePath)) {
        safeDeleteFile(room.filePath);
      }

      rooms.delete(code);
      cleaned++;

      console.log(`[清理过期文件] ${code} - ${room.mode} - ${room.fileName}`);
    }
  }

  // 2. 清理过期的私密下载票据
  for (const [ticket, fileInfo] of privateTickets) {
    if (now > fileInfo.expiresAt) {
      privateTickets.delete(ticket);

      // 私密票据过期后，文件也销毁
      safeDeleteFile(fileInfo.filePath);
      rooms.delete(fileInfo.code);

      cleaned++;

      console.log(`[清理私密票据] ${fileInfo.code} - ${fileInfo.fileName}`);
    }
  }

  // 3. 扫描 uploads，清理上传中断文件和孤儿文件
  if (fs.existsSync(UPLOAD_DIR)) {
    const uploadFiles = fs.readdirSync(UPLOAD_DIR);

    for (const file of uploadFiles) {
      const filePath = path.join(UPLOAD_DIR, file);

      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;

        const isUploadingFile = file.endsWith('.uploading');

        const isInRooms = Array.from(rooms.values()).some(
          room => room.filePath === filePath
        );

        const isInTickets = Array.from(privateTickets.values()).some(
          ticket => ticket.filePath === filePath
        );

        const isReferenced = isInRooms || isInTickets;

        // 上传中断的半成品文件：3分钟后删除
        if (isUploadingFile && now - stat.mtimeMs > MAX_UPLOADING_AGE) {
          fs.unlinkSync(filePath);
          cleaned++;
          console.log(`[清理上传中断文件] ${file}`);
          continue;
        }

        // 孤儿文件：不在 rooms / tickets 记录里，且超过普通文件保存时间，删除
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
  console.log(`  最大上传限制: ${MAX_UPLOAD_SIZE / 1024 / 1024 / 1024} GB`);
  console.log(`  普通文件保存时间: ${MAX_FILE_AGE / 60 / 1000} 分钟`);
  console.log(`  私密文件保存时间: ${MAX_PRIVATE_FILE_AGE / 60 / 1000} 分钟`);
  console.log(`  私密票据有效期: ${PRIVATE_TICKET_AGE / 60 / 1000} 分钟`);
  console.log(`  上传中断文件清理时间: ${MAX_UPLOADING_AGE / 60 / 1000} 分钟`);
  console.log(`  地址: http://localhost:${PORT}\n`);
});
