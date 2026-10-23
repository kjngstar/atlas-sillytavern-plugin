"""Offline artwork preparation/QA. Pillow decodes pixels; Atlas validates the ZIP."""
import argparse
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import warnings

from PIL import Image, ImageOps, ImageStat

Image.MAX_IMAGE_PIXELS = 8388608
warnings.simplefilter("error", Image.DecompressionBombWarning)


def decode(path):
    with Image.open(path) as image:
        if image.format not in ("PNG", "WEBP") or getattr(image, "n_frames", 1) != 1:
            raise ValueError("ARTWORK_STATIC_PNG_WEBP_REQUIRED: " + str(path))
        if max(image.size) > 2048:
            raise ValueError("ARTWORK_DIMENSION_LIMIT: " + str(path))
        image.load()  # Do not accept a valid header with corrupt/truncated pixels.
        return image.convert("RGBA"), image.format


def audit(directory):
    base = Path(directory).resolve()
    manifest = json.loads((base / "manifest.json").read_text())
    roles = manifest["theme"].get("assets", {})
    if roles.get("avatarFrame") and roles.get("avatarFrame") == roles.get("windowFrame"):
        raise ValueError("ARTWORK_AVATAR_NEEDS_OWN_FRAME")
    images, pixels = [], 0
    for asset in manifest["assets"]:
        path = (base / asset["path"]).resolve()
        if not path.is_relative_to(base):
            raise ValueError("ARTWORK_PATH_OUTSIDE_SKIN")
        data = path.read_bytes()
        image, fmt = decode(BytesIO(data))
        if asset["mime"] != {"PNG": "image/png", "WEBP": "image/webp"}[fmt]:
            raise ValueError("ARTWORK_MIME_MISMATCH: " + asset["id"])
        width, height = image.size
        pixels += width * height
        assigned = [role for role, ident in roles.items() if ident == asset["id"]]
        if "avatarFrame" in assigned:
            if width != height:
                raise ValueError("ARTWORK_AVATAR_NOT_SQUARE")
            center = image.getchannel("A").crop((width * 4 // 10, height * 4 // 10, width * 6 // 10, height * 6 // 10))
            if not center.width or not center.height or ImageStat.Stat(center).mean[0] > 16:
                raise ValueError("ARTWORK_AVATAR_CENTER_NOT_CLEAR")
        images.append({"id": asset["id"], "width": width, "height": height, "roles": assigned, "sha256": sha256(data).hexdigest()})
    if pixels > 8388608:
        raise ValueError("ARTWORK_PIXEL_BUDGET")
    return {"ok": True, "pixels": pixels, "images": images}


def prepare(source, output, size, crop=None, mode="contain"):
    image, _ = decode(source)
    image = ImageOps.exif_transpose(image)
    if crop:
        x, y, width, height = crop
        if min(x, y) < 0 or min(width, height) <= 0 or x + width > image.width or y + height > image.height:
            raise ValueError("ARTWORK_CROP_OUTSIDE_IMAGE")
        image = image.crop((x, y, x + width, y + height))
    if min(size) <= 0 or max(size) > 2048:
        raise ValueError("ARTWORK_OUTPUT_SIZE_INVALID")
    # Aspect ratio is always preserved. Cover explicitly opts into edge cropping.
    operation = ImageOps.contain if mode == "contain" else ImageOps.fit
    image = operation(image, tuple(size), method=Image.Resampling.LANCZOS)
    target = Path(output).resolve()
    if target == Path(source).resolve():
        raise ValueError("ARTWORK_SOURCE_MUST_BE_PRESERVED")
    fmt = {".png": "PNG", ".webp": "WEBP"}.get(target.suffix.lower())
    if not fmt:
        raise ValueError("ARTWORK_OUTPUT_FORMAT_INVALID")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, suffix=target.suffix)
    os.close(fd)
    try:
        image.save(tmp, format=fmt, **({"lossless": True} if fmt == "WEBP" else {"optimize": True}))
        decode(tmp)
        os.replace(tmp, target)
    finally:
        Path(tmp).unlink(missing_ok=True)
    return {"ok": True, "output": str(target), "size": list(image.size), "mode": mode}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("audit")
    check.add_argument("directory")
    resize = sub.add_parser("prepare")
    resize.add_argument("source")
    resize.add_argument("output")
    resize.add_argument("--size", type=int, nargs=2, required=True)
    resize.add_argument("--crop", type=int, nargs=4, metavar=("X", "Y", "W", "H"))
    resize.add_argument("--mode", choices=("contain", "cover"), default="contain")
    args = parser.parse_args()
    result = audit(args.directory) if args.command == "audit" else prepare(args.source, args.output, args.size, args.crop, args.mode)
    print(json.dumps(result, ensure_ascii=False))
