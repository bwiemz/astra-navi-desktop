#!/usr/bin/env bash
# Downloads PP-OCRv4 ONNX text detection + recognition models and English/multilingual
# character dictionary for FastOcr (`src/core/ocr.ts`), cutting window OCR latency below ~300 ms.
set -euo pipefail

data_dir="${AI_CHAN_DATA_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/ai-chan}"
ocr_dir="${data_dir}/models/ocr"
mkdir -p -m 700 "${ocr_dir}"

if ! command -v curl >/dev/null 2>&1; then
  echo "This needs 'curl' installed to download the ONNX OCR models." >&2
  exit 1
fi

DET_URL="${AI_CHAN_OCR_DET_URL:-https://huggingface.co/monkt/paddleocr-onnx/resolve/main/detection/v4/det.onnx}"
REC_URL="${AI_CHAN_OCR_REC_URL:-https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/rec.onnx}"
DICT_URL="${AI_CHAN_OCR_DICT_URL:-https://huggingface.co/monkt/paddleocr-onnx/resolve/main/languages/english/dict.txt}"

echo "Installing PP-OCRv4 ONNX models into ${ocr_dir} ..."
curl -fsSL -o "${ocr_dir}/det.onnx.tmp" "${DET_URL}"
mv -f "${ocr_dir}/det.onnx.tmp" "${ocr_dir}/det.onnx"

curl -fsSL -o "${ocr_dir}/rec.onnx.tmp" "${REC_URL}"
mv -f "${ocr_dir}/rec.onnx.tmp" "${ocr_dir}/rec.onnx"

curl -fsSL -o "${ocr_dir}/dict.txt.tmp" "${DICT_URL}"
mv -f "${ocr_dir}/dict.txt.tmp" "${ocr_dir}/dict.txt"

chmod 600 "${ocr_dir}/det.onnx" "${ocr_dir}/rec.onnx" "${ocr_dir}/dict.txt"
echo "Done. OCR models installed in ${ocr_dir}."
