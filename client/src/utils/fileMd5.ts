const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = Array.from({ length: 64 }, (_, index) => (
  Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
));

function rotateLeft(value: number, bits: number) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function wordToHex(value: number) {
  let output = '';
  for (let index = 0; index < 4; index += 1) {
    output += ((value >>> (index * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return output;
}

class Md5 {
  private a = 0x67452301;
  private b = 0xefcdab89;
  private c = 0x98badcfe;
  private d = 0x10325476;
  private bytes = 0;
  private buffer = new Uint8Array(0);

  append(input: Uint8Array) {
    this.bytes += input.byteLength;
    let data = input;

    if (this.buffer.byteLength > 0) {
      data = new Uint8Array(this.buffer.byteLength + input.byteLength);
      data.set(this.buffer, 0);
      data.set(input, this.buffer.byteLength);
      this.buffer = new Uint8Array(0);
    }

    const processLength = data.byteLength - (data.byteLength % 64);
    for (let offset = 0; offset < processLength; offset += 64) {
      this.processBlock(data, offset);
    }

    if (processLength < data.byteLength) {
      this.buffer = data.slice(processLength);
    }
  }

  end() {
    const padLength = this.buffer.byteLength < 56
      ? 56 - this.buffer.byteLength
      : 120 - this.buffer.byteLength;
    const finalBlock = new Uint8Array(this.buffer.byteLength + padLength + 8);
    finalBlock.set(this.buffer, 0);
    finalBlock[this.buffer.byteLength] = 0x80;

    const bitLow = (this.bytes << 3) >>> 0;
    const bitHigh = Math.floor(this.bytes / 0x20000000) >>> 0;
    const view = new DataView(finalBlock.buffer);
    view.setUint32(finalBlock.byteLength - 8, bitLow, true);
    view.setUint32(finalBlock.byteLength - 4, bitHigh, true);

    for (let offset = 0; offset < finalBlock.byteLength; offset += 64) {
      this.processBlock(finalBlock, offset);
    }

    return [this.a, this.b, this.c, this.d].map(wordToHex).join('');
  }

  private processBlock(data: Uint8Array, offset: number) {
    const words = new Uint32Array(16);
    for (let index = 0; index < 16; index += 1) {
      const pos = offset + index * 4;
      words[index] = (
        data[pos]
        | (data[pos + 1] << 8)
        | (data[pos + 2] << 16)
        | (data[pos + 3] << 24)
      ) >>> 0;
    }

    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;

      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }

      const temp = d;
      d = c;
      c = b;
      b = (b + rotateLeft((a + (f >>> 0) + K[index] + words[g]) >>> 0, S[index])) >>> 0;
      a = temp;
    }

    this.a = (this.a + a) >>> 0;
    this.b = (this.b + b) >>> 0;
    this.c = (this.c + c) >>> 0;
    this.d = (this.d + d) >>> 0;
  }
}

export function md5Bytes(bytes: Uint8Array) {
  const md5 = new Md5();
  md5.append(bytes);
  return md5.end();
}

export async function calculateFileMd5(
  file: File,
  onProgress?: (percent: number) => void,
  readChunkSize = 2 * 1024 * 1024,
) {
  const md5 = new Md5();
  if (file.size === 0) {
    onProgress?.(100);
    return md5.end();
  }

  for (let start = 0; start < file.size; start += readChunkSize) {
    const end = Math.min(start + readChunkSize, file.size);
    const buffer = await file.slice(start, end).arrayBuffer();
    md5.append(new Uint8Array(buffer));
    onProgress?.(Math.round((end / file.size) * 100));
  }

  return md5.end();
}
