const amigaLogo = new URL("./assets/retro/logos/amiga.svg", import.meta.url).href;
const amstradLogo = new URL("./assets/retro/logos/amstrad-cpc.svg", import.meta.url).href;
const appleLogo = new URL("./assets/retro/logos/apple-rainbow.svg", import.meta.url).href;
const archimedesLogo = new URL("./assets/retro/logos/archimedes.svg", import.meta.url).href;
const atariLogo = new URL("./assets/retro/logos/atari.svg", import.meta.url).href;
const commodoreLogo = new URL("./assets/retro/logos/commodore.svg", import.meta.url).href;
const decLogo = new URL("./assets/retro/logos/dec.svg", import.meta.url).href;
const ibmLogo = new URL("./assets/retro/logos/ibm.svg", import.meta.url).href;
const msxLogo = new URL("./assets/retro/logos/msx.svg", import.meta.url).href;
const nextLogo = new URL("./assets/retro/logos/next.svg", import.meta.url).href;
const osborneLogo = new URL("./assets/retro/logos/osborne.svg", import.meta.url).href;
const pico8Logo = new URL("./assets/retro/logos/pico8.svg", import.meta.url).href;
const sgiLogo = new URL("./assets/retro/logos/sgi.svg", import.meta.url).href;
const sinclairLogo = new URL("./assets/retro/logos/sinclair.svg", import.meta.url).href;
const sunLogo = new URL("./assets/retro/logos/sun.svg", import.meta.url).href;
const trs80Logo = new URL("./assets/retro/logos/trs80.svg", import.meta.url).href;

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
}

export const RETRO_BOOT_ARTWORK: Readonly<Record<string, RetroBootArtworkDefinition>> = {
  "commodore-64": { kind: "disk", label: "C64", asset: commodoreLogo },
  "commodore-128": { kind: "disk", label: "C128", asset: commodoreLogo },
  "apple-iie": { kind: "disk", label: "][e", asset: appleLogo },
  "ibm-pc-at": { kind: "chip", label: "386", asset: ibmLogo },
  "bbc-micro": { kind: "disk", label: "BBC" },
  "acorn-archimedes": { kind: "workstation", label: "ARM", asset: archimedesLogo },
  "trs-80-model-4": { kind: "disk", label: "TRS", asset: trs80Logo },
  "zx-spectrum": { kind: "cassette", label: "ZX", asset: sinclairLogo },
  "atari-st": { kind: "workstation", label: "ST", asset: atariLogo },
  "amiga-workbench": { kind: "boing", label: "AMIGA", asset: amigaLogo },
  "osborne-1": { kind: "portable", label: "O1", asset: osborneLogo },
  "sinclair-ql": { kind: "cassette", label: "QL", asset: sinclairLogo },
  "amstrad-cpc": { kind: "cassette", label: "CPC", asset: amstradLogo },
  msx2: { kind: "cartridge", label: "MSX2", asset: msxLogo },
  "apple-lisa": { kind: "window", label: "LISA", asset: appleLogo },
  "vax-vms": { kind: "rack", label: "VAX", asset: decLogo },
  "sun-sparcstation": { kind: "workstation", label: "SUN", asset: sunLogo },
  "sgi-irix": { kind: "workstation", label: "SGI", asset: sgiLogo },
  nextcube: { kind: "workstation", label: "NeXT", asset: nextLogo },
  "pdp-11-rt11": { kind: "rack", label: "PDP-11", asset: decLogo },
  "ibm-3270-mvs": { kind: "terminal", label: "3270", asset: ibmLogo },
  "pico-8": { kind: "cartridge", label: "PICO-8", asset: pico8Logo },
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
        <img className="retro-boot-artwork-asset" src={artwork.asset} alt="" />
      ) : (
        <svg viewBox="0 0 112 84" role="img" aria-hidden="true">
          {artworkShape(artwork)}
        </svg>
      )}
    </div>
  );
}

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
