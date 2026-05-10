require('dotenv').config();
const express = require('express');
const path = require('path');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE,        // optional: e.g. https://pub-xxxx.r2.dev  သို့မဟုတ် custom domain
  PORT = 3000,
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
  console.error('❌ Missing R2 env vars. Check .env.example');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// URL ထဲက filename ထုတ်တာ
function pickFilename(urlStr, fallback) {
  try {
    const u = new URL(urlStr);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last) return last;
  } catch (_) {}
  return fallback || `file-${Date.now()}`;
}

app.post('/api/upload', async (req, res) => {
  const { url, key } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    // Remote file ကို fetch လုပ်
    const resp = await fetch(url);
    if (!resp.ok) {
      return res.status(400).json({ error: `Fetch failed: ${resp.status} ${resp.statusText}` });
    }

    const contentType = resp.headers.get('content-type') || 'application/octet-stream';
    const contentLength = resp.headers.get('content-length') || null;
    const objectKey = (key && key.trim()) || pickFilename(url);

    // Stream → R2 (multipart upload အလိုအလျောက်)
    const uploader = new Upload({
      client: s3,
      params: {
        Bucket: R2_BUCKET,
        Key: objectKey,
        Body: resp.body,           // ReadableStream
        ContentType: contentType,
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,   // 8 MB parts
    });

    uploader.on('httpUploadProgress', (p) => {
      console.log(`[upload] ${objectKey} ${p.loaded}/${p.total ?? '?'}`);
    });

    await uploader.done();

    const publicUrl = R2_PUBLIC_BASE
      ? `${R2_PUBLIC_BASE.replace(/\/$/, '')}/${encodeURIComponent(objectKey)}`
      : null;

    res.json({
      success: true,
      bucket: R2_BUCKET,
      key: objectKey,
      contentType,
      contentLength,
      publicUrl,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

app.get('/healthz', (_, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`🚀 Server on :${PORT}`);
});
