// Environment inspector & optional full-featured component manager.
// Never silently abandons lower-spec users: detects missing optional upgrades
// (Node runtime, Python/Limbic, local E5/BGE semantic models) and lets users
// selectively check & download what they want, with domestic mirror acceleration.
import {existsSync, mkdirSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseNodeVersion, supportsNativeSqlite} from './sqlite-compat.mjs';

export const MIRROR_PRESETS = {
  cn: {
    id: 'cn',
    label: '国内镜像加速（推荐，下载更快）',
    hfBase: 'https://hf-mirror.com',
    nodeBase: 'https://npmmirror.com/mirrors/node',
    githubPrefix: 'https://ghfast.top/',
  },
  official: {
    id: 'official',
    label: '官方直连源（海外网络推荐）',
    hfBase: 'https://huggingface.co',
    nodeBase: 'https://nodejs.org/dist',
    githubPrefix: '',
  },
};

function detectPython(customPath = '') {
  const candidates = [customPath, 'python3', 'python', 'py'].filter(Boolean);
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], {timeout: 3000, encoding: 'utf8', windowsHide: true});
      if (r.status === 0) {
        const ver = (r.stdout || r.stderr || '').trim();
        return {found: true, path: bin, version: ver};
      }
    } catch { /* try next */ }
  }
  return {found: false, path: null, version: null};
}

function hasModelFiles(dir) {
  if (!dir || !existsSync(dir)) return false;
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'onnx', 'model_quantized.onnx')) || existsSync(join(dir, 'tokenizer.json'));
}

export function inspectComponents({root, directory, profile = {}} = {}) {
  const node = parseNodeVersion();
  const nativeSqlite = supportsNativeSqlite(node.raw);
  const modelsRoot = join(directory, 'models');
  const e5Dir = process.env.BRAIN_MEMORY_MODEL_DIR || join(modelsRoot, 'multilingual-e5-small');
  const bgeDir = process.env.BRAIN_MEMORY_RERANKER_DIR || join(modelsRoot, 'bge-reranker-base');
  const bundledPy = join(root, '_local/affect-runtime/python-3.13.9/python.exe');
  const pythonInfo = existsSync(bundledPy)
    ? {found: true, path: bundledPy, version: 'Python 3.13.9 (bundled)'}
    : detectPython(profile.python || '');

  const components = [
    {
      id: 'node-runtime',
      name: 'Node.js 原生高性能引擎',
      category: 'core',
      installed: nativeSqlite,
      recommended: !nativeSqlite,
      sizeHint: '约 35 MB',
      requirement: '任意 64 位系统',
      current: `v${node.raw}`,
      benefit: nativeSqlite
        ? '当前 Node 已原生支持 SQLite，性能拉满。'
        : '当前 Node 版本较低；勾选可下载便携版 Node 26（不影响系统原环境），彻底解锁满血原生存取。',
      canDownload: !nativeSqlite,
    },
    {
      id: 'limbic-python',
      name: 'Limbic 深度情感与内驱力引擎',
      category: 'affect',
      installed: pythonInfo.found,
      recommended: true,
      sizeHint: '约 25 MB（便携 Python）',
      requirement: '需 Python 3.10+',
      current: pythonInfo.found ? pythonInfo.version : '未检测到 Python（当前走轻量情感层）',
      benefit: '解锁六维内驱力、昼夜节律、疲劳恢复与细腻情绪演化；不装也可正常聊天。',
      canDownload: !pythonInfo.found,
    },
    {
      id: 'semantic-e5',
      name: '本地语义记忆模型（multilingual-e5-small）',
      category: 'memory',
      installed: hasModelFiles(e5Dir),
      recommended: true,
      sizeHint: '约 120 MB',
      requirement: 'CPU 即可，建议 4 GB+ 内存',
      current: hasModelFiles(e5Dir) ? '已就绪' : '未下载（当前走快速 BM25 检索）',
      benefit: '让 TA 听懂“换种说法提以前的事”，离线跨句语义回忆更准，不消耗 API 费用。',
      canDownload: !hasModelFiles(e5Dir),
      targetDir: e5Dir,
    },
    {
      id: 'reranker-bge',
      name: '本地记忆精排模型（bge-reranker-base）',
      category: 'memory',
      installed: hasModelFiles(bgeDir),
      recommended: false,
      sizeHint: '约 280 MB',
      requirement: 'CPU 即可，建议 8 GB+ 内存',
      current: hasModelFiles(bgeDir) ? '已就绪' : '未下载（可选满血加强项）',
      benefit: '记忆超过几百条后自动二次精排，把最贴切的那条记忆精准顶到最前面。',
      canDownload: !hasModelFiles(bgeDir),
      targetDir: bgeDir,
    },
  ];

  const missingRecommended = components.filter(c => !c.installed && c.recommended);
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: node.raw,
    nativeSqlite,
    fullPower: components.every(c => c.installed),
    hasMissingRecommended: missingRecommended.length > 0,
    mirrors: Object.values(MIRROR_PRESETS),
    components,
  };
}

const HF_MODEL_FILES = {
  'semantic-e5': {
    repo: 'Xenova/multilingual-e5-small',
    dirName: 'multilingual-e5-small',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'],
  },
  'reranker-bge': {
    repo: 'Xenova/bge-reranker-base',
    dirName: 'bge-reranker-base',
    files: ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'],
  },
};

export function createComponentInstaller({root, directory, fetchImpl = fetch} = {}) {
  let job = {running: false, mirror: 'cn', items: [], startedAt: null, finishedAt: null};

  async function downloadFile(url, destPath, onProgress) {
    const res = await fetchImpl(url, {redirect: 'follow', signal: AbortSignal.timeout(120000)});
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    const total = Number(res.headers?.get?.('content-length') ?? 0);
    const reader = res.body?.getReader?.();
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(destPath, buf);
      onProgress?.(buf.length, buf.length);
      return;
    }
    const chunks = [];
    let received = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.byteLength;
      onProgress?.(received, total);
    }
    writeFileSync(destPath, Buffer.concat(chunks));
  }

  async function installSelected({ids = [], mirror = 'cn'} = {}) {
    if (job.running) return job;
    const mirrorCfg = MIRROR_PRESETS[mirror] ?? MIRROR_PRESETS.cn;
    const uniqueIds = [...new Set(Array.isArray(ids) ? ids : [])].slice(0, 6);
    job = {
      running: true,
      mirror: mirrorCfg.id,
      startedAt: Date.now(),
      finishedAt: null,
      items: uniqueIds.map(id => ({id, status: 'queued', percent: 0, message: '等待开始'})),
    };

    const run = async () => {
      try {
        for (const item of job.items) {
          item.status = 'downloading';
          try {
            if (HF_MODEL_FILES[item.id]) {
              const spec = HF_MODEL_FILES[item.id];
              const baseDir = join(directory, 'models', spec.dirName);
              mkdirSync(join(baseDir, 'onnx'), {recursive: true});
              for (let i = 0; i < spec.files.length; i++) {
                const rel = spec.files[i];
                const url = `${mirrorCfg.hfBase}/${spec.repo}/resolve/main/${rel}`;
                const dest = join(baseDir, rel);
                item.message = `正在下载 ${rel} (${i + 1}/${spec.files.length})`;
                await downloadFile(url, dest, (got, total) => {
                  const fileFrac = total > 0 ? got / total : 0.5;
                  item.percent = Math.min(99, Math.round(((i + fileFrac) / spec.files.length) * 100));
                });
              }
              item.percent = 100;
              item.status = 'done';
              item.message = '下载完成，已就绪';
            } else if (item.id === 'node-runtime') {
              const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
              const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
              const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
              const url = `${mirrorCfg.nodeBase}/latest-v26.x/`;
              item.message = `请使用随附启动器或镜像源自动获取便携 Node (${plat}-${arch}.${ext})：${url}`;
              item.percent = 100;
              item.status = 'guide';
            } else if (item.id === 'limbic-python') {
              item.message = '已生成便携 Python / Limbic 启用指引；安装 Python 3.10+ 后即可在设置中一键开启。';
              item.percent = 100;
              item.status = 'guide';
            } else {
              item.status = 'skipped';
              item.message = '未知组件';
            }
          } catch (err) {
            item.status = 'error';
            item.message = `下载失败：${err.message ?? err}（可切换镜像源后重试）`;
          }
        }
      } finally {
        job.running = false;
        job.finishedAt = Date.now();
      }
    };

    void run();
    return job;
  }

  return {
    installSelected,
    status: () => job,
  };
}

export function inspectStorageUsage({directory} = {}) {
  const sqliteFile = join(directory, 'subject.sqlite');
  const walFile = join(directory, 'subject.sqlite-wal');
  const ledgerFile = join(directory, 'requests.json');
  const sizeOf = p => (existsSync(p) ? statSync(p).size : 0);
  return {
    sqliteBytes: sizeOf(sqliteFile),
    walBytes: sizeOf(walFile),
    ledgerBytes: sizeOf(ledgerFile),
    totalBytes: sizeOf(sqliteFile) + sizeOf(walFile) + sizeOf(ledgerFile),
  };
}

export function compareSemver(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export async function checkLatestRelease({
  currentVersion = '0.3.1',
  repo = '235YY/threadline-agent',
  fetchImpl = fetch,
} = {}) {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const res = await fetchImpl(apiUrl, {
      headers: {'accept': 'application/vnd.github+json', 'user-agent': 'threadline-studio'},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return {ok: false, currentVersion, latestVersion: currentVersion, hasUpdate: false, error: `HTTP_${res.status}`, releaseUrl: `https://github.com/${repo}/releases`};
    }
    const data = await res.json();
    const latest = String(data.tag_name || currentVersion).replace(/^v/i, '');
    const hasUpdate = compareSemver(latest, currentVersion) > 0;
    return {
      ok: true,
      currentVersion,
      latestVersion: latest,
      hasUpdate,
      name: data.name || `v${latest}`,
      notes: String(data.body || '').slice(0, 800),
      releaseUrl: data.html_url || `https://github.com/${repo}/releases`,
      publishedAt: data.published_at || null,
    };
  } catch (err) {
    return {ok: false, currentVersion, latestVersion: currentVersion, hasUpdate: false, error: err.message || 'NETWORK_UNAVAILABLE', releaseUrl: `https://github.com/${repo}/releases`};
  }
}
