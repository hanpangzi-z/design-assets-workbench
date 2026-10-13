import { useLayoutEffect, useRef, useState } from 'react';
import type { DesignFile } from 'shared/types';
import { appendAssetVersion, normalizeUploadAssetPath } from '@/utils/assetPreview';

const PALETTES: Record<string, { bg: string; fg: string }> = {
  teal: { bg: 'linear-gradient(135deg, var(--brand-teal-50), var(--brand-teal-100))', fg: 'var(--brand-teal-600)' },
  vermilion: { bg: 'linear-gradient(135deg, var(--brand-vermilion-50), var(--brand-vermilion-100))', fg: 'var(--brand-vermilion-600)' },
  paper: { bg: 'linear-gradient(135deg, var(--n-50), var(--n-100))', fg: 'var(--n-500)' },
  ink: { bg: 'linear-gradient(135deg, var(--n-700), var(--n-800))', fg: 'var(--n-200)' },
  warm: { bg: 'linear-gradient(135deg, #FAF1DF, #FDF9EE)', fg: 'var(--n-600)' },
  dots: { bg: 'linear-gradient(135deg, var(--n-50), var(--n-100))', fg: 'var(--n-400)' },
};

const FONT_TYPES = new Set(['ttf', 'otf', 'ttc', 'woff', 'woff2']);
const THUMBNAIL_VARIANT_WIDTHS = [240, 320, 480, 640, 960] as const;
const THUMBNAIL_VARIANT_ENDPOINT = '/api/v1/upload-thumbnails';

interface FontMeta {
  name?: string;
  family?: string;
  originalName?: string;
  aliases?: string[];
}

interface Props {
  thumbnailUrl?: string | null;
  fileType: string;
  label?: string;
  height?: number;
  file?: DesignFile;
  name?: string;
  showBadge?: boolean;
  safeBottom?: number;
  resourceCard?: boolean;
  displayWidth?: number;
  priority?: boolean;
  onIntrinsicSize?: (width: number, height: number) => void;
}

export default function Thumb({
  thumbnailUrl,
  fileType,
  label,
  height = 160,
  file,
  name,
  showBadge = true,
  safeBottom = 0,
  resourceCard = false,
  displayWidth,
  priority = false,
  onIntrinsicSize,
}: Props) {
  const type = fileType.toLowerCase();
  const [variantFailed, setVariantFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useLayoutEffect(() => {
    setVariantFailed(false);
    setImageFailed(false);
  }, [thumbnailUrl, file?.updatedAt]);

  if (isFontFileType(type) && !thumbnailUrl) {
    const font = getFontMeta(file);
    const displayName = cleanFontName(font?.name || name || file?.name || font?.family || 'Font');
    const fontFamily = buildFontFamily(font, displayName);
    const sampleText = `${displayName} Regular`;

    return (
      <div style={{
        height,
        background: 'var(--n-50)',
        border: '1px solid var(--border-2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <FontPreviewLine
          text={sampleText}
          fontFamily={fontFamily}
          fontSize={Math.max(28, Math.min(42, height * 0.18))}
        />
        {showBadge && <TypeBadge fileType={type} variant="light" />}
      </div>
    );
  }

  if (thumbnailUrl && !imageFailed) {
    const imagePadding = resourceCard ? 8 : getThumbnailPadding(height);
    const imageSafeBottom = resourceCard ? 0 : Math.max(0, safeBottom);
    const src = resolveThumbnailSrc(thumbnailUrl, file?.updatedAt || file?.id);
    const srcSet = variantFailed ? undefined : buildThumbnailSrcSet(thumbnailUrl, file?.updatedAt || file?.id);
    const altText = resourceCard ? name || file?.name || fileType : label || name || file?.name || fileType;

    return (
      <div style={{
        width: '100%',
        height,
        background: '#eef0f3',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute',
          top: imagePadding,
          right: imagePadding,
          bottom: imagePadding + imageSafeBottom,
          left: imagePadding,
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
        }}>
          <img
            src={src}
            srcSet={srcSet}
            sizes={srcSet ? displayWidth ? `${Math.max(1, displayWidth - imagePadding * 2)}px` : getThumbnailSizes(height) : undefined}
            alt={altText}
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            decoding="async"
            draggable={false}
            onLoad={event => onIntrinsicSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
            onError={(event) => {
              if (variantFailed) {
                setImageFailed(true);
                return;
              }
              const img = event.currentTarget;
              img.removeAttribute('srcset');
              img.removeAttribute('sizes');
              img.src = src;
              setVariantFailed(true);
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
        </div>
        {showBadge && <TypeBadge fileType={type} />}
      </div>
    );
  }

  const palette = PALETTES[getPalette(type)];
  const displayLabel = label || type.toUpperCase();
  const fallbackLabel = imageFailed ? '预览加载失败' : file?.parseStatus === 'pending' || file?.parseStatus === 'parsing' ? '解析中' : '暂无预览';

  return (
    <div role={resourceCard ? 'img' : undefined} aria-label={resourceCard ? `${fallbackLabel}：${name || file?.name || fileType}` : undefined} style={{
      height,
      background: palette.bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
    }}>
      <span style={{
        fontFamily: 'var(--font-serif)',
        fontSize: resourceCard ? 14 : 32,
        fontWeight: 700,
        color: palette.fg,
        opacity: 0.8,
      }}>
        {resourceCard ? fallbackLabel : displayLabel.slice(0, 3)}
      </span>
      {showBadge && <TypeBadge fileType={type} variant="light" color={palette.fg} />}
    </div>
  );
}

function FontPreviewLine({
  text,
  fontFamily,
  fontSize,
}: {
  text: string;
  fontFamily: string;
  fontSize: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const updateScale = () => {
      const wrapWidth = wrapRef.current?.clientWidth || 0;
      const textWidth = textRef.current?.scrollWidth || 0;
      if (!wrapWidth || !textWidth) return;
      setScale(Math.min(1, Math.max(0.18, (wrapWidth - 24) / textWidth)));
    };

    updateScale();
    const timers = [
      window.setTimeout(updateScale, 60),
      window.setTimeout(updateScale, 240),
    ];
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateScale)
      : null;
    if (wrapRef.current) resizeObserver?.observe(wrapRef.current);
    document.fonts?.ready?.then(updateScale).catch(() => {});

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      resizeObserver?.disconnect();
    };
  }, [fontFamily, fontSize, text]);

  return (
    <div
      ref={wrapRef}
      title={text}
      style={{
        width: '100%',
        padding: '0 12px',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        ref={textRef}
        style={{
          display: 'inline-block',
          flexShrink: 0,
          fontFamily,
          fontSize,
          fontWeight: 400,
          lineHeight: 1.1,
          color: '#111827',
          whiteSpace: 'nowrap',
          transform: `scale(${scale})`,
          transformOrigin: 'center',
        }}
      >
        {text}
      </span>
    </div>
  );
}

function TypeBadge({ fileType, variant = 'dark', color }: { fileType: string; variant?: 'dark' | 'light'; color?: string }) {
  return (
    <span style={{
      position: 'absolute',
      top: 8,
      left: 8,
      padding: '1px 6px',
      borderRadius: 3,
      background: variant === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)',
      color: variant === 'dark' ? '#fff' : (color || 'var(--fg-3)'),
      font: '500 10px var(--font-sans)',
      textTransform: 'uppercase',
    }}>
      {fileType}
    </span>
  );
}

function isFontFileType(fileType: string) {
  return FONT_TYPES.has(fileType.toLowerCase());
}

function getFontMeta(file?: DesignFile): FontMeta | undefined {
  const parseResult = file?.parseResult as { font?: FontMeta } | undefined;
  return parseResult?.font;
}

function buildFontFamily(font: FontMeta | undefined, fallbackName: string) {
  const names = [font?.family, font?.name, ...(font?.aliases || []), fallbackName, 'var(--font-sans)']
    .filter((value): value is string => Boolean(value));
  return names.map((value) => value.startsWith('var(') ? value : `"${value.replace(/"/g, '\\"')}"`).join(', ');
}

function cleanFontName(value: string) {
  return value.replace(/\.(ttf|otf|ttc|woff2?)$/i, '');
}

function getThumbnailPadding(height: number) {
  if (height >= 420) return 24;
  if (height >= 200) return 14;
  if (height >= 100) return 8;
  return 3;
}

function resolveThumbnailSrc(thumbnailUrl: string, version?: string | number | null) {
  const src = normalizeUploadAssetPath(thumbnailUrl);
  return appendAssetVersion(src, version);
}

function buildThumbnailSrcSet(thumbnailUrl: string, version?: string | number | null) {
  const src = normalizeUploadAssetPath(thumbnailUrl).split('?')[0];
  if (!canUseThumbnailVariant(src)) return undefined;

  const sourceToken = encodeThumbnailSource(src);
  const versionPath = version ? `/${encodeURIComponent(String(version))}` : '';
  return THUMBNAIL_VARIANT_WIDTHS
    .map((width) => `${THUMBNAIL_VARIANT_ENDPOINT}/${width}/${sourceToken}${versionPath} ${width}w`)
    .join(', ');
}

function encodeThumbnailSource(src: string) {
  return window.btoa(encodeURIComponent(src))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function canUseThumbnailVariant(src: string) {
  return (
    src.startsWith('/uploads/') &&
    !src.startsWith('/uploads/_thumb/') &&
    /\.(png|jpe?g|webp)$/i.test(src)
  );
}

function getThumbnailSizes(height: number) {
  if (height >= 420) return '(max-width: 900px) calc(100vw - 48px), 560px';
  if (height >= 200) return '(max-width: 900px) calc(50vw - 32px), 280px';
  if (height >= 100) return '(max-width: 900px) calc(33vw - 24px), 180px';
  return '96px';
}

function getPalette(fileType: string): string {
  const map: Record<string, string> = {
    ai: 'teal',
    psd: 'warm',
    svg: 'dots',
    png: 'paper',
    jpg: 'paper',
    pdf: 'vermilion',
    pptx: 'ink',
  };
  return map[fileType] || 'paper';
}
