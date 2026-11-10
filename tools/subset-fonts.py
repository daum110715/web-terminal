"""Builds the two fallback fonts in client/fonts from their upstream files.

    pip install fonttools brotli
    python tools/subset-fonts.py JuliaMono-Regular.woff2 SymbolsNerdFontMono-Regular.ttf client/fonts

symbols.woff2  arrows, technical marks, shapes, dingbats and braille from
               JuliaMono, for the marks most code fonts leave out. Characters
               that terminals draw as wide colour emoji are left out, so those
               still reach the system emoji font.
nerd.woff2     the private-use icons of Symbols Nerd Font Mono.
"""
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

SYMBOL_BLOCKS = [
    (0x2070, 0x218F),  # super/subscripts, currency, letterlike, number forms
    (0x2190, 0x23FF),  # arrows, math operators, technical
    (0x2400, 0x243F),  # control pictures
    (0x2460, 0x24FF),  # enclosed alphanumerics
    (0x2500, 0x25FF),  # box drawing, blocks, geometric shapes
    (0x2600, 0x27BF),  # miscellaneous symbols, dingbats
    (0x27C0, 0x2BFF),  # more math, arrows, braille, shapes
    (0x1F780, 0x1F7FF),  # geometric shapes extended
    (0x1FB00, 0x1FBFF),  # symbols for legacy computing
]

# Emoji_Presentation=Yes inside those blocks: two cells wide and in colour.
WIDE_EMOJI = """
231A-231B 23E9-23EC 23F0 23F3 25FD-25FE 2614-2615 2648-2653 267F 2693 26A1
26AA-26AB 26BD-26BE 26C4-26C5 26CE 26D4 26EA 26F2-26F3 26F5 26FA 26FD 2705
270A-270B 2728 274C 274E 2753-2755 2757 2795-2797 27B0 27BF 2B1B-2B1C 2B50 2B55
"""

NERD_BLOCKS = [(0xE000, 0xF8FF), (0xF0000, 0xFFFFD)]


def expand(blocks):
    return {code for first, last in blocks for code in range(first, last + 1)}


def parse(ranges):
    out = set()
    for part in ranges.split():
        first, _, last = part.partition("-")
        out |= set(range(int(first, 16), int(last or first, 16) + 1))
    return out


def build(source, target, wanted):
    font = TTFont(source)
    present = sorted(wanted & set(font.getBestCmap()))
    options = subset.Options(flavor="woff2", layout_features=[], hinting=False, notdef_outline=True)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=present)
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(target)
    print(f"{target}: {len(present)} characters")


julia, nerd, out = sys.argv[1:4]
build(julia, f"{out}/symbols.woff2", expand(SYMBOL_BLOCKS) - parse(WIDE_EMOJI))
build(nerd, f"{out}/nerd.woff2", expand(NERD_BLOCKS))
