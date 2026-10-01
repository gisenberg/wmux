# Retro boot fidelity

The boot gallery is a collection of historically informed wmux loading and authentication scenes, not a ROM emulator.
Hardware identity, command vocabulary, display geometry and recognizable interactions should agree with the selected machine.
WMUX programs, disk contents, network drivers and authentication dialogs are fictional application content.
They must not be described as original firmware output.

## Grounded behavior

| Scene | Behavior reproduced | Reference and limits |
| --- | --- | --- |
| Commodore 64 / 1541 | BASIC V2 banner, matching light-blue text and border, reverse-video directory heading, first program named WMUX, 624 blocks remaining after the four listed files allocate 40 blocks | [Commodore 64 setup guide](https://www.commodore.ca/manuals/c64_users_guide/c64-users_guide-01-setup.pdf) and [Commodore drive capacity comparison](https://www.commodore.ca/manuals/commodore_1541_4040_8050_8250_comparison-old.htm) establish the banner and 664-block usable disk capacity; the disk is invented |
| Commodore 128 | Native BASIC 7 flow, with `DIRECTORY` in the 1541 listing layout and `DLOAD` searching for `0:WMUX` | [Commodore 128 System Guide, section 2](https://www.commodore.ca/manuals/128_system_guide/sect-02.htm) and the [Commodore ROM sources](https://github.com/mist64/cbmsrc) (`BASIC_C128_04/dos1.src`, `KERNAL_C128_06/load.src`); directory contents remain illustrative |
| VIC-20, PET 2001 | Power-on banners with their ROM blank lines, `SEARCHING FOR` naming the file after a blank line, and the original PET's white phosphor | [VIC-20 ROM disassembly](https://gist.github.com/cbmeeks/65c0f2acc1f0ad041c236637732aac8c) and [PET BASIC 1 source](https://github.com/mist64/cbmsrc); later green-phosphor PETs are not represented |
| Apple IIe | Unenhanced `Apple ][` banner at column 15, then the January 1, 1983 DOS 3.3 System Master HELLO layout, including the inverse CAPS LOCK reminder | [Unenhanced IIe F8 ROM](https://6502disassembly.com/a2-rom/Unenh_IIe_F8ROM.html) and [System Master images](https://github.com/cmosher01/Apple-II-System-Masters); the catalogue entries are invented |
| BBC Micro DFS | `*CAT` title and cycle line, alphabetical seven-character names in columns 4 and 23, and no blank line before the prompt | [DFS 1.20 ROM](https://mdfs.net/System/ROMs/Filing/DNFS/DNFS300) and [MMFS source](https://github.com/hoglet67/MMFS) |
| Amstrad CPC 464 | ROM sign-on starting with a blank row, `Press PLAY then any key:` and an in-place block number | [CPC 464 OS ROM](https://github.com/ColinPitrat/caprice32/tree/master/rom); timings are condensed |
| MSX2 | MSX BASIC 2.0 and Disk BASIC 1.0 sign-on, 23430 bytes free as on the Sharp HB-3600 interface, 8.3 `FILES` entries and `RUN` of a BASIC file | [MSX system ROM sources](https://github.com/apoloval/msx-system); bytes free varies by disk interface |
| Oric Atmos | ROM 1.1 sign-on after the two attribute cells, `CAPS` status, and `CLOAD` progress on the status line | [Oric Atmos ROM 1.1 listing](https://iss.sandacite.com/tools/oric-atmos-rom.html) |
| Sinclair QL | Unechoed `F1...monitor` / `F2...TV` choice with the JM ROM copyright, then a cleared SuperBASIC screen | [JM ROM disassembly](https://archive.org/download/SinclairQLHomepage/docs/disassem/jmrom.zip); window colours and borders are not drawn |
| TI-99/4A | Master title screen, then the unechoed `PRESS` selection list with double-spaced entries | [TI-99/4A Intern GROM listing](https://archive.org/details/tibook_ti994a-intern); the WMUX cartridge entry is invented |
| TRS-80 Color Computer | Extended Color BASIC 1.1 banner and the `S` / `F WMUX` cassette search cell after `CLOADM` clears the screen | [Extended](https://colorcomputerarchive.com/repo/Documents/Books/Unravelled%20Series/extended-basic-unravelled.pdf) and [Color BASIC Unravelled](https://colorcomputerarchive.com/repo/Documents/Books/Unravelled%20Series/color-basic-unravelled.pdf); per-block inverse flicker is not animated |
| Amstrad PCW 8256 | Textless boot ROM followed by the CP/M Plus 1.4 sign-on | [PCW8256/8512 User Manual](https://archive.org/details/pcw-8256-8512-user-manual-engacme); the loading stripe pattern is not drawn |
| VAX/VMS | V5.5-2 version, `%STDRV`, `%SET` and `%MOUNT` startup lines, and `User authorization failure` | [V5.5-2 console logs](http://hb1bbs.com/VAX/VMS-on-a-Raspberry-Pi/); the site announcement and WMUX message are invented |
| Sun SPARCstation 2 | OpenBoot 2.x banner, full boot device path, SunOS 4.1.4 GENERIC kernel and copyright, and the SunOS 4 `host login:` prompt | [SunOS 4.1.4 sun4c transcript](https://github.com/halfmanhalftaco/sunboot); the banner format is confirmed from other OpenBoot 2.x machines |
| PDP-11 RT-11 | `RT-11SJ  V05.03` banner and the `DIR` date header, two-column size and date entries, and totals | [RT-11 V5 SIMH session](https://www.5volts.ch/pages/dcj11sbc/200-dcj11-rt11/) and the RT-11 Commands Manual; RT-11 has no login, so authentication is invented |
| IBM 3270 MVS | VTAM logon to the TSO/E LOGON panel with `Userid ===>` and `Password ===>` fields, and IKJ56421I and IKJ56455I messages | [TSO/E logon panel listing](https://bit.listserv.ibm-main.narkive.com/5UM4Tvu8/tso-e-logon-panel); the USS welcome text is invented and the RACF fields are omitted |
| BBC Micro | Default MODE 7 character grid, 40 columns by 25 rows, using the bundled SAA5050-style face | [BBC BASIC implementer's MODE 7 reference](https://www.bbcbasic.uk/bbcwin/manual/bbcwinh.html); the retained 320:256 presentation aspect is not a claim that teletext is a 320-pixel bitmap mode |
| ZX Spectrum 48K | Copyright in the lower editor area, cleared on command entry; LOAD arrives as a keyword; red/cyan pilots, short header data, a quiet gap with program name, second pilot and blue/yellow program data | [Sinclair Introduction, chapter 1](https://worldofspectrum.org/ZXSpectrumIntroduction/chapter_one.html), [chapter 6](https://worldofspectrum.org/ZXSpectrumIntroduction/chapter_six.html) and [BASIC manual, chapter 20](https://worldofspectrum.org/ZXBasicManual/zxmanchap20.html); timings are condensed, bands are horizontal and move upward, one BASIC program is loaded rather than unexplained successive CODE files |
| 386-class PC | Memory count rewrites one line from zero to 16 MiB, then a short POST cue precedes DOS startup | [GVC 386SX board manual](https://www.infania.net/misc/moboarchive/Systemax/Manuals/isa/gvc_386_sx.pdf) documents the power-on memory test; this is a generic period-compatible scene, not an exact AMI BIOS revision or diagnostic beep-code implementation |
| Amiga Guru | Exec's 40-line alert across the top of a 640x200 screen, with the failure, button prompt and meditation number at their exec positions and a blinking red frame; left click acknowledges it and enters the disk-boot sequence | [Exec disassembly](https://wandel.ca/homepage/execdis/exec_disassembly.txt); keyboard activation and a two-second automatic continuation are wmux accessibility/convenience additions, not hardware behavior |
| Amiga power-on | Dark grey, then medium grey, before the insert-disk hand | [Exec disassembly](https://wandel.ca/homepage/execdis/exec_disassembly.txt) colours $0444 and $0888; timings are condensed |
| MSX2 title | The MSX logo scrolls up on V9938 blue before `VRAM:128Kbytes` appears, then MSX BASIC uses colour 4 | [MSX2 boot screens](http://www.geocities.ws/marmsx/boot/english.html) and [openMSX discussion of the two blues](https://www.msx.org/forum/msx-talk/openmsx/openmsx-msx2-color-hue-shift-default-blue-background); the free-RAM line some models print is omitted |
| Acorn Archimedes | Purple, blue, purple and green POST phases, the black `RISC OS 2048K` banner, the RISC OS 3 initialising box, then the flat grey backdrop with the icon bar and a NetFS-style Logon window with a cream input-focus title bar | [Application Note 225](https://www.retro-kit.co.uk/user/custom/Acorn/32bit/documentation/RISCOS-POST-AppNote225.pdf), the RISC OS Open Kernel and Wimp palette sources, and the [RISC OS 3 user guide's network logon](http://www.riscos.com/support/users/userguide3/book1b/c_4.html); POST colour values and the startup box layout are approximate |
| Atari ST | White screen and busy bee, then the TOS 1.04 low-resolution desktop: solid green, `Desk File View Options`, two `FLOPPY DISK` icons at the top left and `TRASH` at the bottom left, with a GEM dialog whose fields underline their template characters | [Reconstructed TOS 1.x source](https://github.com/th-otto/tos1x) default palette, desktop fill and built-in DESKTOP.INF; the bee and icon artwork are drawn approximations |
| Apple Lisa | ROM self-test with `H/88`, the TESTING box and its four checked icons, the Office System 3.1 Wait splash, then the 50% desktop pattern, the `Desk File/Print Edit Housekeeping` menu and the default bottom-row icons | [Lisa Boot ROM listing](https://www.apple.asimov.net/documentation/applelisa/AppleLisa-BootROMListing.pdf) and [toastytech Lisa captures](http://toastytech.com/guis/lisa.html); icon artwork is simplified and the LisaTerminal login is invented |
| SGI Indigo2 | PROM gradient with `WELCOME TO INDIGO²` and the yellow `Silicon Graphics Computer Systems` line, the diagnostics, start-up and coming-up notifiers, then a clogin window with the user icon pane, name-first entry and `IRIS` host label | [Indigo2 IMPACT Owner's Guide](http://www.sgistuff.net/hardware/systems/documents/007-2849-004-indigo2impact.pdf), [reverse-engineered PROM artwork](https://github.com/tyfighter/sgibootscreen) and [clogin(1)](https://help.graphica.com.au/irix-6.5.30/man/1/clogin); the clogin root blue and the wordmark typeface are approximate |
| NeXTcube | ROM panel on dark grey with the white cube and `Testing system ...` then `Loading from disk ...`, the NEXTSTEP initializing panel, then loginwindow without the Workspace menu or dock, which appear only after login | [NeXT ROM source](https://github.com/johnsonjh/NeXTROM); a default 3.3 install logs in automatically, so showing loginwindow is a wmux authentication requirement |
| OS/2 Warp 3 | Corner box, then the bevelled white logo box over the Version 3 copyright, then the dark cyan Workplace Shell with its default folders, LaunchPad and a LAN Logon dialog | [toastytech OS/2 Warp 3 gallery](http://toastytech.com/guis/os23.html) and [Redbook GG24-4505](http://ps-2.kev009.com/basil.holloway/ALL%20PDF/gg244505.pdf); icon and LaunchPad artwork are simplified |

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
| Apple IIe | Unenhanced ROM baseline; DOS 3.3 catalogue contents are invented |
| 386 PC | Generic BIOS/DOS composition; no vendor-exact logo, copyright, memory-test cadence or device detection |
| BBC Micro | Teletext face and grid are selected, but control-code attributes and hardware cursor shape are not emulated |
| Spectrum | No K/L cursor-state emulation, tape waveform decoding or SCREEN$ loading graphic; reduced motion skips artificial waits |
| Atari ST, Acorn Archimedes, Apple Lisa, SGI IRIX, NeXTcube, OS/2 Warp | Startup and desktop layouts are traced at native resolution, but icons, bitmaps and proportional fonts are drawn approximations and startup sounds are not reproduced |
| Amiga Workbench, Amiga Guru | Retained insert-disk image and stylized shell chrome; the AmigaShell is opened for authentication although Workbench 1.3 closes its boot CLI |
| TRS-80 Model 4, Osborne 1 | Interpreter/OS-themed text rather than traced machine boot output |
| Sinclair QL | Copyright and display-choice text are traced, but the QL windows, colours and font are not reproduced |
| Amstrad CPC, Oric Atmos, MSX2 | Sign-on text is traced; machine-specific logo animation, palettes and loader timing remain approximate |
| VAX/VMS, Sun SPARCstation, PDP-11/RT-11, IBM 3270/MVS | Message formats are traced; host names, devices, disk contents and the authentication exchange are fiction |
| TI-99/4A, TRS-80 CoCo, Amstrad PCW | ROM text and menus are traced; title-screen colour bars, media bootstrap graphics and several font choices remain approximate |
| Sharp X68000, NEC PC-9801, Enterprise 128 | OS-themed text; no complete hardware graphics, diagnostic or sound reproduction |
| Commodore PET, VIC-20 | Banners are traced; screen aspect and fonts remain approximate |
| SAM Coupe, Memotech MTX, Tatung Einstein, Atari 800XL | Interpreter-themed scenes; variant-specific banners, screen aspect and fonts require separate baselines |

Graphical profiles use `RetroGraphicalBootScreen`, not the `boot` text steps in the profile table.
Changing those text steps alone cannot improve the visible graphical boot.
Their scenes, startup timelines and login dialogs live in `RetroGraphicalDesktop.tsx` and `retro-graphical-desktop.css`, which werdr copies unchanged.
Each scene is laid out in the machine's native pixels and scaled to the displayed picture.

Displayed shape and pixel grid are separate.
`displayAspect` records the picture's shape when pixels are not square, as for 80-column text, RISC OS 640x256 modes and the Amiga, Lisa, PC-98 and X68000 displays.
Terminal and raster canvases stretch to that shape, as the monitor did, rather than letterboxing.
Prefer small, verified improvements over adding plausible-looking but undocumented firmware output.

## Artwork and verification

Reuse the existing assets and preserve [font/screenshot provenance](../src/client/src/assets/retro/UPSTREAM.md), [logo provenance](../src/client/src/assets/retro/logos/UPSTREAM.md) and [third-party notices](../THIRD_PARTY_NOTICES.md).
No historical screenshots, ROMs, recordings or vendor artwork were imported for the graphical scenes; they are drawn in HTML and CSS from the cited descriptions.
The TOS 1.04 screenshot was removed because it showed the localized Desktop Info dialog rather than startup, and the lowercase SGI logo was removed because it postdates the Indigo2 era.
The retained Workbench insert-disk screenshot still has no identified source-redistribution license and remains outside MIT.
Do not use its presence as permission to add more unlicensed screenshots.

Several faces draw a machine glyph in the copyright or pound slot: Amstrad CPC, Tatung Einstein and SAA 5050 for the copyright sign, and IBM CGA, Lisa Console and Memotech MTX for both.
Their font faces exclude those characters with `unicode-range`, and the profiles and scenes that print them fall back to the Spectrum face.

Structured boot steps keep positioning, inverse video and in-place updates separate from text so line-width guards remain meaningful.
Keep all positions inside the profile's declared grid and make animation completion independent of real bootstrap/authentication completion.
The Guru interaction must never dismiss a required authentication gate.
Service polling retains its bounded interval even under reduced motion.

Run focused `test/retro-boot-*.test.ts` checks during editing and use [external verification](VERIFICATION.md) for full checks.
The `canvas-chrome.spec.ts` browser tests capture Spectrum desktop/mobile borders, PC POST, C64 inverse video, BBC teletext, the NeXT loginwindow and Guru recovery.
Werdr's `web/test/profiles.spec.ts` steps a fixed clock through every graphical startup scene and saves a screenshot of each.
Inspect these images when changing geometry or artwork; passing text assertions alone cannot establish visual fidelity.
