# Reference WhisperX remote STT worker (issue #62) — CUDA/NVIDIA hosts only.
# Version matrix (see README before bumping any of these — WhisperX/torch
# installs are fragile if versions drift):
#   base image  nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
#   python      3.11
#   torch       2.4.1 (cu124 wheels)
#   whisperx    3.3.1
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN python3.11 -m pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cu124 \
        -r requirements.txt

COPY app.py config.py whisperx_backend.py ./

ENV WORKER_BIND_HOST=0.0.0.0
ENV WORKER_PORT=8000

EXPOSE 8000

CMD ["sh", "-c", "python3.11 -m uvicorn app:app --host ${WORKER_BIND_HOST} --port ${WORKER_PORT}"]
