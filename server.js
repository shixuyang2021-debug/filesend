const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 存储目录
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
  limits: { fileSize: 500 * 1024 * 1024 } // Railway 免费版 500MB
});

// 取件码生成 (5位)
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode() {
  let id;
  do {
    id = '';
    for (let i = 0; i < 5; i++) id += CHARS[Math.floor(Math.random() * CHARS.length)];
  } while (rooms.has(id));
  return id;
}

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// ---- API ----

// 上传文件
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });

  const code = generateCode();
  rooms.set(code, {
    code,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    filePath: req.file.path,
    createdAt: Date.now()
  });

  console.log(`[上传] ${code} - ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)} MB)`);
  res.json({ code, name: req.file.originalname, size: req.file.size });
});

// 查询取件码
app.get('/api/room/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room || !fs.existsSync(room.filePath)) {
    if (room) { rooms.delete(code); }
    return res.status(404).json({ error: '取件码无效或已过期' });
  }
  res.json({ name: room.fileName, size: room.fileSize, createdAt: room.createdAt });
});

// 下载文件
app.get('/api/download/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room || !fs.existsSync(room.filePath)) {
    if (room) rooms.delete(code);
    return res.status(404).json({ error: '取件码无效或已过期' });
  }

  res.download(room.filePath, room.fileName, (err) => {
    if (!err) {
      fs.unlink(room.filePath, () => {});
      rooms.delete(code);
      console.log(`[下载完成] ${code} - ${room.fileName}`);
    }
  });
});

// 清理过期文件 (每10分钟, 30分钟过期)
const CLEANUP_INTERVAL = 10 * 60 * 1000;
const MAX_FILE_AGE = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [code, room] of rooms) {
    if (now - room.createdAt > MAX_FILE_AGE) {
      fs.unlink(room.filePath, () => {});
      rooms.delete(code);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[清理] 已清理 ${cleaned} 个过期文件`);
}, CLEANUP_INTERVAL);

app.listen(PORT, () => {
  console.log(`\n  文件快传服务已启动`);
  console.log(`  地址: http://localhost:${PORT}\n`);
});
