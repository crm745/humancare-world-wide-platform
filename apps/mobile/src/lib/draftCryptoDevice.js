// Phase 6: the phone's AES-256-GCM (expo-crypto's native module) for lib/draftCrypto.js. Keys and sealed data are passed as base64 text; a fresh random 12-byte nonce is made for
// every encryption and a 16-byte authentication tag is kept with the ciphertext. Decrypting with a wrong key, wrong additional data or altered bytes THROWS (the caller treats it as "unusable").
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import * as Crypto from 'expo-crypto';

export const deviceCipher = {
  async generateKey() {
    const key = await AESEncryptionKey.generate(256);
    return key.encoded('base64');
  },
  async encrypt(keyB64, plainBytes, aadBytes) {
    const key = await AESEncryptionKey.import(keyB64, 'base64');
    const sealed = await aesEncryptAsync(plainBytes, key, { additionalData: aadBytes });
    return sealed.combined('base64');
  },
  async decrypt(keyB64, combinedB64, aadBytes) {
    const key = await AESEncryptionKey.import(keyB64, 'base64');
    const sealed = AESSealedData.fromCombined(combinedB64);
    return aesDecryptAsync(sealed, key, { additionalData: aadBytes, output: 'bytes' });
  },
};

// SHA-256 as hex: names the account's files and key slot without writing the account id anywhere.
export const deviceHash = async (text) => (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text)).slice(0, 32);
