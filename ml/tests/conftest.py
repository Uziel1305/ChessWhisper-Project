import sys
from pathlib import Path

# The pipeline modules sit beside each other in ml/scripts and are imported by
# name. This puts that directory on the path for the tests without turning it
# into a package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))