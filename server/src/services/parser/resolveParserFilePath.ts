import path from 'path';
import { STORAGE } from '../../config/storage';

export function resolveParserFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (path.isAbsolute(normalized)) return normalized;
  return path.join(STORAGE.base, normalized);
}
