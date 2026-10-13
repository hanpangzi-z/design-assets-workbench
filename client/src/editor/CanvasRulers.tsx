import { useEffect, useRef, type CSSProperties } from 'react';

interface RulerProps {
  orientation: 'horizontal' | 'vertical';
  /** display length in CSS px (canvas size × zoom) */
  displayLength: number;
  /** underlying canvas length in canvas px */
  canvasLength: number;
}

export const RULER_SIZE = 18;

const BG = '#fafaf9';
const BORDER = '#dcdcd6';
const TEXT = '#8a8e94';
const TICK = '#c8ccd1';

export default function CanvasRuler({ orientation, displayLength, canvasLength }: RulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    const ctx = element.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const thickness = RULER_SIZE;
    const widthPx = orientation === 'horizontal' ? displayLength : thickness;
    const heightPx = orientation === 'horizontal' ? thickness : displayLength;
    element.width = Math.max(1, Math.round(widthPx * dpr));
    element.height = Math.max(1, Math.round(heightPx * dpr));
    element.style.width = `${Math.max(1, widthPx)}px`;
    element.style.height = `${Math.max(1, heightPx)}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    if (orientation === 'horizontal') {
      ctx.beginPath();
      ctx.moveTo(0, thickness - 0.5);
      ctx.lineTo(widthPx, thickness - 0.5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(thickness - 0.5, 0);
      ctx.lineTo(thickness - 0.5, heightPx);
      ctx.stroke();
    }

    if (canvasLength <= 0) return;

    const zoom = displayLength / canvasLength;
    const step = pickTickStep(zoom);
    const labelStep = step * 5;

    ctx.fillStyle = TEXT;
    ctx.strokeStyle = TICK;
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';

    for (let value = 0; value <= canvasLength; value += step) {
      const pos = Math.round(value * zoom) + 0.5;
      const isLabel = value % labelStep === 0;
      const tickLen = isLabel ? thickness * 0.55 : thickness * 0.3;
      ctx.beginPath();
      if (orientation === 'horizontal') {
        ctx.moveTo(pos, thickness);
        ctx.lineTo(pos, thickness - tickLen);
      } else {
        ctx.moveTo(thickness, pos);
        ctx.lineTo(thickness - tickLen, pos);
      }
      ctx.stroke();

      if (isLabel) {
        const label = String(value);
        if (orientation === 'horizontal') {
          ctx.fillText(label, pos + 2, 2);
        } else {
          ctx.save();
          ctx.translate(2, pos + 2);
          ctx.rotate(-Math.PI / 2);
          ctx.fillText(label, -ctx.measureText(label).width, 0);
          ctx.restore();
        }
      }
    }
  }, [orientation, displayLength, canvasLength]);

  const style: CSSProperties = orientation === 'horizontal'
    ? { display: 'block', height: RULER_SIZE, width: Math.max(1, displayLength) }
    : { display: 'block', width: RULER_SIZE, height: Math.max(1, displayLength) };

  return <canvas ref={canvasRef} style={style} />;
}

function pickTickStep(zoom: number): number {
  if (zoom <= 0) return 100;
  const targetSpacing = 10;
  const rawStep = targetSpacing / zoom;
  const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  for (const candidate of candidates) {
    if (candidate >= rawStep) return candidate;
  }
  return candidates[candidates.length - 1];
}

export function RulerCorner() {
  return (
    <div
      style={{
        width: RULER_SIZE,
        height: RULER_SIZE,
        background: BG,
        borderRight: `1px solid ${BORDER}`,
        borderBottom: `1px solid ${BORDER}`,
      }}
    />
  );
}
