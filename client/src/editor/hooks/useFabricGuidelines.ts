import { useEffect } from 'react';
import type { Canvas } from 'fabric';
import { initAligningGuidelines } from 'fabric/extensions';

const GUIDE_COLOR = '#FF4D4F';

export default function useFabricGuidelines(canvas: Canvas | null) {
  useEffect(() => {
    if (!canvas) return;
    const dispose = initAligningGuidelines(canvas, {
      margin: 6,
      width: 1,
      color: GUIDE_COLOR,
    });
    return () => {
      dispose();
    };
  }, [canvas]);
}
