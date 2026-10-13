const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { STORAGE } = require('../dist/config/storage');
const { DesignFile, ParsedLayer } = require('../dist/models');
const { runStagedParser } = require('../dist/services/parser/parserExecution');
const { parsePsd } = require('../dist/services/parser/psdParser');

const sourceDirectory = path.resolve(__dirname, '../uploads/originals');
const samples = ['ff207657-7401-449c-85d6-a2879a11ed9d.psd', '1cf75695-1a1e-4255-83b0-f3ff8cea49fd.psd', '90fdba59-10d7-4a43-a800-1b8a90125689.psd', 'ad1aba0e-e01a-4ad1-9932-8501cd1f0fe8.psd'];

test('available local PSD regressions stage isolated masks, semantic layers and full composite previews', {
  skip: !samples.every(name => fs.existsSync(path.join(sourceDirectory, name))),
}, async t => {
  const configuredOutput = process.env.PSD_REAL_SAMPLE_OUTPUT;
  const root = configuredOutput ? path.resolve(configuredOutput) : fs.mkdtempSync(path.join(os.tmpdir(), 'benlai-psd-regression-'));
  fs.mkdirSync(root, { recursive: true });
  const originalBase = STORAGE.base;
  const originalFind = DesignFile.findByPk;
  const originalCreate = ParsedLayer.create;
  const originalDestroy = ParsedLayer.destroy;
  STORAGE.base = root;
  ParsedLayer.create = async () => { throw new Error('Live layer insert attempted'); };
  ParsedLayer.destroy = async () => { throw new Error('Live layer deletion attempted'); };
  t.after(() => {
    STORAGE.base = originalBase; DesignFile.findByPk = originalFind;
    ParsedLayer.create = originalCreate; ParsedLayer.destroy = originalDestroy;
    if (!configuredOutput) {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('benlai-psd-regression-'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const manifest = { storageBase: root, samples: [] };
  for (let index = 0; index < samples.length; index++) {
    const sourceFilename = samples[index], fileId = 50_001 + index;
    const file = { id: fileId, name: sourceFilename, filePath: path.join(sourceDirectory, sourceFilename), set(patch) { Object.assign(this, patch); }, update() { throw new Error('Live file update attempted'); } };
    DesignFile.findByPk = async () => file;
    const artifactDirectory = `parsed/${fileId}/${randomUUID()}`;
    const result = await runStagedParser(fileId, artifactDirectory, () => parsePsd(fileId));
    assert.equal(result.parseResult.hasErrors, false, sourceFilename);
    assert.ok(result.layers.length > 0);
    assert.ok(fs.existsSync(path.join(root, result.parseResult.compositePath)));
    for (const layer of result.layers) {
      assert.equal(layer.properties.inheritedGroupMaskCount, undefined);
      assert.equal(layer.properties.maskBakedIntoRaster, undefined);
      if (layer.imagePath) assert.ok(layer.imagePath.startsWith(`${artifactDirectory}/`));
      if (layer.properties.psdMask) assert.ok(fs.existsSync(path.join(root, layer.properties.psdMask.imagePath)));
    }
    const manifestPath = path.join(root, artifactDirectory, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(result, null, 2));
    manifest.samples.push({ sourceFilename, fileId, artifactDirectory, manifestPath, compositePath: result.parseResult.compositePath, layerCount: result.layers.length, exportedImageCount: result.parseResult.exportedImageCount, exportedMaskCount: result.parseResult.exportedMaskCount, diagnostics: result.parseResult.diagnostics });
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (configuredOutput) t.diagnostic(`PSD regression manifest: ${path.join(root, 'manifest.json')}`);
});
