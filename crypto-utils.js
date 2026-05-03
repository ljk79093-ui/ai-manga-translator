// crypto-utils.js
const ENC_ALGO = { name: 'AES-GCM', length: 256 };
const DERIVE_ALGO = { name: 'PBKDF2', salt: new TextEncoder().encode('manga-salt'), iterations: 100000, hash: 'SHA-256' };
const BASE_KEY_MATERIAL = new TextEncoder().encode('manga-translator-fixed-pepper');

let cachedKey = null;

async function getEncryptionKey() {
  if (cachedKey) return cachedKey;
  const keyMaterial = await crypto.subtle.importKey(
    'raw', BASE_KEY_MATERIAL, 'PBKDF2', false, ['deriveKey']
  );
  cachedKey = await crypto.subtle.deriveKey(
    DERIVE_ALGO, keyMaterial, ENC_ALGO, false, ['encrypt', 'decrypt']
  );
  return cachedKey;
}

async function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoded
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return arrayBufferToBase64(combined);
}

async function decrypt(ciphertext) {
  if (!ciphertext) return ciphertext;
  const key = await getEncryptionKey();
  const combined = base64ToArrayBuffer(ciphertext);
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, data
  );
  return new TextDecoder().decode(decrypted);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}