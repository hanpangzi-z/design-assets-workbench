import multer from 'multer';
import { TRANSFER } from '../config/transfer';

const transferChunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: TRANSFER.maxChunkSize,
  },
});

export default transferChunkUpload;
