declare module 'opentype.js' {
  export type PathCommand =
    | { type: 'M'; x: number; y: number }
    | { type: 'L'; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | { type: 'Z' };

  export interface Path {
    commands: PathCommand[];
  }

  export interface Font {
    getPath(
      text: string,
      x: number,
      y: number,
      fontSize: number,
      options?: { kerning?: boolean; letterSpacing?: number; tracking?: number }
    ): Path;
    getAdvanceWidth?(
      text: string,
      fontSize: number,
      options?: { kerning?: boolean; letterSpacing?: number; tracking?: number }
    ): number;
    charToGlyphIndex?(text: string): number;
  }

  export function parse(buffer: ArrayBuffer): Font;

  const opentype: {
    parse(buffer: ArrayBuffer): Font;
  };

  export default opentype;
}
