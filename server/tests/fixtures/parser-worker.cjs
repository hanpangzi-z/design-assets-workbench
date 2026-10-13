const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
let input;
let assist;
function finish(code = 0) {
  fs.writeFileSync(input.resultPath, JSON.stringify({ parseStatus: 'completed', parseResult: { fixture: true, assist, previewRemoved: !input.clientAssistSnapshot?.previewDataUrl } }));
  process.send({ type: 'result', resultPath: input.resultPath }, () => { process.disconnect(); process.exit(code); });
}
process.on('message', message => {
  if (message.type === 'assist-update') { assist = message.snapshot; return; }
  if (message.type !== 'start') return;
  input = message; assist = message.clientAssistSnapshot;
  if (input.fileId === 2) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(path.join(path.dirname(input.resultPath), 'descendant.pid'), String(child.pid));
    while (true) {} // Real synchronous event-loop block in a real child.
  }
  if (input.fileId === 3) { process.send({ type: 'error', message: 'fixture throw' }, () => process.exit(1)); return; }
  if (input.fileId === 4) { process.exit(0); return; }
  if (input.fileId === 5) { finish(1); return; }
  if (input.fileId === 6) { setTimeout(() => finish(), 150); return; }
  if (input.fileId === 7) { fs.writeFileSync(input.resultPath, '{}'); process.send({ type: 'result', resultPath: input.resultPath }, () => process.exit(0)); return; }
  if (input.fileId === 8) {
    fs.writeFileSync(input.resultPath, JSON.stringify({ parseStatus: 'completed', parseResult: { fixture: true } }));
    process.send({ type: 'result', resultPath: input.resultPath }, () => {
      fs.writeFileSync(path.join(path.dirname(input.resultPath), 'result-sent'), 'yes');
      process.disconnect();
      setTimeout(() => process.exit(0), 150);
    });
    return;
  }
  finish();
});
