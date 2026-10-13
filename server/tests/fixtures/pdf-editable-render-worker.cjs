const fs = require('node:fs');
const crypto = require('node:crypto');

process.on('message', input => {
  if (input.type !== 'start') return;
  fs.writeFileSync(input.outSvgPath + '.pid', String(process.pid));
  if (input.filePath === 'native-busy') {
    // A real synchronous native call prevents the child event loop from running timers.
    crypto.pbkdf2Sync('fixture', 'salt', 100_000_000, 32, 'sha256');
  }
  if (input.filePath === 'error') {
    process.send({ type: 'error', message: 'fixture rendering failed' }, () => process.exit(1));
    return;
  }
  const result = { width: input.filePath === 'invalid' ? 0 : 1600, height: 1000,
    textLayers: [], svgElementCount: 1, pageNumber: input.pageNumber };
  fs.writeFileSync(input.resultPath, JSON.stringify(result));
  process.send({ type: 'result', resultPath: input.resultPath }, () => {
    if (input.filePath === 'result-then-hang') { setInterval(() => {}, 1000); return; }
    process.disconnect();
    process.exit(0);
  });
});
