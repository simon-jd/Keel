import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { OAuthError } from './errors.js';
export function pkceChallenge(verifier: string): string { return createHash('sha256').update(verifier).digest('base64url'); }
export class TokenCipher {
    #key: Buffer;
    private constructor(key: Buffer) { this.#key = key; }
    static async fromKeyFile(path: string): Promise<TokenCipher> {
        try {
            const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await file.stat();
                if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size !== 32 || stat.uid !== process.getuid?.())
                    throw new Error();
                return new TokenCipher(await file.readFile());
            }
            finally {
                await file.close();
            }
        }
        catch {
            throw new OAuthError('KEY_INVALID');
        }
    }
    encrypt(value: string, aad: string[]): Buffer {
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
        cipher.setAAD(Buffer.from(JSON.stringify(aad)));
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    }
    decrypt(value: Buffer, aad: string[]): string {
        try {
            const decipher = createDecipheriv('aes-256-gcm', this.#key, value.subarray(0, 12));
            decipher.setAAD(Buffer.from(JSON.stringify(aad)));
            decipher.setAuthTag(value.subarray(12, 28));
            return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
        }
        catch {
            throw new OAuthError('CIPHER_INVALID');
        }
    }
}
