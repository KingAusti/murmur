// Gives the unpacked extension a stable ID: creates an RSA key once, writes the
// public half into extension/manifest.json ("key") and prints the derived ID.
// Usage: node scripts/gen-key.mjs   (idempotent; reuses an existing key)
import { generateKeyPairSync, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../extension/manifest.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (!manifest.key) {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  manifest.key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// Chromium: ID = first 128 bits of sha256(DER public key), hex digits 0-f mapped to a-p.
const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
console.log([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(""));
