"""Bounded PDF parsing. Temporary OCR images are deleted with their directory."""
from io import BytesIO
from pathlib import Path
import subprocess
import tempfile
from pypdf import PdfReader

def pdf_text(data):
    reader = PdfReader(BytesIO(data), strict=False)
    if reader.is_encrypted:
        raise ValueError('Encrypted PDF cannot be read')
    pages = [(p.extract_text() or '') for p in reader.pages[:30]]
    blank = [i for i, text in enumerate(pages) if len(text.strip()) < 30]
    if blank:
        import pymupdf
        with pymupdf.open(stream=data, filetype='pdf') as document, tempfile.TemporaryDirectory(prefix='vivara-pdf-') as folder:
            for i in blank[:5]:
                page = document[i]
                if page.rect.width > 2000 or page.rect.height > 2000:
                    continue
                image = Path(folder) / f'page-{i}.png'
                page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5)).save(str(image))
                output = subprocess.run(['tesseract', str(image), 'stdout', '--psm', '6'], capture_output=True, timeout=25, check=True)
                pages[i] = output.stdout.decode('utf-8', errors='replace')
    text = '\n'.join(pages)[:500_000]
    if not text.strip():
        raise ValueError('No readable text in PDF, including OCR')
    return text
