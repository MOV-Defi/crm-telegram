const fs = require('fs');
const path = require('path');

const MB = 1024 * 1024;
const DEFAULT_MIN_FREE_MB = 256;
const DEFAULT_MAX_RECLAIM_MB = 2048;

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getDataRoot = () => path.resolve(
  process.env.CRM_DATA_DIR || path.join(__dirname, '..', 'data')
);

const getAvailableBytes = (targetPath) => {
  try {
    const stats = fs.statfsSync(targetPath);
    return Number(stats.bavail || 0) * Number(stats.bsize || 0);
  } catch (_) {
    return null;
  }
};

const walkFiles = (dir) => {
  const files = [];
  const stack = [dir];

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stats = fs.statSync(filePath);
        files.push({
          path: filePath,
          size: stats.size,
          mtimeMs: stats.mtimeMs
        });
      } catch (_) {}
    }
  }

  return files;
};

const emergencyMediaCleanup = (reason = 'startup') => {
  const dataRoot = getDataRoot();
  const mediaDir = path.join(dataRoot, 'uploads', 'media');
  if (!fs.existsSync(mediaDir)) {
    return { attempted: false, reason: 'media dir missing', removedFiles: 0, removedBytes: 0 };
  }

  const minFreeBytes = toPositiveInt(process.env.STARTUP_CLEANUP_MIN_FREE_MB, DEFAULT_MIN_FREE_MB) * MB;
  const maxReclaimBytes = toPositiveInt(process.env.STARTUP_CLEANUP_MAX_RECLAIM_MB, DEFAULT_MAX_RECLAIM_MB) * MB;
  const beforeFreeBytes = getAvailableBytes(dataRoot);

  const files = walkFiles(mediaDir)
    .filter((file) => file.size > 0)
    .sort((a, b) => {
      const largeDelta = Number(b.size >= 50 * MB) - Number(a.size >= 50 * MB);
      if (largeDelta) return largeDelta;
      return a.mtimeMs - b.mtimeMs;
    });

  let removedFiles = 0;
  let removedBytes = 0;

  for (const file of files) {
    const currentFreeBytes = getAvailableBytes(dataRoot);
    if (currentFreeBytes !== null && currentFreeBytes >= minFreeBytes) break;
    if (removedBytes >= maxReclaimBytes) break;

    try {
      fs.unlinkSync(file.path);
      removedFiles += 1;
      removedBytes += file.size;
    } catch (_) {}
  }

  const afterFreeBytes = getAvailableBytes(dataRoot);
  console.warn(
    `[startup-cleanup] ${reason}: removed ${removedFiles} media files, ` +
    `reclaimed ${(removedBytes / MB).toFixed(1)} MB, ` +
    `free before=${beforeFreeBytes === null ? 'unknown' : `${(beforeFreeBytes / MB).toFixed(1)} MB`}, ` +
    `free after=${afterFreeBytes === null ? 'unknown' : `${(afterFreeBytes / MB).toFixed(1)} MB`}`
  );

  return { attempted: true, removedFiles, removedBytes, beforeFreeBytes, afterFreeBytes };
};

module.exports = {
  emergencyMediaCleanup
};
