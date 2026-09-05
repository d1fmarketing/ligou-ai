#!/usr/bin/env python3
"""Create lighter derivatives while preserving the original Ligou media and fonts.

Requirements already available on the development machine:
  cwebp, ffmpeg, Python Pillow, fontTools and Brotli.
Run from any directory: python3 scripts/optimize-media.py
"""

from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess

from PIL import Image
from fontTools import subset
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
OPTIMIZED = ASSETS / "optimized"
FONT_CSS = ROOT / "_ds/ligou-design-system-a33905fc-3bee-481b-b797-48c2b57eab4c/tokens/fonts.css"
IMAGES = (
    "hero-poster.png",
    "hero-poster-mobile.png",
    "hero-poster-tablet-portrait-1080x1440.png",
    "hero-poster-tablet-landscape-1440x1080.png",
    "hero-poster-ultrawide-3440x1476.webp",
    "agent-ligou.png",
)
UNICODE_RANGES = (
    (0x0020, 0x024F),  # Basic Latin, Latin-1 and Latin Extended A/B.
    (0x0300, 0x036F),  # Combining accents, including decomposed PT/ES text.
    (0x1E00, 0x1EFF),  # Latin Extended Additional.
    (0x2000, 0x206F),  # Typography and punctuation.
    (0x20A0, 0x20CF),  # Currency symbols.
    (0x2190, 0x21FF),  # Arrows used by the interface.
    (0x25A0, 0x25FF),  # Geometric symbols when supplied by the original font.
)
UNICODES = {point for start, end in UNICODE_RANGES for point in range(start, end + 1)} | {0x2212}
LANGUAGE_SAMPLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ¿¡€$£¢"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative(path):
    return path.relative_to(ROOT).as_posix()


def image_derivative(name):
    source = ASSETS / name
    output = OPTIMIZED / (source.stem + ".webp")
    source_hash = digest(source)
    with Image.open(source) as original:
        original.load()
        dimensions = original.size
    if source.suffix == ".webp":
        # The ultrawide poster is already only 157 KB: avoid another lossy pass.
        shutil.copyfile(source, output)
        method = "WebP existente, cópia idêntica"
        ssim = 1.0
    else:
        subprocess.run(
            ["cwebp", "-quiet", "-q", "92", "-m", "6", "-sharp_yuv", "-metadata", "icc", str(source), "-o", str(output)],
            check=True,
        )
        method = "WebP q92, sharp_yuv, mesmas dimensões"
        metric = subprocess.run(
            ["ffmpeg", "-hide_banner", "-i", str(source), "-i", str(output),
             "-lavfi", "[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim",
             "-f", "null", "-"],
            check=True, text=True, capture_output=True,
        )
        ssim = float(re.search(r"All:([0-9.]+)", metric.stderr).group(1))
    with Image.open(output) as result:
        result.load()
        assert result.format == "WEBP"
        assert result.size == dimensions, (source.name, dimensions, result.size)
    assert source_hash == digest(source), "Original media must not be changed"
    assert output.stat().st_size <= source.stat().st_size
    return {
        "source": relative(source), "output": relative(output),
        "before_bytes": source.stat().st_size, "after_bytes": output.stat().st_size,
        "width": dimensions[0], "height": dimensions[1],
        "method": method, "ssim_yuv444": ssim, "source_sha256": source_hash,
    }


def font_derivative(source):
    output = source.with_suffix(".woff2")
    original_hash = digest(source)
    original = TTFont(source, recalcTimestamp=False)
    original_map = original.getBestCmap()
    retained_points = sorted(set(original_map) & UNICODES)
    options = subset.Options()
    options.flavor = "woff2"
    options.recalc_timestamp = False
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.name_legacy = True
    font = TTFont(source, recalcTimestamp=False)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=retained_points)
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(output)
    restored = TTFont(output, recalcTimestamp=False)
    restored_map = restored.getBestCmap()
    assert set(restored_map) == set(retained_points)
    for char in LANGUAGE_SAMPLE:
        assert ord(char) in original_map, (source.name, "missing in original", char)
        assert ord(char) in restored_map, (source.name, "missing in subset", char)
    for table, attributes in {
        "head": ("unitsPerEm",),
        "hhea": ("ascent", "descent", "lineGap"),
        "OS/2": ("usWeightClass", "fsSelection", "sTypoAscender", "sTypoDescender", "sTypoLineGap"),
    }.items():
        for attribute in attributes:
            assert getattr(original[table], attribute) == getattr(restored[table], attribute)
    source_glyphs = original.getGlyphSet()
    result_glyphs = restored.getGlyphSet()
    for point in retained_points:
        source_name, result_name = original_map[point], restored_map[point]
        assert original["hmtx"][source_name] == restored["hmtx"][result_name]
        source_pen = DecomposingRecordingPen(source_glyphs)
        result_pen = DecomposingRecordingPen(result_glyphs)
        source_glyphs[source_name].draw(source_pen)
        result_glyphs[result_name].draw(result_pen)
        assert source_pen.value == result_pen.value, (source.name, hex(point), "outline changed")
    assert original_hash == digest(source)
    assert output.stat().st_size < source.stat().st_size
    return {
        "source": relative(source), "output": relative(output),
        "before_bytes": source.stat().st_size, "after_bytes": output.stat().st_size,
        "original_characters": len(original_map), "retained_characters": len(restored_map),
        "source_sha256": original_hash, "outlines_and_metrics_identical": True,
    }


def main():
    OPTIMIZED.mkdir(exist_ok=True)
    source_css = FONT_CSS.read_text()
    names = re.findall(r"assets/fonts/([^']+\.ttf)", source_css)
    videos = {relative(path): digest(path) for path in ASSETS.glob("hero-loop*.mp4")}
    image_rows = [image_derivative(name) for name in IMAGES]
    font_rows = [font_derivative(ASSETS / "fonts" / name) for name in names]
    optimized_css = source_css.replace("../../../assets/fonts/", "fonts/").replace(".ttf", ".woff2").replace("format('truetype')", "format('woff2')")
    (ASSETS / "fonts-optimized.css").write_text(optimized_css)
    assert videos == {relative(path): digest(path) for path in ASSETS.glob("hero-loop*.mp4")}
    output_dir = ROOT / "output"
    output_dir.mkdir(exist_ok=True)
    data = {"images": image_rows, "fonts": font_rows, "unchanged_videos": videos}
    (output_dir / "otimizacao.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    lines = ["# Otimização de mídia e fontes", "", "Originais preservados. Nenhum vídeo alterado. Derivados têm caminhos próprios.", "", "## Imagens", "", "| Original | Derivado | Dimensões | Antes (bytes) | Depois (bytes) | Redução | SSIM YUV444 |", "|---|---|---:|---:|---:|---:|---:|"]
    for row in image_rows:
        reduction = 100 * (1 - row["after_bytes"] / row["before_bytes"])
        lines.append(f'| `{row["source"]}` | `{row["output"]}` | {row["width"]}×{row["height"]} | {row["before_bytes"]:,} | {row["after_bytes"]:,} | {reduction:.1f}% | {row["ssim_yuv444"]:.6f} |')
    lines += ["", "Os PNGs foram codificados em WebP q92 com sharp_yuv, sem corte, redimensionamento ou regeneração. O ultrawide já tinha compressão eficiente e foi copiado byte a byte para evitar outra passagem com perdas. SSIM é uma medida estrutural; não equivale a um teste humano de percepção.", "", "## Fontes", "", "| Original | WOFF2 (mesmo nome-base) | Antes (bytes) | Depois (bytes) | Caracteres mantidos |", "|---|---|---:|---:|---:|"]
    for row in font_rows:
        lines.append(f'| `{row["source"]}` | `{row["output"]}` | {row["before_bytes"]:,} | {row["after_bytes"]:,} | {row["retained_characters"]}/{row["original_characters"]} |')
    lines += ["", "Subconjunto latino com acentos compostos e combinantes para PT/EN/ES, pontuação, moedas, setas e símbolos já existentes. Preservados família, estilo, peso, font-display:swap, nomes/licenças, recursos OpenType e métricas. Cada contorno e avanço horizontal dos caracteres mantidos foi comparado após reabrir o WOFF2. O teste inclui explicitamente caracteres acentuados, ñ, ¿ e ¡.", "", "## Integração", "", "- Trocar o link de `_ds/ligou-design-system-a33905fc-3bee-481b-b797-48c2b57eab4c/tokens/fonts.css` por `assets/fonts-optimized.css`; não carregar as duas folhas de faces simultaneamente.", "- Substituir apenas os caminhos dos posters e do personagem pelos derivados da tabela. Os cinco caminhos dos vídeos permanecem iguais.", "- O poster desktop é originalmente 1672×941, diferente das dimensões 1920×1080 do vídeo. Essa diferença foi preservada.", "- A integração HTML/JSX, o build e os manifestos ficam a cargo da tarefa principal.", "", "## Totais", ""]
    for label, rows in (("Imagens", image_rows), ("Fontes (14 faces)", font_rows)):
        before, after = sum(row["before_bytes"] for row in rows), sum(row["after_bytes"] for row in rows)
        lines.append(f"- {label}: {before:,} → {after:,} bytes; redução de {100 * (1 - after / before):.1f}%.")
    lines += ["", "Validação executada: decodificação dos derivados, igualdade de dimensões, comparação de outlines/métricas dos caracteres, acentos PT/EN/ES, hashes dos originais e dos cinco vídeos. Não foram executados navegador, testes frontend nem verificador do manifesto nesta subtarefa.", ""]
    (output_dir / "otimizacao.md").write_text("\n".join(lines))
    print(json.dumps({"images_bytes": [sum(row[key] for row in image_rows) for key in ("before_bytes", "after_bytes")], "fonts_bytes": [sum(row[key] for row in font_rows) for key in ("before_bytes", "after_bytes")], "report": relative(output_dir / "otimizacao.md")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
