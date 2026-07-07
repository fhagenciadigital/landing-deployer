const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const SITES_DIR = process.env.SITES_DIR || '/data/sites';
const TMP_DIR = process.env.TMP_DIR || '/data/tmp';

const ALLOWED_SITES = (process.env.ALLOWED_SITES || '')
  .split(',')
  .map((site) => site.trim())
  .filter(Boolean);

const SITE_DOMAINS = {
  demo: 'demo.lp.fhad.xyz',
  laminas: 'lp.harmonizadoraelite.com.br',
  adaa: 'lp.adaa.com.pt'
};

function readSecret(name, fallback = '') {
  const secretPath = `/run/secrets/${name}`;

  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }

  return process.env[name] || fallback;
}

const DEPLOY_TOKEN = readSecret('LANDING_DEPLOY_TOKEN');

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json'
  });

  res.end(JSON.stringify(payload, null, 2));
}

function isSafeSite(site) {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(site);
}

function isSafeZipName(zipName) {
  return /^[A-Za-z0-9._-]+\.zip$/.test(zipName);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
    ...options
  });
}

function listZipEntries(zipPath) {
  return run('unzip', ['-Z1', zipPath])
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function hasUnsafeZipPaths(entries) {
  return entries.some((entry) => {
    return (
      entry.startsWith('/') ||
      entry === '..' ||
      entry.startsWith('../') ||
      entry.includes('/../') ||
      entry.endsWith('/..')
    );
  });
}

function getSourceDirectory(extractDir) {
  const items = fs
    .readdirSync(extractDir)
    .filter((item) => item !== '__MACOSX');

  if (items.length !== 1) {
    return extractDir;
  }

  const candidate = path.join(extractDir, items[0]);

  if (fs.statSync(candidate).isDirectory()) {
    return candidate;
  }

  return extractDir;
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function fixPermissions(targetDir) {
  fs.chmodSync(targetDir, 0o755);

  const items = fs.readdirSync(targetDir, {
    withFileTypes: true
  });

  for (const item of items) {
    const itemPath = path.join(targetDir, item.name);

    if (item.isDirectory()) {
      fixPermissions(itemPath);
    } else if (item.isFile()) {
      fs.chmodSync(itemPath, 0o644);
    }
  }
}

function saveUploadedZip(site, zipName, buffer) {
  const siteUploadDir = path.join(UPLOADS_DIR, site);

  fs.mkdirSync(siteUploadDir, { recursive: true });
  fs.chmodSync(siteUploadDir, 0o755);

  const zipPath = path.join(siteUploadDir, zipName);
  fs.writeFileSync(zipPath, buffer);
  fs.chmodSync(zipPath, 0o644);

  return zipPath;
}

function validateVersion(srcDir, site, siteDir) {
  const versionPath = path.join(srcDir, 'version.json');

  if (!fs.existsSync(versionPath)) {
    throw new Error('version.json não encontrado na raiz do ZIP.');
  }

  let newVersion;

  try {
    newVersion = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  } catch {
    throw new Error('version.json não é um JSON válido.');
  }

  if (!newVersion.site || typeof newVersion.site !== 'string') {
    throw new Error('version.json: campo "site" (string) obrigatório.');
  }

  if (!newVersion.version || typeof newVersion.version !== 'string') {
    throw new Error('version.json: campo "version" (string) obrigatório.');
  }

  if (newVersion.site !== site) {
    throw new Error(
      `version.json: site "${newVersion.site}" não coincide com o site do deploy "${site}".`
    );
  }

  const existingVersionPath = path.join(siteDir, 'version.json');

  if (fs.existsSync(existingVersionPath)) {
    let existingVersion;

    try {
      existingVersion = JSON.parse(fs.readFileSync(existingVersionPath, 'utf8'));
    } catch {
      throw new Error('version.json existente no site está corrompido.');
    }

    if (newVersion.version < existingVersion.version) {
      throw new Error(
        `Versão "${newVersion.version}" é inferior à versão atual "${existingVersion.version}".`
      );
    }
  }

  return newVersion;
}

function deploy(site, zipName) {
  if (!isSafeSite(site)) {
    throw new Error('Nome de site inválido.');
  }

  if (!isSafeZipName(zipName)) {
    throw new Error('Nome de ZIP inválido. Usa apenas letras, números, ponto, hífen e underscore.');
  }

  if (ALLOWED_SITES.length > 0 && !ALLOWED_SITES.includes(site)) {
    throw new Error(`Site não permitido: ${site}`);
  }

  const zipPath = path.join(UPLOADS_DIR, site, zipName);

  if (!fs.existsSync(zipPath)) {
    throw new Error(`ZIP não encontrado: ${zipPath}`);
  }

  const entries = listZipEntries(zipPath);

  if (hasUnsafeZipPaths(entries)) {
    throw new Error('ZIP contém caminhos inseguros.');
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');

  // --- Wrap deploy logic to write error details on failure ---
  try {
    return deployInternal(site, zipName, zipPath, entries, timestamp);
  } catch (error) {
    const errorLogPath = zipPath + '.txt';
    const errorDetails = [
      `Erro no deploy — ${new Date().toISOString()}`,
      `Site: ${site}`,
      `ZIP: ${zipName}`,
      `Caminho: ${zipPath}`,
      `Release: ${timestamp}`,
      '',
      `Mensagem: ${error.message}`,
      '',
      `Stack:`,
      error.stack || '(sem stack)'
    ].join('\n');

    try {
      fs.writeFileSync(errorLogPath, errorDetails + '\n');
      fs.chmodSync(errorLogPath, 0o644);
    } catch {}

    throw error;
  }
}

function deployInternal(site, zipName, zipPath, entries, timestamp) {
  const domain = SITE_DOMAINS[site] || `${site}.lp.fhad.xyz`;

  const workDir = path.join(TMP_DIR, `${site}-${timestamp}`);
  const extractDir = path.join(workDir, 'src');

  const siteDir = path.join(SITES_DIR, site);
  const releasesDir = path.join(siteDir, 'releases');
  const releaseDir = path.join(releasesDir, timestamp);
  const currentLink = path.join(siteDir, 'current');

  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(releasesDir, { recursive: true });

  run('unzip', ['-q', zipPath, '-d', extractDir]);

  const srcDir = getSourceDirectory(extractDir);

  // --- Validate version.json from the ZIP ---
  const versionInfo = validateVersion(srcDir, site, siteDir);

  let publishDir = '';

  if (fs.existsSync(path.join(srcDir, 'index.html'))) {
    publishDir = srcDir;
  } else if (fs.existsSync(path.join(srcDir, 'package.json'))) {
    const npmInstallArgs = fs.existsSync(path.join(srcDir, 'package-lock.json'))
      ? ['ci']
      : ['install'];

    run('npm', npmInstallArgs, { cwd: srcDir });
    run('npm', ['run', 'build'], { cwd: srcDir });

    const candidates = ['dist', 'build', 'out'].map((dir) =>
      path.join(srcDir, dir)
    );

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, 'index.html'))) {
        publishDir = candidate;
        break;
      }
    }

    if (!publishDir) {
      throw new Error('Build terminou, mas não encontrei dist/, build/ ou out/ com index.html.');
    }
  } else {
    throw new Error('ZIP inválido: não encontrei index.html nem package.json.');
  }

  copyDirectory(publishDir, releaseDir);
  fixPermissions(releaseDir);

  if (!fs.existsSync(path.join(releaseDir, 'index.html'))) {
    throw new Error('Release inválida: index.html não encontrado.');
  }

  const relativeTarget = path.join('releases', timestamp);
  const temporaryLink = path.join(siteDir, 'current.new');

  try {
    fs.unlinkSync(temporaryLink);
  } catch {}

  fs.symlinkSync(relativeTarget, temporaryLink);
  fs.renameSync(temporaryLink, currentLink);

  // --- Save version.json to site root ---
  const siteVersionPath = path.join(siteDir, 'version.json');
  fs.writeFileSync(siteVersionPath, JSON.stringify(versionInfo, null, 2) + '\n');
  fs.chmodSync(siteVersionPath, 0o644);

  fs.rmSync(workDir, {
    recursive: true,
    force: true
  });

  // --- Delete the uploaded ZIP ---
  try {
    fs.unlinkSync(zipPath);
  } catch {}

  return {
    success: true,
    site,
    domain,
    zip: zipName,
    version: versionInfo.version,
    release: timestamp,
    url: `https://${domain}`
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'landing-deployer'
    });
  }

  if (req.method !== 'POST' || req.url !== '/deploy') {
    return json(res, 404, {
      error: 'Not found'
    });
  }

  const token = req.headers['x-deploy-token'];

  if (!DEPLOY_TOKEN || token !== DEPLOY_TOKEN) {
    return json(res, 401, {
      error: 'Unauthorized'
    });
  }

  const contentType = req.headers['content-type'] || '';

  // --- Binary upload mode: Content-Type application/zip ---
  if (contentType.startsWith('application/zip') || contentType.startsWith('application/octet-stream')) {
    const site = (req.headers['x-deploy-site'] || '').trim();
    const zipName = (req.headers['x-deploy-filename'] || 'site.zip').trim();

    if (!site) {
      return json(res, 400, { success: false, error: 'Header x-deploy-site é obrigatório no modo binário.' });
    }

    const chunks = [];
    let totalLength = 0;
    const MAX_SIZE = 200 * 1024 * 1024; // 200 MB

    req.on('data', (chunk) => {
      totalLength += chunk.length;

      if (totalLength > MAX_SIZE) {
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        saveUploadedZip(site, zipName, buffer);

        const result = deploy(site, zipName);

        return json(res, 200, result);
      } catch (error) {
        return json(res, 400, {
          success: false,
          error: error.message
        });
      }
    });

    return;
  }

  // --- JSON mode (default): zip_filename references an already-uploaded file ---
  let body = '';

  req.on('data', (chunk) => {
    body += chunk.toString();

    if (body.length > 1024 * 1024) {
      req.destroy();
    }
  });

  req.on('end', () => {
    try {
      const payload = JSON.parse(body || '{}');

      const result = deploy(
        String(payload.site || ''),
        String(payload.zip_filename || 'site.zip')
      );

      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, {
        success: false,
        error: error.message
      });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`landing-deployer listening on port ${PORT}`);
});