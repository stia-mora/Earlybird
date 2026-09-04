"""Project entry point for the pinned gzh-design validator."""
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).resolve().parents[1] / "vendor" / "references" / "gzh-design" / "scripts" / "validate_gzh_html.py"), run_name="__main__")
