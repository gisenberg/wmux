import { useEffect, useRef, useState } from "react";

export function EmptyWorkspaceView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [settings, setSettings] = useState<LifeViewSettings>(defaultLifeViewSettings);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let shaderUnavailable = false;
    const markUnavailable = (event?: Event) => {
      event?.preventDefault();
      shaderUnavailable = true;
      canvas.classList.add("shader-unavailable");
    };
    const markAvailable = () => {
      shaderUnavailable = false;
      canvas.classList.remove("shader-unavailable");
    };
    canvas.addEventListener("webglcontextlost", markUnavailable);
    canvas.addEventListener("webglcontextrestored", markUnavailable);

    const gl = canvas.getContext("webgl", {
      antialias: false,
      alpha: false,
      depth: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      markUnavailable();
      return () => {
        canvas.removeEventListener("webglcontextlost", markUnavailable);
        canvas.removeEventListener("webglcontextrestored", markUnavailable);
      };
    }

    const program = createProgram(gl, vertexShaderSource, fragmentShaderSource);
    if (!program) {
      markUnavailable();
      return () => {
        canvas.removeEventListener("webglcontextlost", markUnavailable);
        canvas.removeEventListener("webglcontextrestored", markUnavailable);
      };
    }
    markAvailable();
    const positionBuffer = gl.createBuffer();
    const positionLocation = gl.getAttribLocation(program, "a_position");
    const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
    const timeLocation = gl.getUniformLocation(program, "u_time");
    const lifeTextureLocation = gl.getUniformLocation(program, "u_life");
    const lifeResolutionLocation = gl.getUniformLocation(program, "u_life_resolution");
    const noiseSpeedLocation = gl.getUniformLocation(program, "u_noise_speed");
    const surfaceSpeedLocation = gl.getUniformLocation(program, "u_surface_speed");
    const life = createLifeSimulation();
    const lifeTexture = gl.createTexture();
    if (!lifeTexture) {
      markUnavailable();
      return () => {
        canvas.removeEventListener("webglcontextlost", markUnavailable);
        canvas.removeEventListener("webglcontextrestored", markUnavailable);
        if (positionBuffer) gl.deleteBuffer(positionBuffer);
        gl.deleteProgram(program);
      };
    }
    configureLifeTexture(gl, lifeTexture);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.useProgram(program);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const onPointerDown = (event: PointerEvent) => {
      const hit = pickLifeCell(event, canvas, life, (performance.now() - startedAt) / 1000, settingsRef.current);
      if (!hit) return;
      toggleLifeCell(life, hit.x, hit.y, performance.now());
    };
    canvas.addEventListener("pointerdown", onPointerDown);

    let animationFrame = 0;
    let lastDraw = 0;
    const startedAt = performance.now();
    const render = (now: number) => {
      if (shaderUnavailable || gl.isContextLost()) {
        markUnavailable();
        animationFrame = requestAnimationFrame(render);
        return;
      }
      if (now - lastDraw >= 1000 / 20) {
        lastDraw = now;
        const activeSettings = settingsRef.current;
        resizeCanvas(canvas, gl);
        updateLifeSimulation(life, now, activeSettings);
        uploadLifeTexture(gl, lifeTexture, life);
        gl.useProgram(program);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
        gl.uniform1f(timeLocation, (now - startedAt) / 1000);
        gl.uniform1i(lifeTextureLocation, 0);
        gl.uniform2f(lifeResolutionLocation, life.width, life.height);
        gl.uniform1f(noiseSpeedLocation, activeSettings.noiseSpeed);
        gl.uniform1f(surfaceSpeedLocation, activeSettings.surfaceSpeed);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      animationFrame = requestAnimationFrame(render);
    };
    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("webglcontextlost", markUnavailable);
      canvas.removeEventListener("webglcontextrestored", markUnavailable);
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      gl.deleteTexture(lifeTexture);
      gl.deleteProgram(program);
    };
  }, []);

  const updateSetting = (key: keyof LifeViewSettings, value: number) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setSettingsStatus("");
  };

  const copySettings = async () => {
    const payload = JSON.stringify(settings, null, 2);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(payload);
      setSettingsStatus(`copied\n${payload}`);
    } catch {
      if (copyTextFallback(payload)) {
        setSettingsStatus(`copied\n${payload}`);
      } else {
        setSettingsStatus(payload);
      }
    }
  };

  const pasteSettings = async () => {
    try {
      const clipboard = navigator.clipboard
        ? await navigator.clipboard.readText()
        : window.prompt("Paste wmux Life settings JSON") ?? "";
      applyPastedSettings(clipboard);
    } catch {
      const manual = window.prompt("Paste wmux Life settings JSON") ?? "";
      applyPastedSettings(manual);
    }
  };

  const applyPastedSettings = (value: string) => {
    const parsed = parseLifeViewSettings(value);
    if (!parsed) {
      setSettingsStatus("invalid");
      return;
    }
    setSettings(parsed);
    setSettingsStatus("pasted");
  };

  return (
    <div className="empty-workspace-view" aria-label="wmux idle column field">
      <canvas ref={canvasRef} className="empty-shader-canvas" />
      <button
        type="button"
        className="life-settings-toggle"
        aria-label="Life shader settings"
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen((open) => !open)}
      >
        ...
      </button>
      {settingsOpen && (
        <div className="life-settings-panel" aria-label="Game of Life shader settings">
          <div className="life-settings-actions">
            <button type="button" onClick={copySettings}>copy</button>
            <button type="button" onClick={pasteSettings}>paste</button>
            <button type="button" onClick={() => setSettings(defaultLifeViewSettings)}>reset</button>
          </div>
          <LifeSlider label="GoL step" value={settings.stepMs} min={600} max={9000} step={100} suffix="ms" onChange={(value) => updateSetting("stepMs", value)} />
          <LifeSlider label="Live fade" value={settings.transitionToLiveMs} min={600} max={12000} step={100} suffix="ms" onChange={(value) => updateSetting("transitionToLiveMs", value)} />
          <LifeSlider label="Dead fade" value={settings.transitionToDeadMs} min={400} max={9000} step={100} suffix="ms" onChange={(value) => updateSetting("transitionToDeadMs", value)} />
          <LifeSlider label="Noise speed" value={settings.noiseSpeed} min={0} max={2} step={0.01} suffix="x" onChange={(value) => updateSetting("noiseSpeed", value)} />
          <LifeSlider label="Shimmer" value={settings.surfaceSpeed} min={0} max={2} step={0.01} suffix="x" onChange={(value) => updateSetting("surfaceSpeed", value)} />
          {settingsStatus && <div className="life-settings-status">{settingsStatus}</div>}
        </div>
      )}
    </div>
  );
}

interface LifeSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix: string;
  onChange: (value: number) => void;
}

function LifeSlider({ label, value, min, max, step, suffix, onChange }: LifeSliderProps) {
  const displayValue = suffix === "x" ? value.toFixed(2) : String(Math.round(value));
  return (
    <label className="life-settings-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <output>{displayValue}{suffix}</output>
    </label>
  );
}

const resizeCanvas = (canvas: HTMLCanvasElement, gl: WebGLRenderingContext): void => {
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  gl.viewport(0, 0, width, height);
};

interface LifeSimulation {
  width: number;
  height: number;
  target: Uint8Array;
  next: Uint8Array;
  display: Float32Array;
  pixels: Uint8Array;
  lastStepAt: number;
  lastFrameAt: number;
}

interface LifeViewSettings {
  stepMs: number;
  transitionToLiveMs: number;
  transitionToDeadMs: number;
  noiseSpeed: number;
  surfaceSpeed: number;
}

const LIFE_WIDTH = 72;
const LIFE_HEIGHT = 72;
const TILE_X = 0.205;
const TILE_Y = 0.106;
const HEIGHT_SCALE = 0.17;
const ORIGIN_Y = -0.92;
const defaultLifeViewSettings: LifeViewSettings = {
  stepMs: 2800,
  transitionToLiveMs: 3000,
  transitionToDeadMs: 2000,
  noiseSpeed: 0.41,
  surfaceSpeed: 0.36,
};

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

const createLifeSimulation = (): LifeSimulation => {
  const cells = LIFE_WIDTH * LIFE_HEIGHT;
  const target = new Uint8Array(cells);
  const next = new Uint8Array(cells);
  const display = new Float32Array(cells);
  const pixels = new Uint8Array(cells * 4);
  for (let index = 0; index < cells; index += 1) {
    const alive = Math.random() < 0.34 ? 1 : 0;
    target[index] = alive;
    display[index] = alive;
  }
  return {
    width: LIFE_WIDTH,
    height: LIFE_HEIGHT,
    target,
    next,
    display,
    pixels,
    lastStepAt: 0,
    lastFrameAt: 0,
  };
};

const configureLifeTexture = (gl: WebGLRenderingContext, texture: WebGLTexture): void => {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
};

const uploadLifeTexture = (
  gl: WebGLRenderingContext,
  texture: WebGLTexture,
  life: LifeSimulation,
): void => {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (let index = 0; index < life.display.length; index += 1) {
    const live = Math.max(0, Math.min(255, Math.round(life.display[index] * 255)));
    const target = life.target[index] === 1 ? 255 : 0;
    const offset = index * 4;
    life.pixels[offset] = live;
    life.pixels[offset + 1] = target;
    life.pixels[offset + 2] = Math.abs(target - live);
    life.pixels[offset + 3] = 255;
  }
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    life.width,
    life.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    life.pixels,
  );
};

const updateLifeSimulation = (life: LifeSimulation, now: number, settings: LifeViewSettings): void => {
  if (life.lastFrameAt === 0) {
    life.lastFrameAt = now;
    life.lastStepAt = now;
    return;
  }

  while (now - life.lastStepAt >= settings.stepMs) {
    stepLifeSimulation(life);
    life.lastStepAt += settings.stepMs;
  }

  const delta = Math.max(0, now - life.lastFrameAt);
  life.lastFrameAt = now;
  for (let index = 0; index < life.display.length; index += 1) {
    const transitionMs = life.target[index] > life.display[index] ? settings.transitionToLiveMs : settings.transitionToDeadMs;
    const blend = 1 - Math.exp(-delta / transitionMs);
    life.display[index] += (life.target[index] - life.display[index]) * blend;
  }
};

const stepLifeSimulation = (life: LifeSimulation): void => {
  const { width, height, target, next } = life;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const alive = target[index] === 1;
      const neighbors = countLiveNeighbors(target, width, height, x, y);
      next[index] = neighbors === 3 || (alive && neighbors === 2) ? 1 : 0;
    }
  }
  target.set(next);
};

const countLiveNeighbors = (
  cells: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number => {
  let count = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const wrappedX = (x + dx + width) % width;
      const wrappedY = (y + dy + height) % height;
      count += cells[wrappedY * width + wrappedX];
    }
  }
  return count;
};

const toggleLifeCell = (life: LifeSimulation, cellX: number, cellY: number, now: number): void => {
  const index = lifeIndexForCell(life, cellX, cellY);
  life.target[index] = life.target[index] === 1 ? 0 : 1;
  life.next[index] = life.target[index];
  life.lastStepAt = now;
};

const pickLifeCell = (
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  life: LifeSimulation,
  time: number,
  settings: LifeViewSettings,
): { x: number; y: number } | null => {
  const uv = pointerUv(event, canvas);
  const ground = unprojectGround(uv);
  const baseX = Math.floor(ground[0]);
  const baseY = Math.floor(ground[1]);
  let best: { x: number; y: number; depth: number } | null = null;

  for (let y = -4; y <= 4; y += 1) {
    for (let x = -4; x <= 4; x += 1) {
      const cellX = baseX + x;
      const cellY = baseY + y;
      const cell: Vec2 = [cellX, cellY];
      const lifeValue = life.display[lifeIndexForCell(life, cellX, cellY)] ?? 0;
      const height = estimatedHeightForCell(cell, lifeValue, time, settings);
      const hitDepth = hitDepthForCell(uv, cell, height);
      if (hitDepth !== null && (!best || hitDepth > best.depth)) {
        best = { x: cellX, y: cellY, depth: hitDepth };
      }
    }
  }

  return best ? { x: best.x, y: best.y } : null;
};

const pointerUv = (event: PointerEvent, canvas: HTMLCanvasElement): Vec2 => {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = canvas.height - (event.clientY - rect.top) * (canvas.height / rect.height);
  return [(x * 2 - canvas.width) / canvas.height, (y * 2 - canvas.height) / canvas.height];
};

const unprojectGround = (screen: Vec2): Vec2 => {
  const y = screen[1] - ORIGIN_Y;
  const sum = y / TILE_Y;
  const difference = screen[0] / TILE_X;
  return [(sum + difference) * 0.5, (sum - difference) * 0.5];
};

const hitDepthForCell = (uv: Vec2, cell: Vec2, height: number): number | null => {
  const gap = 0.04;
  const p00: Vec3 = [cell[0] + gap, cell[1] + gap, height];
  const p10: Vec3 = [cell[0] + 1 - gap, cell[1] + gap, height];
  const p11: Vec3 = [cell[0] + 1 - gap, cell[1] + 1 - gap, height];
  const p01: Vec3 = [cell[0] + gap, cell[1] + 1 - gap, height];
  const b00: Vec3 = [p00[0], p00[1], 0];
  const b10: Vec3 = [p10[0], p10[1], 0];
  const b01: Vec3 = [p01[0], p01[1], 0];

  const s00 = projectPoint(p00);
  const s10 = projectPoint(p10);
  const s11 = projectPoint(p11);
  const s01 = projectPoint(p01);
  const g00 = projectPoint(b00);
  const g10 = projectPoint(b10);
  const g01 = projectPoint(b01);
  const depthBase = -(cell[0] + cell[1]) * 32 + (cell[0] - cell[1]) * 0.01;

  let bestDepth: number | null = null;
  if (pointInQuad(uv, s00, s10, s11, s01)) bestDepth = depthBase + height * 2 + 3;
  if (pointInQuad(uv, s00, s10, g10, g00)) bestDepth = Math.max(bestDepth ?? -Infinity, depthBase + height * 1.4 + 1);
  if (pointInQuad(uv, s01, s00, g00, g01)) bestDepth = Math.max(bestDepth ?? -Infinity, depthBase + height * 1.4 + 0.5);
  return bestDepth;
};

const projectPoint = (point: Vec3): Vec2 => [
  (point[0] - point[1]) * TILE_X,
  ORIGIN_Y + (point[0] + point[1]) * TILE_Y + point[2] * HEIGHT_SCALE,
];

const pointInQuad = (point: Vec2, a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
  const winding = Math.sign(edgeValue(a, b, c)) || 1;
  return (
    edgeValue(a, b, point) * winding >= -0.002 &&
    edgeValue(b, c, point) * winding >= -0.002 &&
    edgeValue(c, d, point) * winding >= -0.002 &&
    edgeValue(d, a, point) * winding >= -0.002
  );
};

const edgeValue = (a: Vec2, b: Vec2, point: Vec2): number =>
  (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);

const estimatedHeightForCell = (cell: Vec2, life: number, time: number, settings: LifeViewSettings): number => {
  const t = time * 0.085 * settings.noiseSpeed;
  const broad = fbm(cell[0] * 0.105, cell[1] * 0.105, t, -t * 0.74);
  const detail = fbm(cell[0] * 0.32, cell[1] * 0.32, -t * 0.56, t * 0.38);
  const wave = Math.sin(cell[0] * 0.34 + cell[1] * 0.2 + time * 0.38 * settings.noiseSpeed) * 0.12;
  const shaped = smoothstep(0.12, 0.92, broad * 0.76 + detail * 0.24 + wave);
  return 0.06 + shaped * shaped * 1.12 + life * 0.38;
};

const parseLifeViewSettings = (value: string): LifeViewSettings | null => {
  try {
    const parsed = JSON.parse(value) as Partial<LifeViewSettings>;
    return {
      stepMs: clampNumber(parsed.stepMs, 600, 9000, defaultLifeViewSettings.stepMs),
      transitionToLiveMs: clampNumber(parsed.transitionToLiveMs, 600, 12000, defaultLifeViewSettings.transitionToLiveMs),
      transitionToDeadMs: clampNumber(parsed.transitionToDeadMs, 400, 9000, defaultLifeViewSettings.transitionToDeadMs),
      noiseSpeed: clampNumber(parsed.noiseSpeed, 0, 2, defaultLifeViewSettings.noiseSpeed),
      surfaceSpeed: clampNumber(parsed.surfaceSpeed, 0, 2, defaultLifeViewSettings.surfaceSpeed),
    };
  } catch {
    return null;
  }
};

const copyTextFallback = (value: string): boolean => {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
};

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
};

const lifeIndexForCell = (life: LifeSimulation, x: number, y: number): number => {
  const wrappedX = positiveModulo(Math.floor(x), life.width);
  const wrappedY = positiveModulo(Math.floor(y), life.height);
  return wrappedY * life.width + wrappedX;
};

const positiveModulo = (value: number, modulo: number): number => ((value % modulo) + modulo) % modulo;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const fbm = (x: number, y: number, offsetX: number, offsetY: number): number => {
  let value = 0;
  let amp = 0.55;
  let total = 0;
  let px = x + offsetX;
  let py = y + offsetY;
  for (let index = 0; index < 4; index += 1) {
    value += noise(px, py) * amp;
    total += amp;
    px = px * 2.05 + 12.4;
    py = py * 2.05 - 8.7;
    amp *= 0.52;
  }
  return value / total;
};

const noise = (x: number, y: number): number => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothFraction(x - ix);
  const fy = smoothFraction(y - iy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return mix(mix(a, b, fx), mix(c, d, fx), fy);
};

const smoothFraction = (value: number): number => value * value * (3 - 2 * value);
const mix = (a: number, b: number, value: number): number => a * (1 - value) + b * value;
const hash = (x: number, y: number): number => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123);
const fract = (value: number): number => value - Math.floor(value);

const createProgram = (
  gl: WebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null => {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  console.error(gl.getProgramInfoLog(program) || "wmux idle shader link failed");
  gl.deleteProgram(program);
  return null;
};

const compileShader = (
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.error(gl.getShaderInfoLog(shader) || "wmux idle shader compile failed");
  gl.deleteShader(shader);
  return null;
};

const vertexShaderSource = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform sampler2D u_life;
uniform vec2 u_life_resolution;
uniform float u_noise_speed;
uniform float u_surface_speed;

const float TILE_X = 0.205;
const float TILE_Y = 0.106;
const float HEIGHT_SCALE = 0.17;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.55;
  float total = 0.0;
  for (int i = 0; i < 4; i++) {
    value += noise(p) * amp;
    total += amp;
    p = p * 2.05 + vec2(12.4, -8.7);
    amp *= 0.52;
  }
  return value / total;
}

float lifeForCell(vec2 cell) {
  vec2 wrapped = mod(floor(cell), u_life_resolution);
  vec2 sampleUv = (wrapped + vec2(0.5)) / u_life_resolution;
  return texture2D(u_life, sampleUv).r;
}

float heightForCell(vec2 cell, float life) {
  float t = u_time * 0.085 * u_noise_speed;
  float broad = fbm(cell * 0.105 + vec2(t, -t * 0.74));
  float detail = fbm(cell * 0.32 + vec2(-t * 0.56, t * 0.38));
  float wave = sin(cell.x * 0.34 + cell.y * 0.2 + u_time * 0.38 * u_noise_speed) * 0.12;
  float shaped = smoothstep(0.12, 0.92, broad * 0.76 + detail * 0.24 + wave);
  return 0.06 + shaped * shaped * 1.12 + life * 0.38;
}

vec2 origin() {
  return vec2(0.0, -0.92);
}

vec2 projectPoint(vec3 p) {
  vec2 screen = origin();
  screen.x += (p.x - p.y) * TILE_X;
  screen.y += (p.x + p.y) * TILE_Y + p.z * HEIGHT_SCALE;
  return screen;
}

vec2 unprojectGround(vec2 screen) {
  vec2 p = screen - origin();
  float sum = p.y / TILE_Y;
  float difference = p.x / TILE_X;
  return vec2((sum + difference) * 0.5, (sum - difference) * 0.5);
}

float edgeValue(vec2 a, vec2 b, vec2 p) {
  return (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
}

float edgeDistance(vec2 a, vec2 b, vec2 p) {
  return edgeValue(a, b, p) / max(length(b - a), 0.0001);
}

float quadDistance(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  float winding = sign(edgeValue(a, b, c));
  float e0 = edgeDistance(a, b, p) * winding;
  float e1 = edgeDistance(b, c, p) * winding;
  float e2 = edgeDistance(c, d, p) * winding;
  float e3 = edgeDistance(d, a, p) * winding;
  return min(min(e0, e1), min(e2, e3));
}

float cornerDistance(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  return min(min(length(p - a), length(p - b)), min(length(p - c), length(p - d)));
}

float roundedQuadMask(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d, float radius) {
  float distance = quadDistance(p, a, b, c, d);
  float face = smoothstep(-0.002, 0.004, distance);
  float corner = cornerDistance(p, a, b, c, d);
  float cornerRound = smoothstep(radius * 0.22, radius, corner + max(distance, 0.0) * 0.55);
  return face * cornerRound;
}

vec3 metalRamp(float v) {
  vec3 black = vec3(0.006, 0.0065, 0.0075);
  vec3 graphite = vec3(0.058, 0.061, 0.068);
  vec3 silver = vec3(0.66, 0.69, 0.74);
  vec3 hot = vec3(1.0, 0.98, 0.88);
  vec3 color = mix(black, graphite, smoothstep(0.0, 0.62, v));
  color = mix(color, silver, smoothstep(0.56, 0.94, v));
  color = mix(color, hot, smoothstep(0.9, 1.0, v));
  return color;
}

vec3 faceColor(vec2 cell, float height, float face, float faceDistance, float corner, vec2 uv, float life) {
  float t = u_time * 0.09 * u_surface_speed;
  float grain = fbm(cell * 1.7 + vec2(t * 0.7, -t * 0.4));
  float diagonal = smoothstep(-0.72, 0.82, sin((cell.x - cell.y) * 0.42 + u_time * 0.22 * u_surface_speed));
  float glint = pow(clamp(sin(cell.x * 0.58 - cell.y * 0.41 + u_time * 0.56 * u_surface_speed) * 0.5 + 0.5, 0.0, 1.0), 9.0);
  float heightLight = smoothstep(0.12, 1.46, height);
  vec3 color = metalRamp(heightLight * 0.72 + diagonal * 0.14 + grain * 0.1 + glint * 0.18);
  vec3 panelLight = vec3(0.92, 0.96, 1.0);
  vec3 panelCore = vec3(1.0, 1.0, 0.98);

  if (face < 0.5) {
    color *= vec3(1.08, 1.1, 1.14);
    color = mix(color, panelCore, life * 0.74);
    color += panelLight * life * 0.55;
  } else if (face < 1.5) {
    color *= vec3(0.48, 0.5, 0.55);
    color = mix(color, panelLight, life * 0.22);
    color += panelLight * life * 0.12;
  } else {
    color *= vec3(0.31, 0.33, 0.38);
    color = mix(color, panelLight, life * 0.16);
    color += panelLight * life * 0.08;
  }

  float roundedBevel = 1.0 - smoothstep(0.012, 0.044, min(faceDistance, corner * 0.82));
  float rim = 1.0 - smoothstep(0.004, 0.019, faceDistance);
  color = mix(color * 0.8, color + vec3(0.14, 0.16, 0.19), roundedBevel * (face < 0.5 ? 0.52 : 0.34));
  color += vec3(0.72, 0.78, 0.86) * rim * (face < 0.5 ? 0.42 : 0.22);
  color += vec3(1.0, 0.93, 0.72) * glint * rim * 0.18;
  color += panelLight * life * rim * (face < 0.5 ? 0.34 : 0.14);
  float faceFrame = max(abs(uv.x) * 0.74, abs(uv.y) * 1.08);
  color *= 1.0 - smoothstep(0.2, 1.62, faceFrame);
  return color;
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution) / u_resolution.y;
  vec2 ground = floor(unprojectGround(uv));
  vec3 color = vec3(0.002, 0.0022, 0.0028);
  float bestDepth = -100000.0;
  float ambientGrid = 0.0;

  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 cell = ground + vec2(float(x), float(y));
      float life = lifeForCell(cell);
      float height = heightForCell(cell, life);
      float gap = 0.04;

      vec3 p00 = vec3(cell.x + gap, cell.y + gap, height);
      vec3 p10 = vec3(cell.x + 1.0 - gap, cell.y + gap, height);
      vec3 p11 = vec3(cell.x + 1.0 - gap, cell.y + 1.0 - gap, height);
      vec3 p01 = vec3(cell.x + gap, cell.y + 1.0 - gap, height);
      vec3 b00 = vec3(p00.xy, 0.0);
      vec3 b10 = vec3(p10.xy, 0.0);
      vec3 b01 = vec3(p01.xy, 0.0);

      vec2 s00 = projectPoint(p00);
      vec2 s10 = projectPoint(p10);
      vec2 s11 = projectPoint(p11);
      vec2 s01 = projectPoint(p01);
      vec2 g00 = projectPoint(b00);
      vec2 g10 = projectPoint(b10);
      vec2 g01 = projectPoint(b01);
      float depthBase = -(cell.x + cell.y) * 32.0 + (cell.x - cell.y) * 0.01;

      float topDistance = quadDistance(uv, s00, s10, s11, s01);
      float topCorner = cornerDistance(uv, s00, s10, s11, s01);
      float topMask = roundedQuadMask(uv, s00, s10, s11, s01, 0.036);
      float topDepth = depthBase + height * 2.0 + 3.0;
      if (topMask > 0.001 && topDepth > bestDepth) {
        bestDepth = topDepth;
        color = mix(color, faceColor(cell, height, 0.0, topDistance, topCorner, uv, life), topMask);
      }

      float sideDistanceA = quadDistance(uv, s00, s10, g10, g00);
      float sideCornerA = cornerDistance(uv, s00, s10, g10, g00);
      float sideMaskA = roundedQuadMask(uv, s00, s10, g10, g00, 0.03);
      float sideDepthA = depthBase + height * 1.4 + 1.0;
      if (sideMaskA > 0.001 && sideDepthA > bestDepth) {
        bestDepth = sideDepthA;
        color = mix(color, faceColor(cell, height, 1.0, sideDistanceA, sideCornerA, uv, life), sideMaskA);
      }

      float sideDistanceB = quadDistance(uv, s01, s00, g00, g01);
      float sideCornerB = cornerDistance(uv, s01, s00, g00, g01);
      float sideMaskB = roundedQuadMask(uv, s01, s00, g00, g01, 0.03);
      float sideDepthB = depthBase + height * 1.4 + 0.5;
      if (sideMaskB > 0.001 && sideDepthB > bestDepth) {
        bestDepth = sideDepthB;
        color = mix(color, faceColor(cell, height, 2.0, sideDistanceB, sideCornerB, uv, life), sideMaskB);
      }

      ambientGrid += max(topMask, max(sideMaskA, sideMaskB)) * (0.008 + life * 0.02);
    }
  }

  vec2 sheen = normalize(vec2(-0.58, 0.82));
  float lightSweep = pow(clamp(dot(normalize(uv + vec2(0.42, -0.1)), sheen) * 0.5 + 0.5, 0.0, 1.0), 9.0);
  color += vec3(0.05, 0.055, 0.07) * ambientGrid;
  color += vec3(0.2, 0.22, 0.27) * lightSweep * 0.035;
  float squareFrame = max(abs(uv.x) * 0.78, abs(uv.y) * 1.08);
  color *= 1.0 - smoothstep(0.28, 1.74, squareFrame);
  color = pow(color, vec3(0.86));

  gl_FragColor = vec4(color, 1.0);
}
`;
