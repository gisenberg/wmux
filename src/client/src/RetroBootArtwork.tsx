import { useEffect, useRef } from "react";

const system6HappyMac = new URL("./assets/retro/system6-happy-mac.png", import.meta.url).href;
const msxLogo = new URL("./assets/retro/logos/msx.svg", import.meta.url).href;
const nextLogo = new URL("./assets/retro/logos/next.svg", import.meta.url).href;
const pico8Logo = new URL("./assets/retro/logos/pico8.svg", import.meta.url).href;
const sgiLogo = new URL("./assets/retro/logos/sgi.svg", import.meta.url).href;
const workbench13Bootscreen = new URL("./assets/retro/workbench13-bootscreen.gif", import.meta.url).href;

export type RetroBootArtworkKind =
  | "badge"
  | "cassette"
  | "chip"
  | "disk"
  | "portable"
  | "rack"
  | "terminal"
  | "window"
  | "workstation"
  | "cartridge"
  | "boing";

export interface RetroBootArtworkDefinition {
  kind: RetroBootArtworkKind;
  label: string;
  asset?: string;
  framebuffer: readonly [width: number, height: number];
  lightAssetBackdrop?: boolean;
  fullFrame?: boolean;
  hardEdges?: boolean;
  rasterPalette?: readonly string[];
  nativeAssetSize?: readonly [width: number, height: number];
}

export const RETRO_BOOT_ARTWORK: Readonly<Record<string, RetroBootArtworkDefinition>> = {
  "commodore-64": {
    kind: "disk",
    label: "C64",
    framebuffer: [320, 200],
    hardEdges: true,
  },
  "commodore-128": {
    kind: "disk",
    label: "C128",
    framebuffer: [320, 200],
    hardEdges: true,
  },
  "apple-iie": {
    kind: "disk",
    label: "][e",
    framebuffer: [280, 192],
    hardEdges: true,
  },
  "ibm-pc-at": {
    kind: "chip",
    label: "386",
    framebuffer: [720, 400],
    hardEdges: true,
  },
  "bbc-micro": { kind: "disk", label: "BBC", framebuffer: [320, 256], hardEdges: true },
  "acorn-archimedes": {
    kind: "workstation",
    label: "ARM",
    framebuffer: [640, 256],
  },
  "trs-80-model-4": {
    kind: "disk",
    label: "TRS",
    framebuffer: [512, 192],
    hardEdges: true,
  },
  "zx-spectrum": {
    kind: "cassette",
    label: "ZX",
    framebuffer: [256, 192],
    hardEdges: true,
  },
  "atari-st": {
    kind: "workstation",
    label: "ST",
    framebuffer: [640, 400],
    hardEdges: true,
  },
  "amiga-workbench": {
    kind: "boing",
    label: "Workbench 1.3",
    asset: workbench13Bootscreen,
    framebuffer: [640, 400],
    fullFrame: true,
  },
  "osborne-1": { kind: "portable", label: "O1", framebuffer: [416, 240], hardEdges: true },
  "sinclair-ql": {
    kind: "cassette",
    label: "QL",
    framebuffer: [512, 256],
    hardEdges: true,
  },
  "amstrad-cpc": {
    kind: "cassette",
    label: "CPC",
    framebuffer: [320, 200],
    hardEdges: true,
  },
  msx2: {
    kind: "cartridge",
    label: "MSX2",
    asset: msxLogo,
    framebuffer: [256, 212],
    lightAssetBackdrop: true,
    hardEdges: true,
  },
  "apple-lisa": {
    kind: "window",
    label: "LISA",
    framebuffer: [720, 364],
    hardEdges: true,
  },
  "vax-vms": {
    kind: "rack",
    label: "VAX",
    framebuffer: [800, 240],
    hardEdges: true,
  },
  "sun-sparcstation": { kind: "workstation", label: "SUN", framebuffer: [1152, 900] },
  "sgi-irix": { kind: "workstation", label: "SGI", asset: sgiLogo, framebuffer: [1280, 1024] },
  nextcube: {
    kind: "workstation",
    label: "NeXT",
    asset: nextLogo,
    framebuffer: [1120, 832],
    rasterPalette: ["#111111", "#666666", "#aaaaaa", "#dedede"],
  },
  "pdp-11-rt11": {
    kind: "rack",
    label: "PDP-11",
    framebuffer: [800, 240],
    hardEdges: true,
  },
  "ibm-3270-mvs": {
    kind: "terminal",
    label: "3270",
    framebuffer: [720, 350],
    hardEdges: true,
  },
  "macintosh-system-6": {
    kind: "window",
    label: "Mac",
    asset: system6HappyMac,
    framebuffer: [512, 342],
    fullFrame: true,
    hardEdges: true,
  },
  "ti-99-4a": { kind: "cartridge", label: "TI", framebuffer: [256, 192], hardEdges: true },
  "trs-80-coco": { kind: "cassette", label: "COCO", framebuffer: [256, 192], hardEdges: true },
  "amstrad-pcw": { kind: "disk", label: "PCW", framebuffer: [720, 256], hardEdges: true },
  "sharp-x68000": { kind: "workstation", label: "X68K", framebuffer: [768, 512], hardEdges: true },
  "nec-pc-9801": { kind: "chip", label: "PC-98", framebuffer: [640, 400], hardEdges: true },
  "os2-warp": { kind: "window", label: "OS/2", framebuffer: [640, 480], hardEdges: true },
  "enterprise-128": { kind: "cartridge", label: "EP128", framebuffer: [320, 256], hardEdges: true },
  "oric-atmos": { kind: "cassette", label: "ORIC", framebuffer: [240, 224], hardEdges: true },
  "commodore-pet": { kind: "terminal", label: "PET", framebuffer: [320, 200], hardEdges: true },
  "commodore-vic-20": { kind: "cartridge", label: "VIC", framebuffer: [176, 184], hardEdges: true },
  "sam-coupe": { kind: "disk", label: "SAM", framebuffer: [256, 192], hardEdges: true },
  "memotech-mtx": { kind: "cassette", label: "MTX", framebuffer: [320, 192], hardEdges: true },
  "tatung-einstein": { kind: "disk", label: "TC-01", framebuffer: [320, 192], hardEdges: true },
  "atari-8-bit": { kind: "cartridge", label: "ATARI", framebuffer: [320, 192], hardEdges: true },
  "pico-8": {
    kind: "cartridge",
    label: "PICO-8",
    asset: pico8Logo,
    framebuffer: [128, 128],
    hardEdges: true,
  },
};

interface RetroBootArtworkProps {
  profileId: string;
  profileName: string;
}

export function RetroBootArtwork({ profileId, profileName }: RetroBootArtworkProps) {
  const artwork = RETRO_BOOT_ARTWORK[profileId];
  if (!artwork) return null;
  return (
    <div
      className="retro-boot-artwork"
      data-image-placeholder={profileId}
      role="img"
      aria-label={`${profileName} boot artwork`}
    >
      {artwork.asset ? (
        <RasterArtwork artwork={artwork} />
      ) : (
        <svg viewBox="0 0 112 84" role="img" aria-hidden="true">
          {artworkShape(artwork)}
        </svg>
      )}
    </div>
  );
}

function RasterArtwork({ artwork }: { artwork: RetroBootArtworkDefinition }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, height] = artwork.framebuffer;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !artwork.asset) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let cancelled = false;
    const source = new Image();
    source.onload = () => {
      if (cancelled) return;

      context.clearRect(0, 0, width, height);
      context.imageSmoothingEnabled = false;

      if (artwork.fullFrame) {
        context.drawImage(source, 0, 0, width, height);
        return;
      }

      const maxWidth = width * 0.48;
      const maxHeight = height * 0.28;
      const scale = Math.min(maxWidth / source.naturalWidth, maxHeight / source.naturalHeight);
      const drawWidth = artwork.nativeAssetSize?.[0] ?? Math.max(1, Math.round(source.naturalWidth * scale));
      const drawHeight = artwork.nativeAssetSize?.[1] ?? Math.max(1, Math.round(source.naturalHeight * scale));
      const x = Math.round((width - drawWidth) / 2);
      const y = Math.round((height - drawHeight) / 2);

      if (artwork.lightAssetBackdrop) {
        const padding = Math.max(2, Math.round(Math.min(width, height) * 0.025));
        context.fillStyle = "rgba(248, 246, 238, 0.94)";
        context.fillRect(x - padding, y - padding, drawWidth + padding * 2, drawHeight + padding * 2);
      }
      context.drawImage(source, x, y, drawWidth, drawHeight);
      quantizeFramebuffer(context, width, height, artwork.rasterPalette, artwork.hardEdges ?? false);
    };
    source.src = artwork.asset;

    return () => {
      cancelled = true;
      source.onload = null;
    };
  }, [artwork, height, width]);

  return (
    <canvas
      ref={canvasRef}
      className="retro-boot-artwork-framebuffer"
      width={width}
      height={height}
      data-framebuffer={`${width}x${height}`}
      aria-hidden="true"
    />
  );
}

const quantizeFramebuffer = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  paletteSource: readonly string[] | undefined,
  hardEdges: boolean,
) => {
  if (!paletteSource?.length && !hardEdges) return;
  const palette = paletteSource?.map(parseHexColor) ?? [];
  const image = context.getImageData(0, 0, width, height);
  const pixels = image.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha === 0) continue;
    if (hardEdges) {
      pixels[index + 3] = alpha < 128 ? 0 : 255;
      if (alpha < 128) continue;
    }
    if (!palette.length) continue;
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    let nearest = palette[0];
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const color of palette) {
      const distance = (red - color[0]) ** 2 + (green - color[1]) ** 2 + (blue - color[2]) ** 2;
      if (distance >= nearestDistance) continue;
      nearest = color;
      nearestDistance = distance;
    }
    [pixels[index], pixels[index + 1], pixels[index + 2]] = nearest;
  }
  context.putImageData(image, 0, 0);
};

const parseHexColor = (value: string): [number, number, number] => {
  const hex = value.replace(/^#/, "");
  const expanded = hex.length === 3 ? hex.replace(/(.)/g, "$1$1") : hex;
  return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)) as [number, number, number];
};

const artworkLabel = (label: string, y = 48) => (
  <text x="56" y={y} textAnchor="middle" dominantBaseline="middle">
    {label}
  </text>
);

const artworkShape = ({ kind, label }: RetroBootArtworkDefinition) => {
  switch (kind) {
    case "disk":
      return (
        <>
          <rect x="25" y="8" width="62" height="68" rx="3" />
          <rect x="38" y="8" width="36" height="22" />
          <rect x="35" y="49" width="42" height="27" rx="2" />
          <line x1="43" y1="58" x2="69" y2="58" />
          {artworkLabel(label, 42)}
        </>
      );
    case "cassette":
      return (
        <>
          <rect x="11" y="17" width="90" height="51" rx="5" />
          <circle cx="35" cy="44" r="10" />
          <circle cx="77" cy="44" r="10" />
          <line x1="45" y1="44" x2="67" y2="44" />
          <path d="M29 68 L36 58 H76 L83 68" />
          {artworkLabel(label, 29)}
        </>
      );
    case "chip":
      return (
        <>
          <rect x="25" y="17" width="62" height="50" rx="3" />
          {[30, 42, 54, 66, 78].map((x) => (
            <g key={x}>
              <line x1={x} y1="9" x2={x} y2="17" />
              <line x1={x} y1="67" x2={x} y2="75" />
            </g>
          ))}
          {artworkLabel(label, 42)}
        </>
      );
    case "portable":
      return (
        <>
          <path d="M18 14 H94 V62 H18 Z" />
          <rect x="27" y="22" width="39" height="30" rx="2" />
          <circle cx="80" cy="29" r="3" />
          <circle cx="80" cy="41" r="3" />
          <path d="M12 62 H100 L92 76 H20 Z" />
          {artworkLabel(label, 37)}
        </>
      );
    case "rack":
      return (
        <>
          <rect x="22" y="7" width="68" height="70" rx="2" />
          {[18, 31, 44, 57].map((y) => (
            <g key={y}>
              <line x1="22" y1={y} x2="90" y2={y} />
              <circle cx="80" cy={y - 6} r="2" />
            </g>
          ))}
          {artworkLabel(label, 69)}
        </>
      );
    case "terminal":
      return (
        <>
          <rect x="14" y="8" width="84" height="56" rx="5" />
          <rect x="23" y="17" width="66" height="37" rx="2" />
          <path d="M42 64 V72 H30 M70 64 V72 H82 M25 76 H87" />
          {artworkLabel(label, 36)}
        </>
      );
    case "window":
      return (
        <>
          <rect x="14" y="10" width="84" height="64" />
          <line x1="14" y1="23" x2="98" y2="23" />
          <rect x="20" y="15" width="4" height="4" />
          <path d="M25 60 L40 39 L51 51 L65 33 L87 60 Z" />
          {artworkLabel(label, 68)}
        </>
      );
    case "workstation":
      return (
        <>
          <path d="M56 7 L91 26 V62 L56 79 L21 62 V26 Z" />
          <path d="M21 26 L56 45 L91 26 M56 45 V79" />
          {artworkLabel(label, 29)}
        </>
      );
    case "cartridge":
      return (
        <>
          <path d="M22 8 H90 V67 L80 77 H32 L22 67 Z" />
          <rect x="33" y="18" width="46" height="32" rx="2" />
          <line x1="34" y1="67" x2="78" y2="67" />
          {artworkLabel(label, 35)}
        </>
      );
    case "boing":
      return (
        <>
          <circle cx="56" cy="39" r="31" />
          <path d="M27 29 H85 M25 43 H87 M31 57 H81 M42 10 C36 28 36 50 42 68 M56 8 V70 M70 10 C76 28 76 50 70 68" />
          {artworkLabel(label, 79)}
        </>
      );
    case "badge":
    default:
      return (
        <>
          <rect x="13" y="15" width="86" height="54" rx="5" />
          {artworkLabel(label, 42)}
        </>
      );
  }
};
