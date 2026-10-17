const path = require("path");
const multer = require("multer");
const { getBucket } = require("../config/uploads");

// file-type is ESM-only from v17 onward, including the version that patches
// GHSA-5v7r-6r5c-r473 (a DoS: a tiny malformed file can hang the whole
// server). require() can't load an ESM-only package, so it's loaded lazily
// with a dynamic import() instead — the one piece of this CommonJS project
// that needs it — and cached so that only happens once.
let fileTypeFromBufferPromise;
function getFileTypeFromBuffer() {
  if (!fileTypeFromBufferPromise) {
    fileTypeFromBufferPromise = import("file-type").then(
      (mod) => mod.fileTypeFromBuffer,
    );
  }
  return fileTypeFromBufferPromise;
}

const MAX_FILE_MB = 2; // change this one number to raise or lower the upload limit
const ALLOWED_EXT = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".txt",
  ".zip",
];
// The real file signatures that count as a genuine match for the extensions above
// (checked after upload, against the file's actual bytes — see POST /:id/submission)
const ALLOWED_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
];
const LEGACY_OFFICE_EXT = [".doc", ".xls", ".ppt"];
const MIME_BY_EXT = {
  ".pdf": ["application/pdf"],
  ".doc": ["application/msword"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".xls": ["application/vnd.ms-excel"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".ppt": ["application/vnd.ms-powerpoint"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".zip": ["application/zip"],
};
const MAX_FIELDS = 10;
const MAX_PARTS = 12;
const MAX_FIELD_SIZE = 16 * 1024;

// Text and CSV files have no reliable magic number, so accept only valid UTF-8
// text without binary control bytes when their extension bypasses signature checks.
function isPlainTextBuffer(buffer) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
  } catch {
    return false;
  }
}

// Legacy Office files use the CFB container. A CFB signature alone is not
// enough: other formats (and arbitrary containers) use it too. Read the
// container's FAT directory chain and require its matching stream entry.
function isLegacyOfficeBuffer(buffer, ext) {
  if (!buffer || buffer.length < 512) return false;
  const streamNames = {
    ".doc": ["WordDocument"],
    ".xls": ["Workbook", "Book"],
    ".ppt": ["PowerPoint Document"],
  }[ext];
  if (!streamNames || !buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return false;
  const sectorShift = buffer.readUInt16LE(30);
  if (sectorShift !== 9 && sectorShift !== 12) return false;
  const sectorSize = 1 << sectorShift;
  const headerSize = sectorSize === 4096 ? 4096 : 512;
  const sectorCount = Math.floor((buffer.length - headerSize) / sectorSize);
  const fatSectorCount = buffer.readUInt32LE(44);
  let sector = buffer.readUInt32LE(48);
  if (!fatSectorCount || sectorCount < 1 || sector >= sectorCount) return false;

  const fatSectorIds = [];
  for (let i = 0; i < 109 && fatSectorIds.length < fatSectorCount; i += 1) {
    const id = buffer.readUInt32LE(76 + i * 4);
    if (id < sectorCount) fatSectorIds.push(id);
  }
  if (fatSectorIds.length !== fatSectorCount) return false;
  const fat = [];
  for (const id of fatSectorIds) {
    const start = headerSize + id * sectorSize;
    for (let offset = 0; offset < sectorSize; offset += 4) fat.push(buffer.readUInt32LE(start + offset));
  }

  const visited = new Set();
  while (sector < sectorCount && !visited.has(sector)) {
    visited.add(sector);
    const start = headerSize + sector * sectorSize;
    for (let offset = 0; offset + 128 <= sectorSize; offset += 128) {
      const entry = start + offset;
      const nameLength = buffer.readUInt16LE(entry + 64);
      if (nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0 && buffer[entry + 66] === 2) {
        const name = buffer.toString("utf16le", entry, entry + nameLength - 2);
        if (streamNames.includes(name)) return true;
      }
    }
    const next = fat[sector];
    if (next === undefined || next >= 0xfffffffc) break;
    sector = next;
  }
  return false;
}

// Files are held in memory just long enough to stream into GridFS (no local disk —
// needed because Render's free tier wipes local files on every restart/redeploy)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024,
    fields: MAX_FIELDS,
    parts: MAX_PARTS,
    fieldSize: MAX_FIELD_SIZE,
  },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_EXT.includes(
      path.extname(file.originalname).toLowerCase(),
    );
    cb(ok ? null : new Error("BAD_TYPE"), ok);
  },
}).single("file");

function handleUpload(req, res, next) {
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE")
      return res
        .status(400)
        .json({ error: `File is too large (${MAX_FILE_MB} MB max).` });
    if (err.message === "BAD_TYPE")
      return res
        .status(400)
        .json({
          error:
            "That file type is not allowed. Use PDF, Word, Excel, PowerPoint, CSV, TXT or ZIP.",
        });
    console.error(err);
    res
      .status(400)
      .json({
        error:
          "The file could not be uploaded. Try again, or choose a different file.",
      });
  });
}

function saveToGridFS(buffer, filename) {
  return new Promise((resolve, reject) => {
    const uploadStream = getBucket().openUploadStream(filename);
    uploadStream.end(buffer);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.on("error", reject);
  });
}

module.exports = {
  handleUpload,
  saveToGridFS,
  getFileTypeFromBuffer,
  ALLOWED_MIME,
  MIME_BY_EXT,
  LEGACY_OFFICE_EXT,
  isPlainTextBuffer,
  isLegacyOfficeBuffer,
};
