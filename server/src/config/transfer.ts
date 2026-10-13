function envInt(name: string, fallback: number, min: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

const MB = 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 4 * MB;
const MAX_FILE_SIZE = 30 * MB;
const MAX_TOTAL_SIZE = 100 * MB;

export const TRANSFER = {
  chunkSize: envInt('TRANSFER_CHUNK_SIZE', DEFAULT_CHUNK_SIZE, MB),
  uploadConcurrency: envInt('TRANSFER_UPLOAD_CONCURRENCY', 3, 1),
  maxBatchFiles: envInt('TRANSFER_MAX_BATCH_FILES', 50, 1),
  maxFileSize: Math.min(envInt('TRANSFER_MAX_FILE_SIZE', MAX_FILE_SIZE, 1), MAX_FILE_SIZE),
  maxTotalSize: Math.min(envInt('TRANSFER_MAX_TOTAL_SIZE', MAX_TOTAL_SIZE, 1), MAX_TOTAL_SIZE),
  maxChunkSize: Math.min(envInt('TRANSFER_MAX_CHUNK_SIZE', MAX_FILE_SIZE, MB), MAX_FILE_SIZE),
};
