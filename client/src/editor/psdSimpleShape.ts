import * as fabric from 'fabric';
import type { ParsedLayer } from 'shared/types';
import { number, opacity, psdColor, unit, type PsdRecord } from './psdScenePixels';

/** Only original primitive metadata is evidence of a primitive. Never guess from four knots. */
export function createPsdSimpleShape(layer: ParsedLayer): fabric.FabricObject | null {
  const properties = layer.properties || {};
  const descriptors = (properties.psdVectorOrigination as PsdRecord | undefined)?.keyDescriptorList;
  const fill = properties.vectorFill as PsdRecord | undefined;
  const stroke = properties.vectorStroke as PsdRecord | undefined;
  if (!Array.isArray(descriptors) || descriptors.length !== 1 || fill?.type !== 'color' || stroke?.strokeEnabled) return null;
  if (number(properties.vectorMaskFeather) > 0 || number(properties.vectorMaskDensity, 1) < 1) return null;
  if (properties.psdIntrinsicVectorMaskBaked) return null;
  // Old metadata with one inseparable vector/user mask is kept as raw pixels.
  if (properties.psdMask && !properties.psdMaskIncludesVectorGeometry) return null;
  const descriptor = descriptors[0];
  if (descriptor.keyShapeInvalidated || ![1, 2, 5].includes(descriptor.keyOriginType)) return null;
  const box = descriptor.keyOriginShapeBoundingBox, color = psdColor(fill.color);
  if (!box || !color) return null;
  const left = unit(box.left, NaN), top = unit(box.top, NaN), width = unit(box.right, NaN) - left, height = unit(box.bottom, NaN) - top;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const corners = descriptor.keyOriginBoxCorners;
  if (Array.isArray(corners) && corners.length === 4 && corners.some((point: PsdRecord) =>
    Math.min(Math.abs(number(point.x) - left), Math.abs(number(point.x) - left - width)) > 0.01
    || Math.min(Math.abs(number(point.y) - top), Math.abs(number(point.y) - top - height)) > 0.01)) return null;
  const radii = descriptor.keyOriginRRectRadii;
  const values = radii ? ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map((key) => unit(radii[key], NaN)) : [0, 0, 0, 0];
  if (values.some((value) => !Number.isFinite(value) || value < 0) || Math.max(...values) - Math.min(...values) > 0.01) return null;
  const options = { left, top, width, height, fill: `rgb(${color.map(Math.round).join(',')})`, strokeWidth: 0, opacity: opacity(layer.opacity), visible: layer.visible !== false, objectCaching: false, globalCompositeOperation: 'source-over' as const };
  const result = descriptor.keyOriginType === 5 ? new fabric.Ellipse({ ...options, rx: width / 2, ry: height / 2 }) : new fabric.Rect({ ...options, rx: values[0], ry: values[0] });
  (result as fabric.FabricObject & { _psdSimpleShape?: boolean })._psdSimpleShape = true;
  return result;
}
