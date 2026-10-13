import { fork, type ForkOptions } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import type { PdfEditableRenderOptions, PdfEditableRenderResult } from './aiParser';

export type PdfEditableRenderRequest = {
  filePath: string;
  outPngPath: string;
  outSvgPath: string;
  pageNumber: number;
  options: PdfEditableRenderOptions;
  resultPath: string;
};

export async function renderPdfEditableIsolated(
  filePath: string,
  outPngPath: string,
  outSvgPath: string,
  pageNumber = 1,
  renderOptions: PdfEditableRenderOptions = {},
  supervisorOptions: { timeoutMs?: number; workerPath?: string } = {},
): Promise<PdfEditableRenderResult> {
  const resultPath = outSvgPath + '.render-' + randomUUID() + '.json';
  const workerPath = supervisorOptions.workerPath
    || path.join(__dirname, 'pdfEditableRenderWorker' + (path.extname(__filename) === '.ts' ? '.ts' : '.js'));
  const execArgv = path.extname(workerPath) === '.ts' ? ['--import', pathToFileURL(require.resolve('tsx')).href] : [];
  try {
    return await new Promise<PdfEditableRenderResult>((resolve, reject) => {
      // Inherit the parser process group so its outer deadline also kills this stage.
      const forkOptions: ForkOptions & { windowsHide: boolean } = { execArgv, detached: false, windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: process.env };
      const child = fork(workerPath, [], forkOptions);
      let failure: Error | undefined;
      let receivedResult = false;
      let closing = false;
      const abort = (error: Error) => {
        if (closing || failure) return;
        failure = error;
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      };
      const timeoutMs = supervisorOptions.timeoutMs ?? renderOptions.operatorSvgTimeoutMs ?? 45_000;
      const timer = setTimeout(() => abort(new Error('PDF editable rendering timed out after ' + timeoutMs + 'ms')), timeoutMs);
      child.on('message', (message: any) => {
        if (failure || closing || !message || typeof message !== 'object') return;
        if (message.type === 'result' && message.resultPath === resultPath) receivedResult = true;
        if (message.type === 'error') abort(new Error(String(message.message || 'PDF editable rendering failed')));
      });
      child.on('error', abort);
      child.once('close', (code, signal) => {
        closing = true;
        clearTimeout(timer);
        void (async () => {
          if (failure) throw failure;
          if (code !== 0 || signal || !receivedResult) throw new Error('PDF editable renderer exited without a completed result');
          const result = JSON.parse(await fs.readFile(resultPath, 'utf8')) as PdfEditableRenderResult;
          if (!Number.isFinite(result.width) || result.width <= 0 || !Number.isFinite(result.height) || result.height <= 0
            || !Array.isArray(result.textLayers) || !Number.isFinite(result.svgElementCount) || result.svgElementCount < 0) {
            throw new Error('PDF editable renderer returned an invalid result');
          }
          resolve(result);
        })().catch(reject);
      });
      const input: PdfEditableRenderRequest = { filePath, outPngPath, outSvgPath, pageNumber, options: renderOptions, resultPath };
      child.send({ type: 'start', ...input }, (error: Error | null) => { if (error) abort(error); });
    });
  } finally {
    await fs.rm(resultPath, { force: true }).catch(() => undefined);
  }
}
