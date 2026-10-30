"""Tratamiento de texto local, independiente de proveedores o procesos."""

import re


def safe_text(text: str) -> str:
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}", "[credencial omitida]", text)
    text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9_.-]+", "Bearer [credencial omitida]", text)
    return re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[credencial omitida]", text)
