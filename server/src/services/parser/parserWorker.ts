import fs from 'fs/promises';
import path from 'path';
import sequelize from '../../config/database';
import { parsePsd } from './psdParser';
import { parseAi } from './aiParser';
import { parsePdf } from './pdfParser';
import { DesignFile } from '../../models';
import { runStagedParser } from './parserExecution';
import type { ParserWorkerInput } from './parserWorkerSupervisor';
import type { ClientParseAssistSnapshot } from './clientParseAssist';

let started = false;
let snapshot: ClientParseAssistSnapshot | null | undefined;
let allowWait = false;

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error('Parser supervisor disconnected'));
    process.send(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}

async function execute(input: ParserWorkerInput): Promise<void> {
  let exitCode = 0;
  try {
    await sequelize.authenticate();
    const file = await DesignFile.findByPk(input.fileId);
    if (!file || file.isDeleted) throw new Error('待解析文件不存在或已删除');
    if (!input.artifactDirectory) throw new Error('解析任务缺少候选资源目录');
    const patch = await runStagedParser(input.fileId, input.artifactDirectory, async () => {
      const options = {
        clientAssistSnapshot: snapshot,
        getClientAssistSnapshot: () => snapshot,
        get allowClientAssistWait() { return allowWait; },
      };
      if (file.fileType === 'psd') await parsePsd(file.id);
      else if (file.fileType === 'ai') await parseAi(file.id, options);
      else if (file.fileType === 'pdf') await parsePdf(file.id, options);
      else throw new Error('不支持的解析格式');
    });
    await fs.mkdir(path.dirname(input.resultPath), { recursive: true });
    await fs.writeFile(input.resultPath, JSON.stringify(patch), { encoding: 'utf8', mode: 0o600 });
    await send({ type: 'result', resultPath: input.resultPath });
  } catch (error) {
    exitCode = 1;
    try { await send({ type: 'error', message: (error as Error)?.message || String(error) }); }
    catch { /* The supervisor handles a disconnected worker as failure. */ }
  } finally {
    try { await sequelize.close(); } catch { exitCode = 1; }
    if (process.connected) process.disconnect();
    process.exit(exitCode);
  }
}

process.on('message', (message: any) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'assist-update') {
    if (message.snapshot) snapshot = message.snapshot;
    if (message.allowWait) allowWait = true;
  } else if (message.type === 'start' && !started) {
    started = true; snapshot = message.clientAssistSnapshot;
    allowWait = Boolean(message.allowClientAssistWait);
    void execute(message);
  }
});
process.on('disconnect', () => { process.exit(1); });
