const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { ParsedLayer } = require('../dist/models');

function extractClone(relativePath, functionName, model) {
  const source = fs.readFileSync(path.join(__dirname, '../src', relativePath), 'utf8');
  const ast = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === functionName);
  assert.ok(declaration, 'The actual application clone function must be tested');
  const code = ts.transpileModule(declaration.getText(ast) + '\nexports.clone = ' + functionName + ';', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const api = {};
  vm.runInNewContext(code, { exports: api, ParsedLayer: model });
  return api.clone;
}

for (const [relativePath, functionName] of [
  ['services/parser/parseOrchestrator.ts', 'cloneLayers'],
  ['controllers/fileController.ts', 'cloneParsedLayers'],
]) {
  test(functionName + ' preserves source models and sends only copy ownership to real SQL field mapping', async t => {
    // Importing models/index above installs the duplicate aliases added by associations.
    const sourceRows = [
      ParsedLayer.build({ id: 101, fileId: 6410, file_id: 6410, layerType: 'group', parentLayerId: null, parent_layer_id: null }),
      ParsedLayer.build({ id: 102, fileId: 6410, file_id: 6410, layerType: 'group', parentLayerId: 101, parent_layer_id: 101 }),
      ParsedLayer.build({ id: 103, fileId: 6410, file_id: 6410, layerType: 'image', parentLayerId: 102, parent_layer_id: 102,
        imagePath: 'parsed/6410/leaf.png', properties: { source: 'regression' } }),
    ];
    assert.equal(sourceRows[0].get({ plain: true }), sourceRows[0].dataValues);
    assert.equal(sourceRows[0].get({ plain: true }).file_id, 6410);
    assert.equal(sourceRows[2].get({ plain: true }).parent_layer_id, 102);
    const original = sourceRows.map(layer => structuredClone(layer.dataValues));
    const queryInterface = ParsedLayer.sequelize.getQueryInterface();
    const originalInsert = queryInterface.insert;
    t.after(() => { queryInterface.insert = originalInsert; });
    const inserts = [];
    let nextId = 2000;
    let expected;
    queryInterface.insert = async (instance, table, fields) => {
      // Real Model.create/save maps camelCase attributes to these SQL column names.
      assert.equal(fields.file_id, expected.fileId);
      assert.equal(fields.parent_layer_id, expected.parentLayerId);
      const id = ++nextId;
      inserts.push({ ...fields, id });
      instance.setDataValue('id', id);
      return [instance, 1];
    };
    const clone = extractClone(relativePath, functionName, {
      findAll: async () => sourceRows,
      async create(values, options) {
        assert.equal(Object.hasOwn(values, 'file_id'), false);
        assert.equal(Object.hasOwn(values, 'parent_layer_id'), false);
        expected = { fileId: values.fileId, parentLayerId: values.parentLayerId };
        return ParsedLayer.create(values, options);
      },
    });
    for (const copyId of [6411, 6412]) {
      await clone(6410, copyId);
      const rows = inserts.filter(row => row.file_id === copyId);
      assert.equal(rows.length, 3);
      const parent = rows.find(row => row.parent_layer_id === null);
      const group = rows.find(row => row.parent_layer_id === parent.id);
      const child = rows.find(row => row.parent_layer_id === group.id);
      assert.equal(child.layer_type, 'image');
      assert.equal(child.image_path, 'parsed/6410/leaf.png');
      assert.ok(rows.every(row => row.parent_layer_id === null || rows.some(candidate => candidate.id === row.parent_layer_id)));
    }
    assert.deepEqual(sourceRows.map(layer => structuredClone(layer.dataValues)), original);
    assert.equal(inserts.length, 6);
    assert.equal(inserts.some(row => row.file_id === 6410), false);
  });
}
