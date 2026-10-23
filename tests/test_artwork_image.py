"""Run with: python -m unittest discover -s tests -p test_artwork_image.py"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("artwork", ROOT / "tools/artwork-image.py")
artwork = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artwork)


class ArtworkTest(unittest.TestCase):
    def test_shipped_skins_decode(self):
        for name in ("qingkong-xinjian", "shanhezhi"):
            self.assertTrue(artwork.audit(ROOT / "skins" / name)["ok"])

    def test_contain_preserves_shape_alpha_and_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.png", Path(directory) / "target.webp"
            Image.new("RGBA", (160, 80), (12, 34, 56, 128)).save(source)
            original = source.read_bytes()
            self.assertEqual(artwork.prepare(source, target, (40, 40))["size"], [40, 20])
            self.assertEqual(Image.open(target).convert("RGBA").getpixel((20, 10))[3], 128)
            self.assertEqual(source.read_bytes(), original)
            with self.assertRaisesRegex(ValueError, "SOURCE_MUST_BE_PRESERVED"):
                artwork.prepare(source, source, (40, 40))

    def test_bad_crop_does_not_replace_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source.png", Path(directory) / "target.png"
            Image.new("RGBA", (16, 16)).save(source)
            target.write_bytes(b"previous")
            with self.assertRaisesRegex(ValueError, "CROP_OUTSIDE"):
                artwork.prepare(source, target, (8, 8), (12, 0, 8, 8))
            self.assertEqual(target.read_bytes(), b"previous")

    def test_opaque_avatar_and_corrupt_image_fail_before_zip_replacement(self):
        for corrupt in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                (base / "assets").mkdir()
                path = base / "assets/frame.png"
                Image.new("RGBA", (32, 32), "white").save(path)
                if corrupt:
                    path.write_bytes(path.read_bytes()[:40])  # Valid IHDR, missing image data.
                manifest = {"id": "user.audit-test", "name": "Audit", "assets": [{"id": "frame", "path": "assets/frame.png", "mime": "image/png"}], "theme": {"kind": "atlas-ui-theme", "schemaVersion": 1, "id": "user.audit-test", "baseTheme": "builtin.starmap", "assets": {"avatarFrame": "frame"}}}
                (base / "manifest.json").write_text(json.dumps(manifest))
                output = base / "skin.zip"
                output.write_bytes(b"previous")
                result = subprocess.run(["node", "--input-type=module", "-e", "import {buildArtworkSkin} from './tools/build-artwork-skin.mjs';await buildArtworkSkin({directory:process.argv[1],output:process.argv[2]});", str(base), str(output)], cwd=ROOT, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output.read_bytes(), b"previous")


if __name__ == "__main__":
    unittest.main()
