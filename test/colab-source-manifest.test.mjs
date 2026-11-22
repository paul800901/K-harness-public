import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {scratchBase} from './scratch.mjs';

test('source candidates include pinned tokenizer/config/MTP assets and reject escaping manifest paths', async () => {
  const root = await mkdtemp(path.join(scratchBase, 'colab-source-'));
  const revision = 'a'.repeat(40),
    repository = 'publisher/model';
  const dir = path.join(root, repository, revision);
  await mkdir(dir, {recursive: true});
  const data = Buffer.from('{}');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const blobId = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  const assets = ['config.json', 'tokenizer.json', 'model.safetensors.index.json', 'preprocessor_config.json'];
  for (const asset of assets) await writeFile(path.join(dir, asset), data);
  const weights = ['model.safetensors', 'model-mtp.safetensors', 'mmproj.gguf'];
  const files = [
    ...weights.map(rfilename => ({rfilename, size: 2, lfs: {sha256}, role: 'weight'})),
    ...assets.map(rfilename => ({rfilename, size: 2, blobId, role: 'asset'}))
  ];
  const entry = {
    id: 'cloud-test',
    name: 'Test BF16',
    source: {repository, revision},
    weights: weights.map(file => ({path: path.join(dir, file), bytes: 2, sha256})),
    inferenceVerification: {productionAccepted: false}
  };
  const registry = path.join(root, 'registry.json'),
    manifest = path.join(root, 'manifest.json'),
    out = path.join(root, 'out.json');
  await writeFile(registry, JSON.stringify({models: [entry]}));
  const run = async publishedFiles => {
    await writeFile(manifest, JSON.stringify({models: [{id: entry.id, repository, revision, files: publishedFiles}]}));
    execFileSync(process.execPath, ['scripts/colab-source-manifest.mjs', out, registry, manifest], {windowsHide: true});
    return JSON.parse(await readFile(out, 'utf8'));
  };
  const valid = await run(files);
  assert.deepEqual(
    valid.selfHosted[0].source.files.map(file => file.path),
    [...weights, ...assets]
  );
  assert.equal(valid.selfHosted[0].source.inferenceVerification.productionAccepted, false);
  for (const bad of ['../outside.json', 'sub/../../outside.json', 'C:/outside.json']) {
    const rejected = await run([...files, {rfilename: bad, role: 'asset', size: 2, blobId}]);
    assert.equal(rejected.selfHosted.length, 0);
    assert.match(rejected.excluded[0].reason, /路徑/);
  }
});
