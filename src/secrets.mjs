import { open, constants } from 'node:fs/promises';

// Called only after deployment/credential approval. Never log the returned value.
export async function readSecret(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size < 1 || info.size > 4096) {
      throw new Error('Secret file must be a private regular file, at most 4096 bytes');
    }
    const value = (await file.readFile('utf8')).trim();
    if (!value || /[\r\n\u0000]/.test(value)) throw new Error('Invalid secret file');
    return value;
  } finally {
    await file.close();
  }
}

export function createSecretResolver(references, { env = process.env, readSecretFile = readSecret } = {}) {
  return async name => {
    const ref = references[name];
    if (!ref || (Object.hasOwn(ref, 'file') === Object.hasOwn(ref, 'env'))) throw new Error('Invalid secret reference');
    const value = ref.file ? await readSecretFile(ref.file) : env[ref.env];
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n\u0000]/.test(value)) throw new Error('Secret input missing or invalid');
    return value;
  };
}
