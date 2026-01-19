import os
from pathlib import Path

input_path = os.environ.get("BV_INPUT_INPUT_TXT", "hello.txt")
output_path = os.environ.get("BV_OUTPUT_UPPER", "upper.txt")

text = Path(input_path).read_text(encoding="utf-8")
Path(output_path).write_text(text.upper(), encoding="utf-8")
