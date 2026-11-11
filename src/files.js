import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function read (path) {
  try {
    return await readFile(path, 'utf8') || 'false'; // Empty files are cache miss
  } catch {
    return 'false';
  }
}

export async function write (path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: 'utf8', flag: 'w' });
}
