const test = require('node:test');
const assert = require('node:assert/strict');
const { pdfSvgNeedsVisualBacking } = require('../dist/services/parser/pdfCairoRender');

test('ordinary PDF SVGs retain the preview-based 5% fidelity requirement', () => {
  assert.equal(pdfSvgNeedsVisualBacking({ svgVisualDiffRatio: .049 }), false);
  assert.equal(pdfSvgNeedsVisualBacking({ svgVisualDiffRatio: .051 }), true);
  assert.equal(pdfSvgNeedsVisualBacking({ svgVisualDiffRatio: NaN }), true);
  assert.equal(pdfSvgNeedsVisualBacking({ svgVisualReliable: false, svgVisualDiffRatio: 0 }), true);
  assert.equal(pdfSvgNeedsVisualBacking({ svgFidelityMethod: 'untrusted', svgVisualDiffRatio: .11 }), true);
});

test('Cairo drawing fidelity is explicit and keeps the preview diagnostic truthful', () => {
  const page = { svgFidelityMethod: 'cairo-source', svgSourceVisualDiffRatio: .001,
    svgVisualDiffRatio: .11, svgVisualReliable: true, svgElementCount: 44 };
  assert.equal(pdfSvgNeedsVisualBacking(page), false);
  assert.equal(page.svgVisualDiffRatio, .11);
  assert.equal(pdfSvgNeedsVisualBacking({ ...page, svgVisualReliable: false }), true);
  for (const value of [undefined, -1, .0051, NaN, Infinity]) {
    assert.equal(pdfSvgNeedsVisualBacking({ ...page, svgSourceVisualDiffRatio: value }), true);
  }
  assert.equal(pdfSvgNeedsVisualBacking({ ...page, svgElementCount: 1 }), true);
  assert.equal(pdfSvgNeedsVisualBacking({ ...page, svgElementCount: undefined }), true);
  for (const value of [NaN, Infinity, 2.5]) {
    assert.equal(pdfSvgNeedsVisualBacking({ ...page, svgElementCount: value }), true);
  }
  for (const value of [undefined, -1, 1.01, NaN, Infinity]) {
    assert.equal(pdfSvgNeedsVisualBacking({ ...page, svgVisualDiffRatio: value }), true);
  }
});
