const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/data/uploads';
const SITES_DIR = process.env.SITES_DIR || '/data/sites';
const TMP_DIR = process.env.TMP_DIR || '/data/tmp';
const BACKUPS_DIR = process.env.BACKUPS_DIR || '/data/backups';
const BACKUP_RETENTION_MS = 5 * 24 * 60 * 60 * 1000; // 5 dias

const ALLOWED_SITES = (process.env.ALLOWED_SITES || '')
  .split(',')
  .map((site) => site.trim())
  .filter(Boolean);

// --- Load sites configuration ---
let SITES_CONFIG = [];
const SITES_JSON_PATH = path.join(__dirname, 'sites.json');

try {
  SITES_CONFIG = JSON.parse(fs.readFileSync(SITES_JSON_PATH, 'utf8'));
  console.log(`sites.json loaded: ${SITES_CONFIG.length} site(s) configured`);
} catch {
  console.warn('sites.json not found or invalid, using fallback (no sites configured)');
}

function getSiteHost(site, env) {
  const entry = SITES_CONFIG.find((s) => s.name === site);

  if (entry && entry[env] && entry[env].host) {
    return entry[env].host;
  }

  // Fallback: <site>.lp.fhad.xyz
  return `${site}.lp.fhad.xyz`;
}

function isSiteConfigured(site) {
  return SITES_CONFIG.some((s) => s.name === site);
}

function readSecret(name, fallback = '') {
  const secretPath = `/run/secrets/${name}`;

  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }

  return process.env[name] || fallback;
}

const DEPLOY_TOKEN = readSecret('LANDING_DEPLOY_TOKEN');

// --- Load service version ---
let SERVICE_VERSION = 'unknown';
const VERSION_PATH = path.join(__dirname, 'version.json');

try {
  const pkg = JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
  SERVICE_VERSION = pkg.version || 'unknown';
} catch {
  console.warn('version.json not found or invalid, using "unknown"');
}

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

function generateTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');
}

function cleanupOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;

  const now = Date.now();
  const cutoff = now - BACKUP_RETENTION_MS;

  const files = fs.readdirSync(BACKUPS_DIR);

  for (const file of files) {
    if (!file.endsWith('.tar.gz')) continue;

    const filePath = path.join(BACKUPS_DIR, file);
    const stat = fs.statSync(filePath);

    if (stat.mtimeMs < cutoff) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Backup expirado removido: ${file}`);
      } catch {}
    }
  }
}

function backupSite(site, env) {
  if (!isSiteConfigured(site)) {
    throw new Error(`Site "${site}" não está configurado no sites.json.`);
  }

  const siteDir = path.join(SITES_DIR, site, env);

  if (!fs.existsSync(siteDir)) {
    throw new Error(`Site "${site}" (${env}) não encontrado. Nenhum deploy feito ainda.`);
  }

  const timestamp = generateTimestamp();
  const backupName = `${site}-${env}-${timestamp}.tar.gz`;

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const backupPath = path.join(BACKUPS_DIR, backupName);

  const envRelPath = path.join(site, env);
  run('tar', ['-czf', backupPath, '-C', SITES_DIR, envRelPath]);

  return {
    success: true,
    site,
    env,
    backup: backupName,
    path: backupPath
  };
}

function restoreSite(site, backupName, env) {
  if (!isSiteConfigured(site)) {
    throw new Error(`Site "${site}" não está configurado no sites.json.`);
  }

  if (!isSafeSite(site)) {
    throw new Error('Nome de site inválido.');
  }

  if (!backupName || typeof backupName !== 'string') {
    throw new Error('Nome do backup é obrigatório.');
  }

  // Impedir path traversal no nome do backup
  if (backupName.includes('/') || backupName.includes('..')) {
    throw new Error('Nome de backup inválido.');
  }

  const backupPath = path.join(BACKUPS_DIR, backupName);

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup não encontrado: ${backupName}`);
  }

  const siteDir = path.join(SITES_DIR, site, env);

  // Remover ambiente atual
  if (fs.existsSync(siteDir)) {
    fs.rmSync(siteDir, { recursive: true, force: true });
  }

  // Garantir que o diretório pai existe
  fs.mkdirSync(path.join(SITES_DIR, site), { recursive: true });

  // Extrair backup (o tar contém a pasta 'env/')
  run('tar', ['-xzf', backupPath, '-C', path.join(SITES_DIR, site)]);

  return {
    success: true,
    site,
    env,
    backup: backupName,
    restored: true
  };
}

function resetSite(site, env) {
  if (!isSiteConfigured(site)) {
    throw new Error(`Site "${site}" não está configurado no sites.json.`);
  }

  const siteDir = path.join(SITES_DIR, site, env);
  let siteRemoved = false;
  let backupsRemoved = 0;

  // Remover diretório do ambiente
  if (fs.existsSync(siteDir)) {
    fs.rmSync(siteDir, { recursive: true, force: true });
    siteRemoved = true;
  }

  // Remover backups do site+ambiente
  if (fs.existsSync(BACKUPS_DIR)) {
    const files = fs.readdirSync(BACKUPS_DIR);
    const prefix = `${site}-${env}-`;

    for (const file of files) {
      if (file.startsWith(prefix) && file.endsWith('.tar.gz')) {
        const filePath = path.join(BACKUPS_DIR, file);
        try {
          fs.unlinkSync(filePath);
          backupsRemoved++;
        } catch {}
      }
    }
  }

  if (!siteRemoved && backupsRemoved === 0) {
    throw new Error(`Site "${site}" (${env}) não encontrado. Nenhum deploy ou backup para remover.`);
  }

  return {
    success: true,
    site,
    env,
    siteRemoved,
    backupsRemoved
  };
}

function deploy(site, zipName, env) {
  if (!isSafeSite(site)) {
    throw new Error('Nome de site inválido.');
  }

  if (!isSafeZipName(zipName)) {
    throw new Error('Nome de ZIP inválido. Usa apenas letras, números, ponto, hífen e underscore.');
  }

  if (!isSiteConfigured(site)) {
    throw new Error(`Site "${site}" não está configurado no sites.json.`);
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

  const timestamp = generateTimestamp();

  // --- Wrap deploy logic to write error details on failure ---
  try {
    return deployInternal(site, zipName, zipPath, entries, timestamp, env);
  } catch (error) {
    const errorLogPath = zipPath + '.txt';
    const errorDetails = [
      `Erro no deploy — ${new Date().toISOString()}`,
      `Site: ${site}`,
      `Env: ${env}`,
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

function deployInternal(site, zipName, zipPath, entries, timestamp, env) {
  const domain = getSiteHost(site, env);

  const workDir = path.join(TMP_DIR, `${site}-${env}-${timestamp}`);
  const extractDir = path.join(workDir, 'src');

  const siteDir = path.join(SITES_DIR, site, env);
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
    env,
    domain,
    zip: zipName,
    version: versionInfo.version,
    release: timestamp,
    url: `https://${domain}`
  };
}

function authenticate(req, res) {
  const token = req.headers['x-deploy-token'];

  if (!DEPLOY_TOKEN || token !== DEPLOY_TOKEN) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }

  return true;
}

function getSiteFromHeaders(req, res) {
  const site = (req.headers['x-deploy-site'] || '').trim();

  if (!site) {
    json(res, 400, { success: false, error: 'Header x-deploy-site é obrigatório.' });
    return null;
  }

  if (!isSafeSite(site)) {
    json(res, 400, { success: false, error: 'Nome de site inválido.' });
    return null;
  }

  if (!isSiteConfigured(site)) {
    json(res, 400, { success: false, error: `Site "${site}" não está configurado no sites.json.` });
    return null;
  }

  return site;
}

function getEnvFromHeaders(req, res) {
  const env = (req.headers['x-deploy-env'] || '').trim().toLowerCase();

  if (!env) {
    json(res, 400, { success: false, error: 'Header x-deploy-env é obrigatório. Valores aceites: "production" ou "testing".' });
    return null;
  }

  if (env !== 'production' && env !== 'testing') {
    json(res, 400, { success: false, error: 'Header x-deploy-env inválido. Valores aceites: "production" ou "testing".' });
    return null;
  }

  return env;
}

const server = http.createServer((req, res) => {
  // --- Health check ---
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'landing-deployer',
      version: SERVICE_VERSION
    });
  }

  // --- Backup ---
  if (req.method === 'POST' && req.url === '/backup') {
    if (!authenticate(req, res)) return;

    const site = getSiteFromHeaders(req, res);
    if (!site) return;

    const env = getEnvFromHeaders(req, res);
    if (!env) return;

    try {
      cleanupOldBackups();
      const result = backupSite(site, env);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { success: false, error: error.message });
    }
  }

  // --- Restore ---
  if (req.method === 'POST' && req.url === '/restore') {
    if (!authenticate(req, res)) return;

    const site = getSiteFromHeaders(req, res);
    if (!site) return;

    const env = getEnvFromHeaders(req, res);
    if (!env) return;

    const backupName = (req.headers['x-deploy-backup'] || '').trim();

    if (!backupName) {
      return json(res, 400, { success: false, error: 'Header x-deploy-backup é obrigatório.' });
    }

    try {
      const result = restoreSite(site, backupName, env);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { success: false, error: error.message });
    }
  }

  // --- Reset ---
  if (req.method === 'POST' && req.url === '/reset') {
    if (!authenticate(req, res)) return;

    const site = getSiteFromHeaders(req, res);
    if (!site) return;

    const env = getEnvFromHeaders(req, res);
    if (!env) return;

    try {
      const result = resetSite(site, env);
      return json(res, 200, result);
    } catch (error) {
      return json(res, 400, { success: false, error: error.message });
    }
  }

  // --- Deploy ---
  if (req.method !== 'POST' || req.url !== '/deploy') {
    return json(res, 404, { error: 'Not found' });
  }

  if (!authenticate(req, res)) return;

  const site = getSiteFromHeaders(req, res);
  if (!site) return;

  const env = getEnvFromHeaders(req, res);
  if (!env) return;

  const zipName = (req.headers['x-deploy-filename'] || 'site.zip').trim();

  if (!isSafeZipName(zipName)) {
    return json(res, 400, { success: false, error: 'Nome de ZIP inválido.' });
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

      cleanupOldBackups();
      const result = deploy(site, zipName, env);

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