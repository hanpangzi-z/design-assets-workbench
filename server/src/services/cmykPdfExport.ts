import fs from 'fs';
import path from 'path';
import { deflateSync } from 'zlib';
import sharp from 'sharp';

type CmykProfile = {
  transform: string;
  bytes: Buffer;
  label: string;
};

type ExportCmykPdfInput = {
  png: Buffer;
  pageWidth: number;
  pageHeight: number;
  title: string;
};

let profilePromise: Promise<CmykProfile> | null = null;

export async function exportPngToCmykPdf(input: ExportCmykPdfInput) {
  const profile = await getCmykProfile();
  const converted = await sharp(input.png, {
    failOn: 'error',
    limitInputPixels: 100_000_000,
  })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .withIccProfile(profile.transform, { attach: false })
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (converted.info.channels !== 4) {
    throw new Error(`CMYK conversion returned ${converted.info.channels} channels instead of 4`);
  }

  return {
    pdf: buildCmykPdf({
      title: input.title,
      pageWidth: input.pageWidth,
      pageHeight: input.pageHeight,
      imageWidth: converted.info.width,
      imageHeight: converted.info.height,
      cmykBytes: converted.data,
      iccBytes: profile.bytes,
      profileLabel: profile.label,
    }),
    profileLabel: profile.label,
  };
}

async function getCmykProfile(): Promise<CmykProfile> {
  if (!profilePromise) profilePromise = resolveCmykProfile();
  return profilePromise;
}

async function resolveCmykProfile(): Promise<CmykProfile> {
  const configured = process.env.CMYK_ICC_PROFILE_PATH?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    const stat = await fs.promises.stat(resolved).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`CMYK_ICC_PROFILE_PATH does not point to a readable file: ${resolved}`);
    }
    return {
      transform: resolved,
      bytes: await fs.promises.readFile(resolved),
      label: path.basename(resolved),
    };
  }

  // Do not silently pick an arbitrary OS printer profile. A profile such as
  // RSWOP may exist on Windows but can be a poor match for the target press,
  // causing a much larger colour shift than the CMYK conversion itself.
  const bytes = await getSharpBuiltinCmykProfile();
  return { transform: 'cmyk', bytes, label: 'Benlai Generic CMYK (perceptual)' };
}

async function getSharpBuiltinCmykProfile(): Promise<Buffer> {
  const profiledTiff = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .withIccProfile('cmyk', { attach: true })
    .tiff()
    .toBuffer();
  const metadata = await sharp(profiledTiff).metadata();
  if (!metadata.icc?.length) throw new Error('Sharp did not expose its built-in CMYK profile');
  return Buffer.from(metadata.icc);
}

function buildCmykPdf(input: {
  title: string;
  pageWidth: number;
  pageHeight: number;
  imageWidth: number;
  imageHeight: number;
  cmykBytes: Buffer;
  iccBytes: Buffer;
  profileLabel: string;
}): Buffer {
  const compressedImage = deflateSync(input.cmykBytes, { level: 6 });
  const content = Buffer.from(
    `q\n/Perceptual ri\n${formatNumber(input.pageWidth)} 0 0 ${formatNumber(input.pageHeight)} 0 0 cm\n/Im0 Do\nQ\n`,
    'ascii'
  );
  const objects: Buffer[] = [];

  objects[1] = ascii('<< /Type /Catalog /Pages 2 0 R /OutputIntents [7 0 R] >>');
  objects[2] = ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects[3] = ascii(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatNumber(input.pageWidth)} ${formatNumber(input.pageHeight)}] `
      + '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'
  );
  objects[4] = streamObject(
    `<< /Type /XObject /Subtype /Image /Width ${input.imageWidth} /Height ${input.imageHeight} `
      + '/ColorSpace [/ICCBased 6 0 R] /BitsPerComponent 8 /Filter /FlateDecode '
      + `/Length ${compressedImage.length} >>`,
    compressedImage
  );
  objects[5] = streamObject(`<< /Length ${content.length} >>`, content);
  objects[6] = streamObject(
    `<< /N 4 /Alternate /DeviceCMYK /Length ${input.iccBytes.length} >>`,
    input.iccBytes
  );
  objects[7] = ascii(
    '<< /Type /OutputIntent /S /GTS_PDFX '
      + `/OutputConditionIdentifier ${pdfString(input.profileLabel)} `
      + `/Info ${pdfString(input.profileLabel)} `
      + '/RegistryName (http://www.color.org) /DestOutputProfile 6 0 R >>'
  );
  objects[8] = ascii(
    `<< /Title ${pdfUtf16String(input.title)} /Producer (Benlai Asset Editor ICC CMYK Export) `
      + '/Creator (Benlai Asset Editor) >>'
  );

  const chunks: Buffer[] = [Buffer.from('%PDF-1.6\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = new Array<number>(objects.length).fill(0);
  let byteOffset = chunks[0].length;
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = byteOffset;
    const object = Buffer.concat([
      Buffer.from(`${id} 0 obj\n`, 'ascii'),
      objects[id],
      Buffer.from('\nendobj\n', 'ascii'),
    ]);
    chunks.push(object);
    byteOffset += object.length;
  }

  const xrefOffset = byteOffset;
  const xrefRows = ['xref', `0 ${objects.length}`, '0000000000 65535 f '];
  for (let id = 1; id < objects.length; id += 1) {
    xrefRows.push(`${String(offsets[id]).padStart(10, '0')} 00000 n `);
  }
  chunks.push(Buffer.from(
    `${xrefRows.join('\n')}\ntrailer\n<< /Size ${objects.length} /Root 1 0 R /Info 8 0 R >>\n`
      + `startxref\n${xrefOffset}\n%%EOF\n`,
    'ascii'
  ));
  return Buffer.concat(chunks);
}

function streamObject(dictionary: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${dictionary}\nstream\n`, 'ascii'),
    bytes,
    Buffer.from('\nendstream', 'ascii'),
  ]);
}

function ascii(value: string): Buffer {
  return Buffer.from(value, 'ascii');
}

function pdfString(value: string): string {
  return `(${value.replace(/([\\()])/g, '\\$1').replace(/[\r\n]+/g, ' ')})`;
}

function pdfUtf16String(value: string): string {
  const bytes = Buffer.alloc(2 + value.length * 2);
  bytes.writeUInt16BE(0xFEFF, 0);
  for (let index = 0; index < value.length; index += 1) {
    bytes.writeUInt16BE(value.charCodeAt(index), 2 + index * 2);
  }
  return `<${bytes.toString('hex').toUpperCase()}>`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}
