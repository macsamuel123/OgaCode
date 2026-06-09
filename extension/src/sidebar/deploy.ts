export async function deployToNetlify(folder: string, token: string): Promise<string> {
  const { execSync } = require('child_process') as typeof import('child_process');
  const fs    = require('fs')    as typeof import('fs');
  const path  = require('path')  as typeof import('path');
  const os    = require('os')    as typeof import('os');
  const https = require('https') as typeof import('https');

  const zipPath = path.join(os.tmpdir(), `ogacode-deploy-${Date.now()}.zip`);

  if (process.platform === 'win32') {
    execSync(
      `powershell -Command "Compress-Archive -Path '${folder}\\*' -DestinationPath '${zipPath}' -Force"`,
      { timeout: 60000 }
    );
  } else {
    execSync(
      `cd "${folder}" && zip -r "${zipPath}" . --exclude "*.git*" --exclude "node_modules/*"`,
      { timeout: 60000, shell: '/bin/sh' }
    );
  }

  const zipBuffer = fs.readFileSync(zipPath);
  try { fs.unlinkSync(zipPath); } catch { /* ignore cleanup failure */ }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.netlify.com',
      path: '/api/v1/sites',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/zip',
        'Content-Length': zipBuffer.length,
      },
    }, (res: import('http').IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as { ssl_url?: string; url?: string; errors?: string[] };
          if (json.errors?.length) { reject(new Error(json.errors[0])); return; }
          const liveUrl = json.ssl_url ?? json.url ?? '';
          if (!liveUrl) { reject(new Error('Deploy succeeded but no URL returned.')); return; }
          resolve(liveUrl);
        } catch { reject(new Error('Unexpected response from Netlify.')); }
      });
    });
    req.on('error', (e: Error) => reject(e));
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Deploy timed out after 90s.')); });
    req.write(zipBuffer);
    req.end();
  });
}
