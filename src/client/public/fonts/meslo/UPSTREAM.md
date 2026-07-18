# MesloLGM Nerd Font Mono

The four WOFF2 files in this directory are browser-format conversions of the
MesloLGM Nerd Font Mono faces from the official Nerd Fonts v3.4.0 `Meslo`
release:

https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0

The source archive was downloaded from:

https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/Meslo.tar.xz

Its SHA-256, verified against the release's official `SHA-256.txt`, is:

```text
a57936d96aefb5cfff0660f3294210ee04705529af6cf811e2274b0923a03939  Meslo.tar.xz
```

wmux uses the `Nerd Font Mono` variant because terminals require predictable
single-cell glyph metrics. It exposes these files to browser CSS as
`"MesloLGM Nerd Font"`:

- `MesloLGMNerdFontMono-Regular.ttf` ->
  `meslo-lgm-nerd-font-mono-regular.woff2`
- `MesloLGMNerdFontMono-Bold.ttf` ->
  `meslo-lgm-nerd-font-mono-bold.woff2`
- `MesloLGMNerdFontMono-Italic.ttf` ->
  `meslo-lgm-nerd-font-mono-italic.woff2`
- `MesloLGMNerdFontMono-BoldItalic.ttf` ->
  `meslo-lgm-nerd-font-mono-bold-italic.woff2`

The TTF files were converted with `wawoff2` 2.0.1. The conversion changes only
the web delivery format: the fonts were not subset, and their glyphs, names,
and metadata were not intentionally modified.

The generated WOFF2 SHA-256 checksums are:

```text
045dcd79618036d7fe0d6d6f7f6f47653587b95457861eeecc3f881c2ab4e191  meslo-lgm-nerd-font-mono-regular.woff2
2a2fbba166fbe1deb9fceb533a9a552e69891b13ca8afbe178b6e46e006ba3c8  meslo-lgm-nerd-font-mono-bold.woff2
f2739a48d30d9d8186ee39c2603b8267b950df75b4de12657ff04b85ffcd9e98  meslo-lgm-nerd-font-mono-italic.woff2
5ecf12ebbca1be544fa04a046bfdc137f66a1169a46d2be44e12ef5b6679880a  meslo-lgm-nerd-font-mono-bold-italic.woff2
```

## License and attribution

Meslo LG is a customized version of Apple's Menlo-Regular, itself customized
from Bitstream Vera Sans Mono. The Nerd Fonts release uses a patched Meslo
version by opeik and identifies Meslo LG as copyright 2009, 2010, 2013 André
Berg under the Apache License 2.0.

The release-provided notice is preserved in `LICENSE.txt`, and the complete
Apache License 2.0 is preserved in `LICENSE-APACHE-2.0.txt`. Nerd Fonts project
licensing and attribution are preserved in `NERD-FONTS-LICENSE.txt`.

Upstream projects:

- https://github.com/ryanoasis/nerd-fonts
- https://github.com/andreberg/Meslo-Font
- https://github.com/opeik/Meslo-Font
