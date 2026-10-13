import { fork, execFile, type ChildProcess, type ForkOptions } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import type { ClientParseAssistSnapshot } from './clientParseAssist';
import type { ParserFinalPatch } from './parserExecution';

export type ParserWorkerInput = {
  fileId: number;
  resultPath: string;
  artifactDirectory?: string;
  clientAssistSnapshot?: ClientParseAssistSnapshot | null;
  allowClientAssistWait: boolean;
};
export type ParserWorkerRun = {
  result: Promise<ParserFinalPatch>;
  updateAssist(snapshot: ClientParseAssistSnapshot | null | undefined, allowWait: boolean): void;
  cancel(reason: string): Promise<void>;
  pid: number | undefined;
};

export async function terminateParserProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
    }
  }
}

function withoutPreviewData(snapshot: ClientParseAssistSnapshot | null | undefined) {
  if (!snapshot) return snapshot;
  const { previewDataUrl: _previewDataUrl, ...metadata } = snapshot;
  return metadata;
}

export function startParserWorker(
  input: ParserWorkerInput,
  options: { timeoutMs?: number; workerPath?: string; cwd?: string } = {},
): ParserWorkerRun {
  const workerPath = options.workerPath || path.join(__dirname, 'parserWorker' + (path.extname(__filename) === '.ts' ? '.ts' : '.js'));
  const execArgv = path.extname(workerPath) === '.ts' ? ['--import', pathToFileURL(require.resolve('tsx')).href] : [];
  const forkOptions: ForkOptions & { windowsHide: boolean } = {
    execArgv, cwd: options.cwd || process.cwd(), env: process.env,
    detached: process.platform !== 'win32', windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  };
  const child = fork(workerPath, [], forkOptions);
  let cancellation: Error | undefined;
  let workerError: Error | undefined;
  let receivedResult = false;
  let closing = false;
  let sendingAssist = false;
  let pendingAssist: { snapshot: ReturnType<typeof withoutPreviewData>; allowWait: boolean } | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const cancel = async (reason: string) => {
    if (!closing && !cancellation) {
      cancellation = new Error(reason);
      await terminateParserProcessTree(child);
    }
    await closed;
  };
  const timer = setTimeout(() => {
    void cancel('解析超时，任务已中止').catch(() => undefined);
  }, options.timeoutMs ?? 180_000);
  const result = new Promise<ParserFinalPatch>((resolve, reject) => {
    child.on('message', (message: any) => {
      if (cancellation || closing || !message || typeof message !== 'object') return;
      if (message.type === 'result' && message.resultPath === input.resultPath) receivedResult = true;
      if (message.type === 'error') workerError = new Error(String(message.message || '解析进程失败'));
    });
    child.on('error', (error) => {
      workerError = error;
      void cancel('解析进程通信或启动失败').catch(() => undefined);
    });
    child.once('close', (code, signal) => {
      closing = true;
      clearTimeout(timer);
      void (async () => {
        // Remove external renderers left behind in the Linux process group.
        if (process.platform !== 'win32') await terminateParserProcessTree(child);
        resolveClosed();
        if (cancellation || workerError || code !== 0 || signal || !receivedResult) {
          throw cancellation || workerError || new Error('解析进程异常退出或没有返回结果 (' + String(code ?? signal) + ')');
        }
        const patch = JSON.parse(await fs.readFile(input.resultPath, 'utf8')) as ParserFinalPatch;
        if (patch.parseStatus !== 'completed' || !patch.parseResult || typeof patch.parseResult !== 'object') {
          throw new Error('解析进程返回无效结果');
        }
        resolve(patch);
      })().catch(reject);
    });
    child.send({ type: 'start', ...input, clientAssistSnapshot: withoutPreviewData(input.clientAssistSnapshot) }, (error: Error | null) => {
      if (error) { workerError = error; void cancel('解析进程无法接收任务'); }
    });
  });
  const flushAssist = () => {
    if (sendingAssist || !pendingAssist || receivedResult || closing || cancellation || !child.connected) return;
    const update = pendingAssist;
    pendingAssist = undefined; sendingAssist = true;
    child.send({ type: 'assist-update', ...update }, (error: Error | null) => {
      sendingAssist = false;
      // Assist is optional; a normal IPC close after a result must not cancel success.
      if (!error) flushAssist();
    });
  };
  return {
    result, cancel, pid: child.pid,
    updateAssist(snapshot, allowWait) {
      if (receivedResult || closing || cancellation) return;
      pendingAssist = { snapshot: withoutPreviewData(snapshot), allowWait };
      flushAssist();
    },
  };
}
