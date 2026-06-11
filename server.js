const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 存储目录
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 内存房间存储
const rooms = new Map();

// Multer 配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    cb(null, crypto.randomUUID() + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  }
});

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

// 文件名编码，兼容手机浏览器
function encodeRFC5987ValueChars(str) {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
}

// 获取安全的下载文件名
function getSafeFileName(fileName) {
  const baseName = path.basename(fileName || 'download');
  const ext = path.extname(baseName);
  return {
    originalName: baseName,
    fallbackName: 'download' + (ext || '')
  };
}

// 设置下载响应头
function setDownloadHeaders(res, room, fileSize, contentLength, isPartial, start, end) {
  const { originalName, fallbackName } = getSafeFileName(room.fileName);
  const encodedName = encodeRFC5987ValueChars(originalName);

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
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

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 上传文件
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未选择文件' });
  }

  const code = generateCode();

  rooms.set(code, {
    code,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    filePath: req.file.path,
    createdAt: Date.now()
  });

  console.log(`[上传] ${code} - ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);

  res.json({
    code,
    name: req.file.originalname,
    size: req.file.size
  });
});

// 查询取件码
app.get('/api/room/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room || !fs.existsSync(room.filePath)) {
    if (room) {
      rooms.delete(code);
    }

    return res.status(404).json({ error: '取件码无效或已过期' });
  }

  res.json({
    name: room.fileName,
    size: room.fileSize,
    createdAt: room.createdAt
  });
});

// 下载文件，支持手机浏览器和 Range 分段下载
app.get('/api/download/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);

  if (!room || !fs.existsSync(room.filePath)) {
    if (room) {
      rooms.delete(code);
    }

    return res.status(404).send('取件码无效或已过期');
  }

  const filePath = room.filePath;
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  console.log(`[下载请求] ${code} - ${room.fileName} - Range: ${range || 'none'}`);

  // 支持 Range 请求，很多手机浏览器/下载器会用这个
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

    const stream = fs.createReadStream(filePath, { start, end });

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

  const stream = fs.createReadStream(filePath);

  stream.on('error', (err) => {
    console.error('[下载失败]', err);
    if (!res.headersSent) {
      res.status(500).send('下载失败');
    } else {
      res.destroy(err);
    }
  });

  stream.on('end', () => {
    console.log(`[下载响应完成] ${code} - ${room.fileName}`);
  });

  stream.pipe(res);
});

// 清理过期文件，每10分钟检查一次，30分钟过期
const CLEANUP_INTERVAL = 10 * 60 * 1000;
const MAX_FILE_AGE = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [code, room] of rooms) {
    if (now - room.createdAt > MAX_FILE_AGE) {
      if (fs.existsSync(room.filePath)) {
        fs.unlink(room.filePath, () => {});
      }

      rooms.delete(code);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[清理] 已清理 ${cleaned} 个过期文件`);
  }
}, CLEANUP_INTERVAL);

app.listen(PORT, () => {
  console.log('\n  文件快传服务已启动');
  console.log(`  端口: ${PORT}`);
  console.log(`  地址: http://localhost:${PORT}\n`);
});
