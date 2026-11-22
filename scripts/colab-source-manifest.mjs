// Builds reviewable Colab self-host candidates from the owner's model registry
// and the publisher download manifests. Read-only: it never downloads, uploads,
// starts Colab or edits K's private settings. Each candidate pins the
// publisher repository and revision; Colab is meant to download from there.
//
//   node scripts/colab-source-manifest.mjs <out.json> <registry.json> <manifest.json> [...]
//
// Weights must match both the registry SHA-256 and the publisher LFS SHA-256.
// Small non-LFS files are accepted only when the local copy's git blob id equals
// the publisher blobId; their SHA-256 is then computed from that local copy.
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';

const [out, registryPath, ...manifestPaths] = process.argv.slice(2);
if (!out || !registryPath || !manifestPaths.length) {
  console.error('用法：node scripts/colab-source-manifest.mjs <輸出.json> <模型清單.json> <來源清單.json> [...]');
  process.exit(2);
}
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const safeRelative = value =>
  typeof value === 'string' &&
  /^[\w.+-]+(?:\/[\w.+-]+)*$/u.test(value) &&
  !value.split('/').some(part => part === '.' || part === '..');
const registry = await readJson(registryPath);
const published = new Map();
for (const file of manifestPaths) for (const model of (await readJson(file)).models) published.set(model.id, model);

const relative = (weightPath, source) => {
  const parts = weightPath.split(/[\\/]/u),
    at = parts.lastIndexOf(source.revision);
  if (at < 2 || parts.slice(at - 2, at).join('/') !== source.repository)
    throw new Error(`權重路徑不在 ${source.repository}/${source.revision} 之下：${weightPath}`);
  return parts.slice(at + 1).join('/');
};

const candidates = [],
  excluded = [];
for (const entry of registry.models.filter(item => /^(cloud|x)-/u.test(item.id))) {
  try {
    const source = entry.source,
      publisher = published.get(entry.id);
    if (
      !/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/u.test(source?.repository ?? '') ||
      !safeRelative(source.repository) ||
      !/^[0-9a-f]{40}$/u.test(source?.revision ?? '')
    )
      throw new Error('發布來源需要合法倉庫與固定 revision');
    if (!publisher) throw new Error('找不到發布者下載清單');
    if (publisher.repository !== source.repository || publisher.revision !== source.revision)
      throw new Error('登錄表與下載清單的倉庫或 revision 不一致');
    // Check before reading any local asset: a manifest path must never escape
    // the pinned model directory, even if a matching git blob was supplied.
    if (
      !publisher.files.every(item => safeRelative(item.rfilename)) ||
      new Set(publisher.files.map(item => item.rfilename)).size !== publisher.files.length
    )
      throw new Error('發布者清單含無效或重複路徑');
    const dir = path.dirname(entry.weights[0].path);
    const files = [];
    for (const weight of entry.weights) {
      const rel = relative(weight.path, source),
        remote = publisher.files.find(item => item.rfilename === rel);
      if (!remote?.lfs || remote.lfs.sha256 !== weight.sha256 || remote.size !== weight.bytes)
        throw new Error(`權重 ${rel} 與發布者 LFS SHA-256／大小不一致`);
      files.push({path: rel, bytes: weight.bytes, sha256: weight.sha256, role: 'weight'});
    }
    for (const remote of publisher.files.filter(item => item.role === 'asset' && !/\.md$/iu.test(item.rfilename))) {
      if (files.some(item => item.path === remote.rfilename)) continue;
      if (remote.lfs) {
        files.push({path: remote.rfilename, bytes: remote.size, sha256: remote.lfs.sha256, role: 'asset'});
        continue;
      }
      const data = await readFile(path.join(dir, ...remote.rfilename.split('/')));
      const blob = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
      if (blob !== remote.blobId || data.length !== remote.size)
        throw new Error(`附件 ${remote.rfilename} 的本機副本與發布者 git blob 不一致`);
      files.push({
        path: remote.rfilename,
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        role: 'asset'
      });
    }
    const slug = entry.id.replace(/^(cloud|x)-/u, '');
    candidates.push({
      id: `colab-${slug}`,
      label: entry.name.replace(/（雲端候選）$/u, '').trim(),
      location: 'colab',
      model: slug,
      contextWindow: 32768,
      source: {
        registryId: entry.id,
        repository: source.repository,
        revision: source.revision,
        format: source.format,
        quantization: source.quantization,
        files,
        // Copied as-is: download integrity only, no Colab inference/Vision/MTP acceptance.
        registryStatus: entry.status,
        inferenceVerification: entry.inferenceVerification
      }
    });
  } catch (error) {
    excluded.push({registryId: entry.id, reason: String(error.message ?? error)});
  }
}
await mkdir(path.dirname(path.resolve(out)), {recursive: true});
await writeFile(
  out,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      registry: registryPath,
      manifests: manifestPaths,
      notice:
        '候選設定，未安裝到 K。只代表發布來源與逐檔校驗資訊齊全；全部未做 Colab 推論、Vision 或 MTP 驗收。Colab 控制未接通前，K 只會顯示「未設定」。',
      selfHosted: candidates,
      excluded
    },
    null,
    2
  ) + '\n'
);
console.log(JSON.stringify({out, candidates: candidates.length, excluded}));
