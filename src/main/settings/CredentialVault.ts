import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

export class CredentialVault {
  constructor(private readonly filePath: string) {}

  async hasCredential(): Promise<boolean> {
    return Boolean(await this.getCredential())
  }

  async getCredential(): Promise<string | undefined> {
    try {
      const encrypted = await readFile(this.filePath)
      if (!safeStorage.isEncryptionAvailable()) return undefined
      return safeStorage.decryptString(encrypted)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async setCredential(value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统凭据加密不可用，无法保存模型密钥。')
    }
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, safeStorage.encryptString(value))
  }
}
