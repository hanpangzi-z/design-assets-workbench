import fs from 'fs/promises';
import { renderWithPdfjs } from './aiParser';
import type { PdfEditableRenderRequest } from './pdfEditableRenderSupervisor';

let started = false;
function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) return reject(new Error('PDF renderer supervisor disconnected'));
    process.send(message, (error: Error | null) => error ? reject(error) : resolve());
  });
}

async function execute(input: PdfEditableRenderRequest): Promise<void> {
  let exitCode = 0;
  try {
    // Rendering reads source files and writes artifacts; it never writes parser database state.
    const result = await renderWithPdfjs(input.filePath, input.outPngPath, input.outSvgPath, input.pageNumber, input.options);
    await fs.writeFile(input.resultPath, JSON.stringify(result), { encoding: 'utf8', mode: 0o600 });
    await send({ type: 'result', resultPath: input.resultPath });
  } catch (error) {
    exitCode = 1;
    try { await send({ type: 'error', message: (error as Error)?.message || String(error) }); }
    catch { /* The supervisor rejects disconnected renderers. */ }
  } finally {
    if (process.connected) process.disconnect();
    process.exit(exitCode);
  }
}

process.on('message', (message: any) => {
  if (started || !message || message.type !== 'start') return;
  started = true;
  void execute(message);
});
process.on('disconnect', () => { process.exit(1); });
