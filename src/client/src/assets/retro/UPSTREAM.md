# DamienG Micropack system fonts

The WOFF2 files in this directory are unmodified webfont conversions from
Damien Guard's ZX Origins Micropack, downloaded from:

https://dl.damieng.com/fonts/conversions/Micropack.zip

The archive was dated December 1, 2023. wmux uses these files only as embedded
fonts for its randomized retro-computer boot screen:

- `BBC_Micro.woff2` — BBC Micro
- `Spectrum.woff2` — Sinclair ZX Spectrum
- `Atari_8_bit.woff2` — Atari's 8-bit face, used as the closest downloadable
  relative of the Atari ST face
- `Amiga_Topaz_v1.woff2` — Amiga Workbench 1.x Topaz
- `VT100.woff2` — VT100, used for the Osborne CP/M profile
- `Amstrad_CPC.woff2` — Amstrad CPC
- `Apple_2.woff2` — Apple II
- `IBM_CGA.woff2` — IBM CGA, used for the PC/AT profile
- `IBM_2915.woff2` — IBM 2915, used for the TRS-80 profile
- `MSX_1.woff2` — MSX
- `Lisa_Console.woff2` — Apple Lisa console
- `Commodore_VIC-20.woff2` — Commodore PET and VIC-20
- `Memotech_MTX512.woff2` — Memotech MTX512
- `Mullard_SAA_5050.woff2` — SAA 5050 family fallback for early character displays
- `Oric_Atmos.woff2` — Oric Atmos
- `SAM_Coupe.woff2` — SAM Coupé
- `Tatung_Einstein.woff2` — Tatung Einstein and closest bundled fallback for TI/CoCo display text

The Commodore profiles continue to use the separately documented C64 Pro Mono
asset under `../c64`. Damien Guard's Commodore 128 FontStruct recreation is not
included because its download is disabled.

## License and repository permission

These fonts are part of the ZX Origins font collection, copyright 1988–2023
Damien Guard. The supplied license permits using an embedded font file on a
site and asks for credit to “DamienG https://damieng.com/zx-origins” when a
credits section is available. It prohibits redistributing the files as a font,
re-hosting them for direct font download, or bundling them with other art asset
collections. Inclusion in this repository and use by wmux are with permission
from Damien Guard. That project-specific permission does not relicense the
fonts under MIT; other reuse remains governed by the upstream terms or separate
permission from Damien Guard.

See the complete upstream README and current project information at:

https://damieng.com/zx-origins/

## Workbench 1.3 boot screen

`workbench13-bootscreen.gif` is the unmodified 640x400 Amiga Workbench 1.3
insert-disk screen supplied as the visual reference for the Amiga boot profile:

https://i0.wp.com/geekometry.com/wp-content/uploads/2013/11/workbench13_bootscreen.gif

The image depicts the copyrighted Amiga user interface and is included as an
application-internal historical screenshot, not as project branding. No
source-redistribution license has been identified for it, and it is not covered
by wmux's MIT license.

`tos-1.04-desktop.png` is the CC BY-SA 4.0
[TOS 1.04 startup screenshot](https://commons.wikimedia.org/wiki/File:TOS_1.04_(Rainbow_TOS).png)
by MJaap. It preserves the real Rainbow TOS startup mark and GEM disk/trash
iconography instead of substituting generic browser glyphs.
