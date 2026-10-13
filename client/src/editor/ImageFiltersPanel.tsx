import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import * as fabric from 'fabric';

type FabricFilterLike = { type?: string; [key: string]: unknown };

type FilterValueKey = 'brightness' | 'contrast' | 'saturation' | 'hue' | 'blur';
type FilterToggleKey = 'grayscale' | 'sepia' | 'invert';

type FilterValueState = Record<FilterValueKey, number>;
type FilterToggleState = Record<FilterToggleKey, boolean>;

const VALUE_FILTER_NAMES: Record<FilterValueKey, string> = {
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  hue: 'HueRotation',
  blur: 'Blur',
};

const VALUE_FILTER_PROP: Record<FilterValueKey, string> = {
  brightness: 'brightness',
  contrast: 'contrast',
  saturation: 'saturation',
  hue: 'rotation',
  blur: 'blur',
};

const TOGGLE_FILTER_NAMES: Record<FilterToggleKey, string> = {
  grayscale: 'Grayscale',
  sepia: 'Sepia',
  invert: 'Invert',
};

const VALUE_FILTER_LABELS: Record<FilterValueKey, string> = {
  brightness: '亮度',
  contrast: '对比度',
  saturation: '饱和度',
  hue: '色相',
  blur: '模糊',
};

const VALUE_FILTER_RANGES: Record<FilterValueKey, { min: number; max: number; step: number }> = {
  brightness: { min: -1, max: 1, step: 0.01 },
  contrast: { min: -1, max: 1, step: 0.01 },
  saturation: { min: -1, max: 1, step: 0.01 },
  hue: { min: -1, max: 1, step: 0.01 },
  blur: { min: 0, max: 1, step: 0.01 },
};

const DEFAULT_VALUE_STATE: FilterValueState = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  blur: 0,
};

const DEFAULT_TOGGLE_STATE: FilterToggleState = {
  grayscale: false,
  sepia: false,
  invert: false,
};

interface Props {
  image: fabric.FabricImage;
  canvas: fabric.Canvas;
  /** changes whenever the active object changes; used to force re-sync state from filters */
  selectionKey: unknown;
}

export default function ImageFiltersPanel({ image, canvas, selectionKey }: Props) {
  const [values, setValues] = useState<FilterValueState>(DEFAULT_VALUE_STATE);
  const [toggles, setToggles] = useState<FilterToggleState>(DEFAULT_TOGGLE_STATE);
  const applyFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const filters = (image.filters || []) as unknown as Array<FabricFilterLike>;
    const nextValues = { ...DEFAULT_VALUE_STATE };
    const nextToggles = { ...DEFAULT_TOGGLE_STATE };
    for (const filter of filters) {
      const type = String((filter as { type?: string }).type || '');
      const valueKey = (Object.keys(VALUE_FILTER_NAMES) as FilterValueKey[]).find((k) => VALUE_FILTER_NAMES[k] === type);
      if (valueKey) {
        const prop = VALUE_FILTER_PROP[valueKey];
        const raw = (filter as Record<string, unknown>)[prop];
        if (typeof raw === 'number') nextValues[valueKey] = raw;
        continue;
      }
      const toggleKey = (Object.keys(TOGGLE_FILTER_NAMES) as FilterToggleKey[]).find((k) => TOGGLE_FILTER_NAMES[k] === type);
      if (toggleKey) nextToggles[toggleKey] = true;
    }
    setValues(nextValues);
    setToggles(nextToggles);
  }, [image, selectionKey]);

  useEffect(() => () => {
    if (applyFrameRef.current !== null) cancelAnimationFrame(applyFrameRef.current);
  }, []);

  const scheduleApply = useCallback((notifyChange = false) => {
    if (applyFrameRef.current !== null) cancelAnimationFrame(applyFrameRef.current);
    applyFrameRef.current = requestAnimationFrame(() => {
      applyFrameRef.current = null;
      try {
        image.applyFilters();
        canvas.requestRenderAll();
        if (notifyChange) canvas.fire('object:modified', { target: image });
      } catch (error) {
        console.error('[image filters] applyFilters failed:', error);
      }
    });
  }, [canvas, image]);

  const ensureValueFilter = useCallback((key: FilterValueKey, value: number): void => {
    const filters = (image.filters || []) as unknown as Array<FabricFilterLike>;
    const filterType = VALUE_FILTER_NAMES[key];
    const prop = VALUE_FILTER_PROP[key];
    const idx = filters.findIndex((filter) => String((filter as { type?: string }).type || '') === filterType);
    if (value === 0) {
      if (idx !== -1) {
        filters.splice(idx, 1);
        image.filters = filters as unknown as typeof image.filters;
      }
      return;
    }
    const FilterCtor = (fabric.filters as unknown as Record<string, new (options?: Record<string, unknown>) => FabricFilterLike>)[filterType];
    if (idx === -1) {
      const filter = new FilterCtor({ [prop]: value });
      filters.push(filter);
    } else {
      (filters[idx] as unknown as Record<string, unknown>)[prop] = value;
    }
    image.filters = filters as unknown as typeof image.filters;
  }, [image]);

  const ensureToggleFilter = useCallback((key: FilterToggleKey, on: boolean): void => {
    const filters = (image.filters || []) as unknown as Array<FabricFilterLike>;
    const filterType = TOGGLE_FILTER_NAMES[key];
    const idx = filters.findIndex((filter) => String((filter as { type?: string }).type || '') === filterType);
    if (!on) {
      if (idx !== -1) {
        filters.splice(idx, 1);
        image.filters = filters as unknown as typeof image.filters;
      }
      return;
    }
    if (idx !== -1) return;
    const FilterCtor = (fabric.filters as unknown as Record<string, new () => FabricFilterLike>)[filterType];
    filters.push(new FilterCtor());
    image.filters = filters as unknown as typeof image.filters;
  }, [image]);

  const handleValueChange = (key: FilterValueKey, value: number, commit: boolean) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    ensureValueFilter(key, value);
    scheduleApply(commit);
  };

  const handleToggleChange = (key: FilterToggleKey, on: boolean) => {
    setToggles((prev) => ({ ...prev, [key]: on }));
    ensureToggleFilter(key, on);
    scheduleApply(true);
  };

  const handleReset = () => {
    const filters = (image.filters || []) as unknown as Array<FabricFilterLike>;
    if (filters.length === 0 && allDefault(values, toggles)) return;
    image.filters = [] as unknown as typeof image.filters;
    setValues(DEFAULT_VALUE_STATE);
    setToggles(DEFAULT_TOGGLE_STATE);
    scheduleApply(true);
  };

  const isModified = useMemo(() => !allDefault(values, toggles), [values, toggles]);

  return (
    <div>
      <div style={headerStyle}>
        <span style={titleStyle}>滤镜</span>
        <button
          type="button"
          onClick={handleReset}
          disabled={!isModified}
          style={resetButtonStyle(!isModified)}
        >
          重置
        </button>
      </div>
      {(Object.keys(VALUE_FILTER_LABELS) as FilterValueKey[]).map((key) => (
        <SliderRow
          key={key}
          label={VALUE_FILTER_LABELS[key]}
          value={values[key]}
          range={VALUE_FILTER_RANGES[key]}
          formatValue={(v) => formatValue(key, v)}
          onChange={(v, commit) => handleValueChange(key, v, commit)}
        />
      ))}
      <div style={toggleRowStyle}>
        {(Object.keys(TOGGLE_FILTER_NAMES) as FilterToggleKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => handleToggleChange(key, !toggles[key])}
            style={toggleButtonStyle(toggles[key])}
          >
            {toggleLabel(key)}
          </button>
        ))}
      </div>
    </div>
  );
}

function allDefault(values: FilterValueState, toggles: FilterToggleState) {
  return (Object.keys(values) as FilterValueKey[]).every((k) => values[k] === 0)
    && (Object.keys(toggles) as FilterToggleKey[]).every((k) => !toggles[k]);
}

function toggleLabel(key: FilterToggleKey) {
  if (key === 'grayscale') return '灰度';
  if (key === 'sepia') return '棕褐';
  return '反相';
}

function formatValue(key: FilterValueKey, value: number) {
  if (key === 'hue') {
    return `${Math.round(value * 180)}°`;
  }
  if (key === 'blur') {
    return `${Math.round(value * 100)}%`;
  }
  return `${Math.round(value * 100)}`;
}

interface SliderRowProps {
  label: string;
  value: number;
  range: { min: number; max: number; step: number };
  formatValue: (v: number) => string;
  onChange: (value: number, commit: boolean) => void;
}

function SliderRow({ label, value, range, formatValue, onChange }: SliderRowProps) {
  return (
    <div style={sliderRowStyle}>
      <div style={sliderLabelLineStyle}>
        <span style={sliderLabelStyle}>{label}</span>
        <span style={sliderValueStyle}>{formatValue(value)}</span>
      </div>
      <input
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value), false)}
        onMouseUp={(e) => onChange(parseFloat((e.target as HTMLInputElement).value), true)}
        onTouchEnd={(e) => onChange(parseFloat((e.target as HTMLInputElement).value), true)}
        onKeyUp={(e) => onChange(parseFloat((e.target as HTMLInputElement).value), true)}
        style={sliderInputStyle}
      />
    </div>
  );
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 8,
};

const titleStyle: CSSProperties = {
  font: '700 12px var(--font-sans)',
  color: 'var(--fg-3)',
  letterSpacing: 0.4,
  textTransform: 'uppercase',
};

const sliderRowStyle: CSSProperties = {
  marginBottom: 10,
};

const sliderLabelLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 4,
};

const sliderLabelStyle: CSSProperties = {
  font: '500 12px var(--font-sans)',
  color: 'var(--fg-2)',
};

const sliderValueStyle: CSSProperties = {
  font: '500 12px var(--font-sans)',
  color: 'var(--fg-3)',
};

const sliderInputStyle: CSSProperties = {
  width: '100%',
  accentColor: '#2557f6',
};

const toggleRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 6,
  marginTop: 6,
};

function toggleButtonStyle(active: boolean): CSSProperties {
  return {
    height: 30,
    borderRadius: 6,
    border: `1px solid ${active ? '#2557f6' : 'var(--border-2)'}`,
    background: active ? 'rgba(37, 87, 246, 0.10)' : '#fff',
    color: active ? '#2557f6' : 'var(--fg-2)',
    font: '600 12px var(--font-sans)',
    cursor: 'pointer',
  };
}

function resetButtonStyle(disabled: boolean): CSSProperties {
  return {
    height: 24,
    padding: '0 10px',
    borderRadius: 5,
    border: '1px solid var(--border-2)',
    background: '#fff',
    color: disabled ? 'var(--fg-5)' : 'var(--fg-2)',
    font: '500 12px var(--font-sans)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}
