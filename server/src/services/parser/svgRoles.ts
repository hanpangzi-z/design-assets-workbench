import fs from 'fs';

export type SvgObjectRole =
  | 'editable-vector'
  | 'editable-raster'
  | 'visual-raster'
  | 'text-outline'
  | 'raster-reconstruction-strip'
  | 'mask-artifact'
  | 'decoration-vector'
  | 'decoration-gradient-strip'
  | 'decoration-texture-fill'
  | 'decoration-effect-raster'
  | 'preview-fallback';

export interface SvgRoleStats {
  editableVectorCount: number;
  decorationVectorCount: number;
  editableRasterCount: number;
  visualOnlyCount: number;
}

export function countSvgObjectRoleStats(svgPath: string): SvgRoleStats {
  const stats: SvgRoleStats = {
    editableVectorCount: 0,
    decorationVectorCount: 0,
    editableRasterCount: 0,
    visualOnlyCount: 0,
  };
  if (!fs.existsSync(svgPath)) return stats;

  const svg = fs.readFileSync(svgPath, 'utf8');
  for (const match of svg.matchAll(/\bdata-object-role=["']([^"']+)["']/gi)) {
    switch (match[1] as SvgObjectRole) {
      case 'editable-vector':
        stats.editableVectorCount++;
        break;
      case 'decoration-vector':
      case 'decoration-gradient-strip':
      case 'decoration-texture-fill':
      case 'decoration-effect-raster':
        stats.decorationVectorCount++;
        break;
      case 'editable-raster':
        stats.editableRasterCount++;
        break;
      case 'visual-raster':
      case 'text-outline':
      case 'raster-reconstruction-strip':
      case 'mask-artifact':
      case 'preview-fallback':
        stats.visualOnlyCount++;
        break;
      default:
        break;
    }
  }
  return stats;
}

export function isHiddenSvgObjectRole(role: SvgObjectRole): boolean {
  return role === 'mask-artifact' || role === 'raster-reconstruction-strip';
}
