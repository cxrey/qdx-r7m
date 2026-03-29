import { useState, useCallback, useEffect, useRef } from 'react';

const SLIDER_RESOLUTION = 1000;

/**
 * Logarithmic/cubic scale mapping for sliders with large ranges.
 * Maps a 0-SLIDER_RESOLUTION slider position to the actual value range using a cubic curve,
 * giving much more resolution at the low end.
 */
export function createScaleMapper(min, max, useLogScale) {
  if (!useLogScale) {
    // Linear mapping
    return {
      toSlider: (val) => Math.round(((val - min) / (max - min)) * SLIDER_RESOLUTION),
      fromSlider: (pos) => min + ((pos / SLIDER_RESOLUTION) * (max - min)),
    };
  }
  // Cubic mapping: more resolution at low end
  const range = max - min;
  return {
    toSlider: (val) => {
      const normalized = (val - min) / range; // 0-1
      return Math.round(Math.pow(normalized, 1 / 3) * SLIDER_RESOLUTION); // cube root
    },
    fromSlider: (pos) => {
      const normalized = pos / SLIDER_RESOLUTION; // 0-1
      return min + range * Math.pow(normalized, 3); // cube
    },
  };
}

/**
 * Smart rounding based on magnitude.
 */
export function smartRound(val, min, max) {
  const range = max - min;
  if (range <= 1000) return Math.round(val);

  // Large ranges (e.g., volume in dollars)
  const abs = Math.abs(val);
  if (abs < 10_000) return Math.round(val / 100) * 100;
  if (abs < 100_000) return Math.round(val / 1_000) * 1_000;
  if (abs < 1_000_000) return Math.round(val / 5_000) * 5_000;
  if (abs < 10_000_000) return Math.round(val / 25_000) * 25_000;
  return Math.round(val / 100_000) * 100_000;
}

export default function DualRangeSlider({
  label, min, max, value, onChange, displayFormat, logScale,
}) {
  const [lo, hi] = value;
  const useLog = logScale || (max - min > 100_000);

  const scaleRef = useRef(null);
  if (!scaleRef.current || scaleRef.current._min !== min || scaleRef.current._max !== max || scaleRef.current._log !== useLog) {
    scaleRef.current = { ...createScaleMapper(min, max, useLog), _min: min, _max: max, _log: useLog };
  }
  const scale = scaleRef.current;

  function fmt(v) {
    return displayFormat ? displayFormat(v) : String(v);
  }

  function parseRaw(text) {
    const cleaned = text.replace(/[^0-9.\-]/g, '');
    if (cleaned === '' || cleaned === '-') return NaN;
    return Number(cleaned);
  }

  function clampVal(v) {
    return Math.max(min, Math.min(max, v));
  }

  // --- Local text state for inputs (decoupled from shared filter state) ---
  const [loText, setLoText] = useState(() => fmt(lo));
  const [hiText, setHiText] = useState(() => fmt(hi));
  const [loFocused, setLoFocused] = useState(false);
  const [hiFocused, setHiFocused] = useState(false);
  const loDebounceRef = useRef(null);
  const hiDebounceRef = useRef(null);

  // Sync display text from parent value when NOT focused
  useEffect(() => {
    if (!loFocused) setLoText(fmt(lo));
  }, [lo, loFocused]);

  useEffect(() => {
    if (!hiFocused) setHiText(fmt(hi));
  }, [hi, hiFocused]);

  // Cleanup debounce timers
  useEffect(() => () => {
    if (loDebounceRef.current) clearTimeout(loDebounceRef.current);
    if (hiDebounceRef.current) clearTimeout(hiDebounceRef.current);
  }, []);

  // --- Commit functions (only called on blur/enter/debounce expiry) ---
  function commitLo(text) {
    let newLo = parseRaw(text);
    if (isNaN(newLo)) newLo = lo;
    newLo = clampVal(newLo);
    // Auto-swap if needed
    if (newLo > hi) {
      onChange([hi, newLo]);
    } else {
      onChange([newLo, hi]);
    }
  }

  function commitHi(text) {
    let newHi = parseRaw(text);
    if (isNaN(newHi)) newHi = hi;
    newHi = clampVal(newHi);
    // Auto-swap if needed
    if (newHi < lo) {
      onChange([newHi, lo]);
    } else {
      onChange([lo, newHi]);
    }
  }

  // --- Text input handlers ---
  const onLoTextChange = (e) => {
    const val = e.target.value;
    setLoText(val);
    // Schedule debounced commit for this field only
    if (loDebounceRef.current) clearTimeout(loDebounceRef.current);
    loDebounceRef.current = setTimeout(() => commitLo(val), 600);
  };

  const onHiTextChange = (e) => {
    const val = e.target.value;
    setHiText(val);
    if (hiDebounceRef.current) clearTimeout(hiDebounceRef.current);
    hiDebounceRef.current = setTimeout(() => commitHi(val), 600);
  };

  const onLoFocus = () => {
    setLoFocused(true);
    setLoText(String(lo));
  };
  const onHiFocus = () => {
    setHiFocused(true);
    setHiText(String(hi));
  };

  const onLoBlur = () => {
    if (loDebounceRef.current) { clearTimeout(loDebounceRef.current); loDebounceRef.current = null; }
    commitLo(loText);
    setLoFocused(false);
  };
  const onHiBlur = () => {
    if (hiDebounceRef.current) { clearTimeout(hiDebounceRef.current); hiDebounceRef.current = null; }
    commitHi(hiText);
    setHiFocused(false);
  };

  const onLoKeyDown = (e) => {
    if (e.key === 'Enter') {
      if (loDebounceRef.current) { clearTimeout(loDebounceRef.current); loDebounceRef.current = null; }
      commitLo(loText);
      e.target.blur();
    }
  };
  const onHiKeyDown = (e) => {
    if (e.key === 'Enter') {
      if (hiDebounceRef.current) { clearTimeout(hiDebounceRef.current); hiDebounceRef.current = null; }
      commitHi(hiText);
      e.target.blur();
    }
  };

  // --- Slider handlers ---
  // Sliders operate on 0-1000 internal scale, mapped through scale functions
  const sliderLo = scale.toSlider(lo);
  const sliderHi = scale.toSlider(hi);

  // Local slider state for instant visual feedback — parent onChange only on drag end
  const [localSliderLo, setLocalSliderLo] = useState(sliderLo);
  const [localSliderHi, setLocalSliderHi] = useState(sliderHi);
  const isDraggingRef = useRef(false);
  const localValueRef = useRef(value);

  // Sync local slider + ref from parent when not dragging
  useEffect(() => {
    if (!isDraggingRef.current) {
      setLocalSliderLo(scale.toSlider(lo));
      setLocalSliderHi(scale.toSlider(hi));
      localValueRef.current = [lo, hi];
    }
  }, [lo, hi, scale]);

  const onMinSlider = useCallback((e) => {
    const pos = parseInt(e.target.value);
    setLocalSliderLo(pos);
    isDraggingRef.current = true;
    let raw = scale.fromSlider(pos);
    raw = smartRound(raw, min, max);
    raw = clampVal(raw);
    const curHi = localValueRef.current[1];
    const newVal = [Math.min(raw, curHi), curHi];
    localValueRef.current = newVal;
    setLoText(fmt(newVal[0]));
  }, [min, max, scale]);

  const onMaxSlider = useCallback((e) => {
    const pos = parseInt(e.target.value);
    setLocalSliderHi(pos);
    isDraggingRef.current = true;
    let raw = scale.fromSlider(pos);
    raw = smartRound(raw, min, max);
    raw = clampVal(raw);
    const curLo = localValueRef.current[0];
    const newVal = [curLo, Math.max(raw, curLo)];
    localValueRef.current = newVal;
    setHiText(fmt(newVal[1]));
  }, [min, max, scale]);

  const handleDragEnd = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    onChange(localValueRef.current);
  }, [onChange]);

  const inputCls = "w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 text-center focus:outline-none focus:border-emerald-500 transition-colors";

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-1">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider shrink-0">
          {label}
        </label>
        <div className="flex items-center gap-1">
          <input type="text" value={loText} onChange={onLoTextChange}
            onFocus={onLoFocus} onBlur={onLoBlur} onKeyDown={onLoKeyDown}
            className={inputCls} />
          <span className="text-xs text-gray-600">—</span>
          <input type="text" value={hiText} onChange={onHiTextChange}
            onFocus={onHiFocus} onBlur={onHiBlur} onKeyDown={onHiKeyDown}
            className={inputCls} />
        </div>
      </div>
      <div className="relative mt-2">
        <input type="range" min={0} max={SLIDER_RESOLUTION} step={1} value={localSliderLo}
          onChange={onMinSlider} onMouseUp={handleDragEnd} onTouchEnd={handleDragEnd}
          className="w-full absolute" />
        <input type="range" min={0} max={SLIDER_RESOLUTION} step={1} value={localSliderHi}
          onChange={onMaxSlider} onMouseUp={handleDragEnd} onTouchEnd={handleDragEnd}
          className="w-full relative" style={{ marginTop: '12px' }} />
      </div>
    </div>
  );
}
