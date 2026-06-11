// 文件快传 - 前端逻辑

const $ = id => document.getElementById(id);
const dom = {
  connectPanel: $('connectPanel'), codePanel: $('codePanel'),
  tabSend: $('tabSend'), tabReceive: $('tabReceive'),
  sendMode: $('sendMode'), receiveMode: $('receiveMode'),

  dropZone: $('dropZone'), fileInput: $('fileInput'),
  fileInfo: $('fileInfo'), fileName: $('fileName'), fileSize: $('fileSize'),
  btnUpload: $('btnUpload'), btnCancelFile: $('btnCancelFile'),

  uploadProgress: $('uploadProgress'),
  uploadFill: $('uploadFill'), uploadPercent: $('uploadPercent'),
  uploadTransferred: $('uploadTransferred'),

  codeInput: $('codeInput'), btnCheck: $('btnCheck'),
  receiveResult: $('receiveResult'),
  recvName: $('recvName'), recvSize: $('recvSize'), btnDownload: $('btnDownload'),

  codeDisplay: $('codeDisplay'), btnCopy: $('btnCopy'), btnNewSend: $('btnNewSend'),

  toast: $('toast')
};

// 状态
let selectedFile = null;
let currentCode = null;

// ---- 工具函数 ----

function fmtSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function showToast(msg, type) {
  const t = dom.toast;
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.classList.remove('hidden');
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ---- Tab 切换 ----

dom.tabSend.addEventListener('click', () => {
  dom.tabSend.classList.add('active');
  dom.tabReceive.classList.remove('active');
  dom.sendMode.classList.remove('hidden');
  dom.receiveMode.classList.add('hidden');
  dom.receiveResult.classList.add('hidden');
});

dom.tabReceive.addEventListener('click', () => {
  dom.tabReceive.classList.add('active');
  dom.tabSend.classList.remove('active');
  dom.receiveMode.classList.remove('hidden');
  dom.sendMode.classList.add('hidden');
  dom.codeInput.focus();
});

// ---- 选择文件 ----

dom.dropZone.addEventListener('click', () => dom.fileInput.click());

dom.dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dom.dropZone.classList.add('dragover');
});

dom.dropZone.addEventListener('dragleave', () => {
  dom.dropZone.classList.remove('dragover');
});

dom.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dom.dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) selectFile(e.dataTransfer.files[0]);
});

dom.fileInput.addEventListener('change', () => {
  if (dom.fileInput.files.length > 0) selectFile(dom.fileInput.files[0]);
});

function selectFile(file) {
  selectedFile = file;
  dom.fileName.textContent = file.name;
  dom.fileSize.textContent = fmtSize(file.size);
  dom.fileInfo.classList.remove('hidden');
  dom.uploadProgress.classList.add('hidden');
}

dom.btnCancelFile.addEventListener('click', () => {
  selectedFile = null;
  dom.fileInfo.classList.add('hidden');
  dom.fileInput.value = '';
});

// ---- 上传文件 ----

dom.btnUpload.addEventListener('click', startUpload);

function startUpload() {
  if (!selectedFile) return;

  const formData = new FormData();
  formData.append('file', selectedFile);

  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.min(100, (e.loaded / e.total) * 100);
      dom.uploadFill.style.width = pct + '%';
      dom.uploadPercent.textContent = pct.toFixed(1) + '%';
      dom.uploadTransferred.textContent = fmtSize(e.loaded) + ' / ' + fmtSize(e.total);
    }
  });

  xhr.addEventListener('load', () => {
  if (xhr.status === 200) {
    const data = JSON.parse(xhr.responseText);
    currentCode = data.code;
    showCodePanel(data.code);
    showToast('上传完成！', 'success');
  } else if (xhr.status === 413) {
    showToast('文件太大，超过服务器限制', 'error');
  } else {
    showToast('上传失败，状态码：' + xhr.status, 'error');
  }
});

  xhr.addEventListener('error', () => showToast('上传失败：网络错误', 'error'));
  xhr.addEventListener('loadend', () => {
    dom.btnUpload.disabled = false;
    dom.fileInput.value = '';
    selectedFile = null;
    dom.fileInfo.classList.add('hidden');
  });

  xhr.open('POST', '/api/upload');
  xhr.send(formData);

  dom.uploadProgress.classList.remove('hidden');
  dom.btnUpload.disabled = true;
}

// ---- 取件码面板 ----

function showCodePanel(code) {
  dom.connectPanel.classList.add('hidden');
  dom.codePanel.classList.remove('hidden');
  dom.codeDisplay.textContent = code;
}

dom.btnCopy.addEventListener('click', () => {
  if (currentCode) {
    navigator.clipboard.writeText(currentCode).then(() => {
      showToast('取件码已复制', 'success');
    }).catch(() => {
      showToast('复制失败，请手动复制', 'error');
    });
  }
});

dom.btnNewSend.addEventListener('click', () => {
  currentCode = null;
  dom.codePanel.classList.add('hidden');
  dom.connectPanel.classList.remove('hidden');
  dom.uploadProgress.classList.add('hidden');
  dom.uploadFill.style.width = '0%';
  dom.uploadPercent.textContent = '0%';
  dom.uploadTransferred.textContent = '-- / --';
});

// ---- 接收文件 ----

dom.btnCheck.addEventListener('click', checkCode);
dom.codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') checkCode();
});

async function checkCode() {
  const code = dom.codeInput.value.trim().toUpperCase();
  if (code.length !== 5) {
    showToast('请输入5位取件码', 'error');
    return;
  }

  try {
    const res = await fetch('/api/room/' + code);
    if (!res.ok) {
      showToast('取件码无效或已过期', 'error');
      dom.receiveResult.classList.add('hidden');
      return;
    }
    const data = await res.json();
    dom.recvName.textContent = data.name;
    dom.recvSize.textContent = fmtSize(data.size);
    dom.receiveResult.classList.remove('hidden');
    dom.btnDownload.dataset.code = code;
    dom.btnDownload.setAttribute('href', '/api/download/' + encodeURIComponent(code));
  } catch (err) {
    showToast('网络错误', 'error');
  }
}

dom.btnDownload.addEventListener('click', () => {
  const code = dom.btnDownload.dataset.code;

  if (!code) {
    showToast('请先输入取件码', 'error');
    return;
  }

  const downloadUrl = '/api/download/' + encodeURIComponent(code);

  showToast('正在打开下载链接...', 'success');

  // 延迟一点点，让提示能显示出来
  setTimeout(() => {
    window.location.href = downloadUrl;
  }, 300);
});
