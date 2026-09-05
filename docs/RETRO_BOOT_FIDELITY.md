# Retro boot fidelity

The boot gallery is a collection of historically informed wmux loading and authentication scenes, not a ROM emulator.
Hardware identity, command vocabulary, display geometry and recognizable interactions should agree with the selected machine.
WMUX programs, disk contents, network drivers and authentication dialogs are fictional application content.
They must not be described as original firmware output.

## Grounded behavior

| Scene | Behavior reproduced | Reference and limits |
| --- | --- | --- |
| Commodore 64 / 1541 | BASIC V2 banner, matching light-blue text and border, reverse-video directory heading, first program named WMUX, 624 blocks remaining after the four listed files allocate 40 blocks | [Commodore 64 setup guide](https://www.commodore.ca/manuals/c64_users_guide/c64-users_guide-01-setup.pdf) and [Commodore drive capacity comparison](https://www.commodore.ca/manuals/commodore_1541_4040_8050_8250_comparison-old.htm) establish the banner and 664-block usable disk capacity; the disk is invented |
| Commodore 128 | Native BASIC 7 DLOAD/RUN flow, not CP/M startup | [Commodore 128 System Guide, section 2](https://www.commodore.ca/manuals/128_system_guide/sect-02.htm); directory contents remain illustrative |
| BBC Micro | Default MODE 7 character grid, 40 columns by 25 rows, using the bundled SAA5050-style face | [BBC BASIC implementer's MODE 7 reference](https://www.bbcbasic.uk/bbcwin/manual/bbcwinh.html); the retained 320:256 presentation aspect is not a claim that teletext is a 320-pixel bitmap mode |
| ZX Spectrum 48K | Copyright in the lower editor area, cleared on command entry; LOAD arrives as a keyword; red/cyan pilots, short header data, a quiet gap with program name, second pilot and blue/yellow program data | [Sinclair Introduction, chapter 1](https://worldofspectrum.org/ZXSpectrumIntroduction/chapter_one.html), [chapter 6](https://worldofspectrum.org/ZXSpectrumIntroduction/chapter_six.html) and [BASIC manual, chapter 20](https://worldofspectrum.org/ZXBasicManual/zxmanchap20.html); timings are condensed, bands are horizontal and move upward, one BASIC program is loaded rather than unexplained successive CODE files |
| 386-class PC | Memory count rewrites one line from zero to 16 MiB, then a short POST cue precedes DOS startup | [GVC 386SX board manual](https://www.infania.net/misc/moboarchive/Systemax/Manuals/isa/gvc_386_sx.pdf) documents the power-on memory test; this is a generic period-compatible scene, not an exact AMI BIOS revision or diagnostic beep-code implementation |
| Amiga Guru | Left click acknowledges the displayed failure and enters the existing disk-boot sequence | The existing alert's instruction is now functional; keyboard activation and a two-second automatic continuation are wmux accessibility/convenience additions, not hardware behavior |
| NeXTSTEP | Separate vertically stacked main menu in the upper-left corner, with the dock on the right | [NeXTstep Concepts, December 1990, chapter 2, Main Menu / Placement](https://www.bitsavers.org/pdf/next/Release_1_Dec90/NEXTstep_Concepts_Dec90.pdf); menu labels and the wmux login scene are illustrative, not a functional Workspace Manager |

The Spectrum border phases retain the internal `header` and `data` names for compatibility.
`header` means a red/cyan pilot, including the pilot before the data block, not every byte of a tape header.
The CPC and Oric scenes no longer borrow this Spectrum-specific effect without evidence of a matching loader.
The CPC block number replaces its previous status line instead of building an invented scrolling transfer log.

## Audio policy

Do not assign a synthesized melody to every profile merely to distinguish them.
The sound table is deliberately sparse, with quiet approximate Apple IIe and generic PC beeps and a synthesized Amiga floppy-mechanism cue.
Apple's [IIe Owner's Manual](https://manualzilla.com/doc/7378887/apple-apple-ii-owner-s-manual) describes the startup beep, but the retained 1 kHz oscillator is not a byte-accurate reconstruction of the speaker routine.
The Amiga cue is a stylized mechanical sound, not a firmware startup chime.
Omitted audio means no verified reproduction is supplied, not that every corresponding computer was historically silent.
Browser autoplay rejection must remain silent rather than deferring a sound until a credential keystroke.

## Coverage and remaining approximations

The audit covers profile data, the actual terminal and graphical renderers, audio and asset provenance.
It does not certify every ROM banner, font or boot sequence as an exact reproduction.

| Profiles | Remaining fidelity boundary |
| --- | --- |
| C64, C128 | Fictional disk listings; synthesized RGB palettes approximate analogue output |
| Apple IIe | DOS 3.3-themed disk contents; ROM revision and enhanced/unenhanced banner differences need a selected hardware baseline |
| 386 PC | Generic BIOS/DOS composition; no vendor-exact logo, copyright, memory-test cadence or device detection |
| BBC Micro | Teletext face and grid are selected, but control-code attributes and hardware cursor shape are not emulated |
| Spectrum | No K/L cursor-state emulation, tape waveform decoding or SCREEN$ loading graphic; reduced motion skips artificial waits |
| Atari ST | Existing licensed TOS 1.04 screenshot followed by a simplified GEM-style desktop; the text profile is not executed by the graphical renderer |
| Amiga Workbench, Amiga Guru | Retained insert-disk image and stylized shell chrome; no model-specific diagnostic color sequence or ROM execution |
| Acorn Archimedes, Apple Lisa | Simplified graphical desktops; exact ROM self-test graphics and model-specific disk startup remain unimplemented |
| SGI IRIX, NeXTcube, OS/2 Warp | Existing logos and simplified graphical shells; hardware-specific startup animation and sound remain unverified |
| TRS-80 Model 4, Osborne 1, Sinclair QL | Interpreter/OS-themed text rather than traced machine boot output |
| Amstrad CPC, Oric Atmos, MSX2 | Loader/status placement, machine-specific logo animation and ROM display details need further reference captures |
| VAX/VMS, Sun SPARCstation, PDP-11/RT-11, IBM 3270/MVS | Console/session fiction; terminal model, firmware version and host configuration affect actual startup |
| TI-99/4A, TRS-80 CoCo, Amstrad PCW | Native-language themes; ROM menus, media bootstrap and several font choices remain approximate |
| Sharp X68000, NEC PC-9801, Enterprise 128 | OS-themed text; no complete hardware graphics, diagnostic or sound reproduction |
| Commodore PET, VIC-20, SAM Coupe, Memotech MTX, Tatung Einstein, Atari 800XL | Interpreter-themed scenes; variant-specific banners, screen aspect and fonts require separate baselines |

Graphical profiles use `RetroGraphicalBootScreen`, not the `boot` text steps in the profile table.
Changing those text steps alone cannot improve the visible graphical boot.
Prefer small, verified improvements over adding plausible-looking but undocumented firmware output.

## Artwork and verification

Reuse the existing assets and preserve [font/screenshot provenance](../src/client/src/assets/retro/UPSTREAM.md), [logo provenance](../src/client/src/assets/retro/logos/UPSTREAM.md) and [third-party notices](../THIRD_PARTY_NOTICES.md).
No additional historical screenshots, ROMs, recordings or vendor artwork were imported for this fidelity pass.
The retained Workbench insert-disk screenshot still has no identified source-redistribution license and remains outside MIT.
Do not use its presence as permission to add more unlicensed screenshots.

Structured boot steps keep positioning, inverse video and in-place updates separate from text so line-width guards remain meaningful.
Keep all positions inside the profile's declared grid and make animation completion independent of real bootstrap/authentication completion.
The Guru interaction must never dismiss a required authentication gate.
Service polling retains its bounded interval even under reduced motion.

Run focused `test/retro-boot-*.test.ts` checks during editing and use [external verification](VERIFICATION.md) for full checks.
The `canvas-chrome.spec.ts` browser tests capture Spectrum desktop/mobile borders, PC POST, BBC teletext, NeXT menu placement and Guru recovery.
Inspect these images when changing geometry or artwork; passing text assertions alone cannot establish visual fidelity.
